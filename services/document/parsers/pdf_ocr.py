"""Bounded, local OCR for PDF pages without a text layer."""

import os
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import BoundedSemaphore
from time import monotonic

OCR_SECONDS = 40
_MAX_PAGES = 80
_MAX_SOURCE_BYTES = 20 * 1024 * 1024  # Matches the manuscript intake limit.
_RASTER_SIDE = 2400
_MAX_RASTER_BYTES = _RASTER_SIDE ** 2 + 4096
_MAX_TEXT_BYTES = 64 * 1024
_LANGUAGES = {"en": "eng", "es": "spa", "fr": "fra", "de": "deu", "ar": "ara"}
_PROCESS_ENV = ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "TESSDATA_PREFIX")
_OCR_SLOT = BoundedSemaphore(1)


def _run(args: list[str], folder: Path, env: dict[str, str], deadline: float) -> None:
    remaining = deadline - monotonic()
    if remaining <= 0:
        raise subprocess.TimeoutExpired(args[0], 0)
    subprocess.run(args, cwd=folder, env=env, stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   check=True, timeout=min(8, remaining),
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def recover_pdf_scan(data: bytes, pages: list[int], language: str, deadline: float) -> tuple[dict[int, str], str | None]:
    """Return recognized text by one-based page number plus any processing issue."""
    model = _LANGUAGES.get(language.lower().replace("_", "-").split("-", 1)[0])
    if model is None:
        return {}, "unsupported_language"
    if len(data) > _MAX_SOURCE_BYTES or len(pages) > _MAX_PAGES:
        return {}, "limit"
    rasterizer, tesseract = shutil.which("pdftoppm"), shutil.which("tesseract")
    if not rasterizer or not tesseract:
        return {}, "unavailable"
    if not _OCR_SLOT.acquire(blocking=False):
        return {}, "busy"
    recovered = {}
    try:
        env = {key: os.environ[key] for key in _PROCESS_ENV if key in os.environ}
        env["OMP_THREAD_LIMIT"] = "1"
        with TemporaryDirectory(prefix="bookworm-pdf-scan-") as scratch:
            folder = Path(scratch)
            (folder / "source.pdf").write_bytes(data)
            for page in pages:
                number = str(page)
                raster = folder / "page.pgm"
                output = folder / "recognized.txt"
                _run([rasterizer, "-f", number, "-l", number, "-singlefile", "-cropbox", "-hide-annotations",
                      "-gray", "-scale-to", str(_RASTER_SIDE), "source.pdf", "page"], folder, env, deadline)
                if not 0 < raster.stat().st_size <= _MAX_RASTER_BYTES:
                    return recovered, "incomplete"
                _run([tesseract, "page.pgm", "recognized", "-l", model, "--psm", "3"], folder, env, deadline)
                if output.stat().st_size > _MAX_TEXT_BYTES:
                    return recovered, "incomplete"
                # Remove page-end form feeds while preserving paragraph breaks and Unicode.
                text = output.read_text(encoding="utf-8").replace("\f", "").strip()
                if any(char.isalnum() for char in text):
                    recovered[page] = text
                raster.unlink()
                output.unlink()
    except (OSError, ValueError, subprocess.SubprocessError):
        return recovered, "incomplete"
    finally:
        _OCR_SLOT.release()
    return recovered, None
