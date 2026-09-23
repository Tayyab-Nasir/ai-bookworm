import array
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import audio_assembly as audio


def ffmpeg(*arguments):
    return subprocess.run([audio.ffmpeg_executable(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *arguments],
        check=True, capture_output=True, timeout=15,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)


@pytest.fixture(scope="module")
def tones(tmp_path_factory):
    root = tmp_path_factory.mktemp("native-audio")
    clips = []
    for index, (frequency, rate, channels) in enumerate(((440, 24000, 1), (880, 48000, 2))):
        output = root / f"tone-{index}.mp3"
        ffmpeg("-f", "lavfi", "-i", f"sine=frequency={frequency}:duration=0.4:sample_rate={rate}", "-af", "volume=1.5",
            "-ac", str(channels), "-c:a", "libmp3lame", "-b:a", "96k", str(output))
        clips.append(output.read_bytes())
    return clips


def samples(data, tmp_path):
    source, output = tmp_path / "source.mp3", tmp_path / "decoded.pcm"
    source.write_bytes(data)
    ffmpeg("-i", str(source), "-f", "s16le", "-ar", "44100", "-ac", "1", str(output))
    result = array.array("h", output.read_bytes())
    if sys.byteorder != "little":
        result.byteswap()
    return result


def frequency(values):
    crossings = sum(a <= 0 < b for a, b in zip(values, values[1:]))
    return crossings / (len(values) / 44100)


def test_native_assembly_preserves_order_duration_format_and_determinism(tones, tmp_path):
    artifact, checksum = audio.assemble_audio(tones)
    assert audio.assemble_audio(tones) == (artifact, checksum)
    assert checksum == hashlib.sha256(artifact).hexdigest()
    assert artifact != b"".join(tones)
    decoded = samples(artifact, tmp_path)
    assert len(decoded) / 44100 == pytest.approx(0.8, abs=0.004)
    assert frequency(decoded[4410:13230]) == pytest.approx(440, abs=8)
    assert frequency(decoded[22050:30870]) == pytest.approx(880, abs=8)
    header = int.from_bytes(artifact[:4], "big")
    assert (header >> 19) & 3 == 3  # MPEG-1
    assert (header >> 10) & 3 == 0  # 44.1 kHz
    assert (header >> 6) & 3 == 3  # Mono
    assert (header >> 12) & 15 == 11  # 192 kbps


def test_quality_report_measures_output_and_keeps_listening_and_ai_policy_gates(tones):
    artifact, checksum, quality = audio.assemble_audio_with_quality(tones)
    assert checksum == hashlib.sha256(artifact).hexdigest()
    assert quality["schemaVersion"] == 1
    assert quality["chapterDurationSeconds"] == pytest.approx(0.8, abs=0.01)
    assert quality["sampleRateHz"] == 44100
    assert quality["channels"] == 1
    assert quality["bitRateKbps"] == 192
    assert quality["bitRateMode"] == "cbr"
    assert quality["rmsDbfs"] == pytest.approx(-19.5, abs=1)
    assert quality["samplePeakDbfs"] <= -3
    assert quality["technicalChecks"]["rms"]["status"] == "pass"
    assert quality["technicalChecks"]["noiseFloor"]["status"] == "manual_review"
    assert quality["technicalChecks"]["roomTone"]["status"] == "manual_review"
    assert quality["reviewRequired"] is True
    assert quality["acxNarrationPolicy"] == "explicit_authorization_required_for_ai_voice"


@pytest.mark.parametrize("data", [b"", b"ID3", b"http://example.test/source.mp3", b"RIFF" + b"x" * 100, b"\xff\xff\xff\xff"])
def test_rejects_non_audio(data):
    with pytest.raises(ValueError):
        audio.assemble_audio([data])


def test_rejects_partial_frames_and_false_frame_count(tones):
    with pytest.raises(ValueError, match="truncated"):
        audio.assemble_audio([tones[0][:-1]])
    with pytest.raises(ValueError, match="frame counts"):
        audio.assemble_audio([tones[0] + tones[0][-288:]])  # Complete duplicate MPEG-2 frame.
    with pytest.raises(ValueError):
        audio.assemble_audio([tones[0] + b"trailing garbage"])


def test_accepts_streaming_mp3_without_xing_and_id3v1(tones, tmp_path):
    source, output = tmp_path / "tagged.mp3", tmp_path / "stream.mp3"
    source.write_bytes(tones[0])
    ffmpeg("-i", str(source), "-c:a", "copy", "-write_xing", "0", "-id3v2_version", "0", str(output))
    artifact, _ = audio.assemble_audio([output.read_bytes() + b"TAG" + bytes(125)])
    assert len(samples(artifact, tmp_path)) > 0


def test_input_and_output_limits(tones, monkeypatch):
    with pytest.raises(ValueError, match="1 to"):
        audio.assemble_audio([])
    with pytest.raises(ValueError, match="1 to"):
        audio.assemble_audio([b"x"] * 251)
    monkeypatch.setattr(audio, "MAX_SEGMENT_BYTES", 1)
    with pytest.raises(ValueError, match="50 MiB"):
        audio.assemble_audio(tones)
    monkeypatch.setattr(audio, "MAX_SEGMENT_BYTES", 50 * 1024 * 1024)
    monkeypatch.setattr(audio, "MAX_INPUT_BYTES", sum(map(len, tones)) - 1)
    with pytest.raises(ValueError, match="combined"):
        audio.assemble_audio(tones)
    monkeypatch.setattr(audio, "MAX_INPUT_BYTES", 100 * 1024 * 1024)
    monkeypatch.setattr(audio, "MAX_OUTPUT_BYTES", 1000)
    with pytest.raises(ValueError, match="output limit"):
        audio.assemble_audio(tones)


def test_duration_limit_and_temporary_cleanup(tones, tmp_path, monkeypatch):
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    monkeypatch.setattr(audio, "MAX_SECONDS", 0.5)
    with pytest.raises(ValueError, match="duration limit"):
        audio.assemble_audio(tones)
    assert list(tmp_path.iterdir()) == []
    monkeypatch.setattr(audio, "MAX_SECONDS", 7200)
    audio.assemble_audio(tones)
    assert list(tmp_path.iterdir()) == []


def test_busy_unavailable_and_timeout_release_capacity(tones, monkeypatch):
    audio._ASSEMBLY_LOCK.acquire()
    try:
        with pytest.raises(RuntimeError, match="busy"):
            audio.assemble_audio(tones)
    finally:
        audio._ASSEMBLY_LOCK.release()
    monkeypatch.setattr(audio, "TIMEOUT_SECONDS", 0)
    with pytest.raises(RuntimeError, match="time limit"):
        audio.assemble_audio(tones)
    assert not audio._ASSEMBLY_LOCK.locked()
    monkeypatch.setattr(audio, "TIMEOUT_SECONDS", 120)
    monkeypatch.setattr(audio, "ffmpeg_executable", lambda: "does-not-exist-ffmpeg")
    with pytest.raises(RuntimeError, match="unavailable"):
        audio.assemble_audio(tones)
    assert not audio._ASSEMBLY_LOCK.locked()


def test_runtime_resolution_does_not_start_an_unbounded_probe(monkeypatch):
    monkeypatch.delenv("IMAGEIO_FFMPEG_EXE", raising=False)
    def forbid(*args, **kwargs):
        pytest.fail("Binary discovery must not run a child process")
    monkeypatch.setattr(audio.subprocess, "run", forbid)
    monkeypatch.setattr(audio.subprocess, "Popen", forbid)
    assert Path(audio.ffmpeg_executable()).is_file()
    monkeypatch.setenv("IMAGEIO_FFMPEG_EXE", "not-a-real-executable")
    with pytest.raises(RuntimeError, match="unavailable"):
        audio.ffmpeg_executable()


def test_subprocess_boundary_has_no_network_or_visible_window(tones, monkeypatch):
    original = audio.subprocess.run
    calls = []
    def capture(arguments, **kwargs):
        calls.append((arguments, kwargs))
        return original(arguments, **kwargs)
    monkeypatch.setattr(audio.subprocess, "run", capture)
    audio.assemble_audio(tones)
    assert len(calls) == 4
    for index, (arguments, kwargs) in enumerate(calls):
        assert arguments[arguments.index("-protocol_whitelist") + 1] == "file"
        assert 0 < kwargs["timeout"] <= 120
        assert kwargs["stdin"] == subprocess.DEVNULL
        assert kwargs["stderr"] == (subprocess.PIPE if index == 3 else subprocess.DEVNULL)
        assert kwargs["creationflags"] == (subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)


def test_child_timeout_cleans_files_and_releases_capacity(tones, tmp_path, monkeypatch):
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    def timeout(*arguments, **kwargs):
        raise subprocess.TimeoutExpired("ffmpeg", kwargs["timeout"])
    monkeypatch.setattr(audio.subprocess, "run", timeout)
    with pytest.raises(RuntimeError, match="time limit"):
        audio.assemble_audio(tones)
    assert list(tmp_path.iterdir()) == []
    assert not audio._ASSEMBLY_LOCK.locked()
