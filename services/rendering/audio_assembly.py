"""Bounded chapter MP3 assembly. This is not loudness mastering or retailer QC.

imageio-ffmpeg is BSD-2-Clause; its separately executed FFmpeg binary has its
own license (``ffmpeg -L``). Retain runtime notices when distributing an image.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time

VERSION = "chapter-audio-1.0.0"
MAX_SEGMENTS = 250
MAX_SEGMENT_BYTES = 50 * 1024 * 1024
MAX_INPUT_BYTES = 100 * 1024 * 1024
MAX_OUTPUT_BYTES = 150 * 1024 * 1024
MAX_SECONDS = 2 * 60 * 60
TIMEOUT_SECONDS = 120
SAMPLE_RATE = 44100
PCM_BYTES_PER_SECOND = SAMPLE_RATE * 2  # Mono, signed 16-bit PCM.
# ponytail: one operation per process; use worker-level admission for more capacity.
_ASSEMBLY_LOCK = threading.Lock()


def ffmpeg_executable() -> str:
    try:
        import imageio_ffmpeg
        # The pinned wrapper's discovery runs an unbounded subprocess. Resolve
        # its bundled file directly; every actual process uses our deadline.
        from imageio_ffmpeg._definitions import FNAME_PER_PLATFORM, get_platform
        configured = os.getenv("IMAGEIO_FFMPEG_EXE")
        candidate = (Path(configured) if configured else
                     Path(imageio_ffmpeg.__file__).parent / "binaries" / FNAME_PER_PLATFORM.get(get_platform(), ""))
        if candidate.is_file():
            return str(candidate.resolve())
    except (ImportError, OSError, RuntimeError) as error:
        raise RuntimeError("Audio assembly runtime is unavailable.") from error
    raise RuntimeError("Audio assembly runtime is unavailable.")


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError("Audio assembly exceeded its time limit.")
    return remaining


def _validate_mp3(data: bytes, deadline: float) -> None:
    """Reject truncated frames before FFmpeg can silently conceal partial media.

    Standard-rate MPEG Layer III only; no free-format or trailing opaque data.
    Actual audio integrity is checked separately by FFmpeg's strict decoder.
    """
    offset, end = 0, len(data)
    if data.startswith(b"ID3"):
        if end < 10 or data[3] not in (2, 3, 4) or any(b & 128 for b in data[6:10]):
            raise ValueError("Audio segment has invalid MP3 metadata.")
        offset = 10 + sum(value << shift for value, shift in zip(data[6:10], (21, 14, 7, 0)))
        if data[3] == 4 and data[5] & 16:
            offset += 10
    if data[-128:-125] == b"TAG":
        end -= 128
    count, expected_frames = 0, None
    while offset < end:
        if count % 1024 == 0:
            _remaining(deadline)
        if end - offset < 4:
            raise ValueError("Audio segment contains a truncated MP3 frame.")
        header = int.from_bytes(data[offset:offset + 4], "big")
        version, layer = (header >> 19) & 3, (header >> 17) & 3
        bitrate_index, rate_index = (header >> 12) & 15, (header >> 10) & 3
        if (header >> 21 != 0x7ff or version == 1 or layer != 1
                or bitrate_index in (0, 15) or rate_index == 3):
            raise ValueError("Audio segment is not a supported complete MP3.")
        rates = (44100, 48000, 32000)
        rate = rates[rate_index] // (1 if version == 3 else 2 if version == 2 else 4)
        bitrates = ((0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)
                    if version == 3 else (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160))
        length = (144000 if version == 3 else 72000) * bitrates[bitrate_index] // rate + ((header >> 9) & 1)
        if offset + length > end:
            raise ValueError("Audio segment contains a truncated MP3 frame.")
        if count == 0:
            mono = (header >> 6) & 3 == 3
            side_info = (17 if mono else 32) if version == 3 else (9 if mono else 17)
            xing = offset + 4 + side_info
            if data[xing:xing + 4] in (b"Xing", b"Info") and xing + 12 <= offset + length:
                flags = int.from_bytes(data[xing + 4:xing + 8], "big")
                if flags & 1:
                    expected_frames = int.from_bytes(data[xing + 8:xing + 12], "big") + 1
        count += 1
        offset += length
    if offset != end or not count or (expected_frames is not None and count != expected_frames):
        raise ValueError("Audio segment is incomplete or has inconsistent MP3 frame counts.")


def _run(executable: str, arguments: list[str], deadline: float, *, decoding: bool) -> None:
    try:
        result = subprocess.run(
            [executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-xerror", *arguments],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=_remaining(deadline), check=False,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Audio assembly exceeded its time limit.") from error
    except OSError as error:
        raise RuntimeError("Audio assembly runtime is unavailable.") from error
    if result.returncode:
        if decoding:
            raise ValueError("Audio segment could not be decoded as complete MP3 audio.")
        raise RuntimeError("Audio assembly encoding failed.")


def _quality_report(executable: str, audio_path: Path, duration: float, deadline: float) -> dict[str, object]:
    """Measure the final MP3. Noise, edits, and narration policy need human review."""
    try:
        result = subprocess.run(
            [executable, "-hide_banner", "-loglevel", "info", "-nostdin", "-xerror",
             "-protocol_whitelist", "file", "-i", str(audio_path), "-map", "0:a:0",
             "-af", "astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=RMS_level+Peak_level",
             "-f", "null", "-"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            timeout=_remaining(deadline), check=False,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Audio quality analysis exceeded its time limit.") from error
    except OSError as error:
        raise RuntimeError("Audio quality analysis runtime is unavailable.") from error
    if result.returncode:
        raise RuntimeError("Audio quality analysis failed.")
    details = result.stderr.decode("utf-8", errors="replace")
    rms_values = re.findall(r"RMS level dB:\s*([-+]?\d+(?:\.\d+)?)", details)
    peak_values = re.findall(r"Peak level dB:\s*([-+]?\d+(?:\.\d+)?)", details)
    if not rms_values or not peak_values:
        raise RuntimeError("Audio quality measurements were unavailable.")
    rms_dbfs, peak_dbfs = float(rms_values[-1]), float(peak_values[-1])
    checks: dict[str, dict[str, object]] = {
        "chapterDuration": {"status": "pass" if 0 < duration <= 7200 else "fail", "value": round(duration, 3), "unit": "seconds", "limit": "no longer than 120 minutes"},
        "rms": {"status": "pass" if -23 <= rms_dbfs <= -18 else "attention", "value": round(rms_dbfs, 2), "unit": "dBFS", "limit": "-23 to -18 dB RMS"},
        "samplePeak": {"status": "pass" if peak_dbfs <= -3 else "attention", "value": round(peak_dbfs, 2), "unit": "dBFS", "limit": "no higher than -3 dBFS"},
        "fileProfile": {"status": "pass", "value": "MP3, mono, 44.1 kHz, 192 kbps CBR", "limit": "at least 192 kbps CBR, 44.1 kHz, mono or stereo"},
        "noiseFloor": {"status": "manual_review", "value": None, "limit": "no higher than -60 dB RMS; requires quiet-room listening"},
        "roomTone": {"status": "manual_review", "value": None, "limit": "1 to 5 seconds at head and tail; requires listening"},
        "pronunciationAndEdits": {"status": "manual_review", "value": None, "limit": "review names, artifacts, outtakes, mouth noise, and chapter heading"},
    }
    return {
        "schemaVersion": 1,
        "profile": "ACX technical preflight; not retailer approval",
        "chapterDurationSeconds": round(duration, 3),
        "sampleRateHz": SAMPLE_RATE,
        "channels": 1,
        "bitRateKbps": 192,
        "bitRateMode": "cbr",
        "rmsDbfs": round(rms_dbfs, 2),
        "samplePeakDbfs": round(peak_dbfs, 2),
        "technicalChecks": checks,
        "reviewRequired": any(item["status"] != "pass" for item in checks.values()),
        "acxNarrationPolicy": "explicit_authorization_required_for_ai_voice",
    }


def assemble_audio_with_quality(segments: list[bytes]) -> tuple[bytes, str, dict[str, object]]:
    """Decode segments in order, concatenate PCM, then encode one 192 kbps MP3.

    Reject rather than truncate input, decoded duration, output size or timeout.
    Only generated local filenames reach FFmpeg; no network protocols are used.
    """
    if not isinstance(segments, list) or not 1 <= len(segments) <= MAX_SEGMENTS:
        raise ValueError(f"Audio assembly requires 1 to {MAX_SEGMENTS} segments.")
    if any(not isinstance(data, bytes) or not 0 < len(data) <= MAX_SEGMENT_BYTES for data in segments):
        raise ValueError("Audio segment is empty or exceeds the 50 MiB limit.")
    if sum(map(len, segments)) > MAX_INPUT_BYTES:
        raise ValueError("Audio segments exceed the 100 MiB combined limit.")
    if not _ASSEMBLY_LOCK.acquire(blocking=False):
        raise RuntimeError("Audio assembly is busy. Try again shortly.")
    try:
        deadline = time.monotonic() + TIMEOUT_SECONDS
        executable = ffmpeg_executable()
        with tempfile.TemporaryDirectory(prefix="bookworm-audio-") as directory:
            root = Path(directory)
            source, part, combined, output = (root / name for name in ("segment.mp3", "part.pcm", "chapter.pcm", "chapter.mp3"))
            pcm_size = 0
            with combined.open("wb") as destination:
                for data in segments:
                    _validate_mp3(data, deadline)
                    source.write_bytes(data)
                    allowed = MAX_SECONDS * PCM_BYTES_PER_SECOND - pcm_size
                    if allowed <= 0:
                        raise ValueError("Audio assembly exceeds the two-hour duration limit.")
                    _run(executable, [
                        "-protocol_whitelist", "file", "-f", "mp3", "-err_detect", "explode", "-threads", "1",
                        "-i", str(source), "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
                        "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", "-threads", "1",
                        "-f", "s16le", "-fs", str(allowed + 2), str(part),
                    ], deadline, decoding=True)
                    size = part.stat().st_size
                    if not size or size % 2:
                        raise ValueError("Audio segment contains no complete audio samples.")
                    if size > allowed:
                        raise ValueError("Audio assembly exceeds the two-hour duration limit.")
                    with part.open("rb") as decoded:
                        shutil.copyfileobj(decoded, destination, length=1024 * 1024)
                    pcm_size += size
                    part.unlink()
                    _remaining(deadline)
            _run(executable, [
                "-protocol_whitelist", "file", "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1",
                "-i", str(combined), "-map", "0:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
                "-c:a", "libmp3lame", "-b:a", "192k", "-ar", str(SAMPLE_RATE), "-ac", "1", "-threads", "1",
                "-fflags", "+bitexact", "-flags:a", "+bitexact", "-write_xing", "1", "-id3v2_version", "0",
                "-f", "mp3", "-fs", str(MAX_OUTPUT_BYTES + 1), str(output),
            ], deadline, decoding=False)
            if not 0 < output.stat().st_size <= MAX_OUTPUT_BYTES:
                raise ValueError("Assembled audio exceeds the 150 MiB output limit.")
            artifact = output.read_bytes()
            _validate_mp3(artifact, deadline)
            quality = _quality_report(executable, output, pcm_size / PCM_BYTES_PER_SECOND, deadline)
            _remaining(deadline)
            return artifact, hashlib.sha256(artifact).hexdigest(), quality
    except OSError as error:
        raise RuntimeError("Audio assembly temporary storage is unavailable.") from error
    finally:
        _ASSEMBLY_LOCK.release()


def assemble_audio(segments: list[bytes]) -> tuple[bytes, str]:
    """Compatibility wrapper for existing internal callers that need no QC payload."""
    artifact, checksum, _quality = assemble_audio_with_quality(segments)
    return artifact, checksum
