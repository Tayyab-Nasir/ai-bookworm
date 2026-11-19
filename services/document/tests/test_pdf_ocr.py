"""Local scan processing is bounded and disposable."""

import subprocess
import sys
from pathlib import Path
from time import monotonic

SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE))
from parsers import pdf_ocr


def test_recognition_uses_allowlisted_tools_and_cleans_scratch(monkeypatch):
    monkeypatch.setattr(pdf_ocr.shutil, "which", lambda tool: tool)
    monkeypatch.setenv("DOCUMENT_SERVICE_TOKEN", "synthetic-token-excluded-from-processes")
    calls = []

    def run(args, *, cwd, env, timeout, **kwargs):
        assert 0 < timeout <= 8
        assert env["OMP_THREAD_LIMIT"] == "1" and "DOCUMENT_SERVICE_TOKEN" not in env
        assert kwargs["stdout"] == subprocess.DEVNULL and kwargs["stderr"] == subprocess.DEVNULL
        calls.append((args, cwd))
        assert (cwd / "source.pdf").read_bytes() == b"sample"
        if args[0] == "pdftoppm":
            assert args[1:5] == ["-f", "2", "-l", "2"]
            assert not (cwd / "page.pgm").exists()
            (cwd / "page.pgm").write_bytes(b"P5\n1 1\n255\n\xff")
        else:
            assert args[0] == "tesseract" and args[3:5] == ["-l", "fra"]
            (cwd / "recognized.txt").write_text("Un livre retrouvé.\n\nLa suite.\f", encoding="utf-8")

    monkeypatch.setattr(pdf_ocr.subprocess, "run", run)
    recovered, issue = pdf_ocr.recover_pdf_scan(b"sample", [2], "fr-CA", monotonic() + 10)
    assert recovered == {2: "Un livre retrouvé.\n\nLa suite."} and issue is None
    assert [args[0] for args, _ in calls] == ["pdftoppm", "tesseract"]
    assert not calls[0][1].exists()


def test_over_limit_and_unsupported_scans_start_no_external_process(monkeypatch):
    def no_lookup(_tool):
        raise AssertionError("An ineligible scan must not look for an executable")

    monkeypatch.setattr(pdf_ocr.shutil, "which", no_lookup)
    assert pdf_ocr.recover_pdf_scan(b"sample", list(range(1, 82)), "en", monotonic() + 10) == ({}, "limit")
    assert pdf_ocr.recover_pdf_scan(b"sample", [1], "ja", monotonic() + 10) == ({}, "unsupported_language")


def test_worker_capacity_is_retryable_and_deadlines_release_the_slot(monkeypatch):
    monkeypatch.setattr(pdf_ocr.shutil, "which", lambda tool: tool)
    pdf_ocr._OCR_SLOT.acquire()
    try:
        assert pdf_ocr.recover_pdf_scan(b"sample", [1], "en", monotonic() + 10) == ({}, "busy")
    finally:
        pdf_ocr._OCR_SLOT.release()

    def no_launch(*args, **kwargs):
        raise AssertionError("Expired requests must not spawn a process")

    monkeypatch.setattr(pdf_ocr.subprocess, "run", no_launch)
    assert pdf_ocr.recover_pdf_scan(b"sample", [1], "en", monotonic() - 1) == ({}, "incomplete")
    assert pdf_ocr._OCR_SLOT.acquire(blocking=False)
    pdf_ocr._OCR_SLOT.release()
