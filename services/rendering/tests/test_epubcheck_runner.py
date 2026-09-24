"""No provider/network calls: verify EPUBCheck process protocol and fail-closed paths."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

RENDERING = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RENDERING))

import epubcheck_runner  # noqa: E402


def test_epubcheck_is_unavailable_without_an_installed_jar(monkeypatch):
    monkeypatch.delenv("EPUBCHECK_JAR", raising=False)
    assert epubcheck_runner.run_epubcheck(b"PKfixture").status == "unavailable"


def test_epubcheck_validates_the_exact_bytes_and_reads_bounded_report(tmp_path, monkeypatch):
    jar = tmp_path / "epubcheck.jar"
    jar.write_bytes(b"fixture")
    monkeypatch.setenv("EPUBCHECK_JAR", str(jar))

    def fake_run(args, **kwargs):
        assert args[:4] == ["java", "-Xmx256m", "-jar", str(jar)]
        assert Path(args[4]).read_bytes() == b"PKexact-output"
        assert kwargs["timeout"] == 90 and kwargs["check"] is False
        Path(args[6]).write_text(json.dumps({"checker": {"checkerVersion": "5.4.0",
            "filename": "book.epub", "nFatal": 0, "nError": 0, "nWarning": 2}}), encoding="utf-8")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(epubcheck_runner.subprocess, "run", fake_run)
    assert epubcheck_runner.run_epubcheck(b"PKexact-output") == epubcheck_runner.EpubCheckResult("valid", 0, 2)


def test_epubcheck_rejects_invalid_or_untrusted_reports(tmp_path, monkeypatch):
    jar = tmp_path / "epubcheck.jar"
    jar.write_bytes(b"fixture")
    monkeypatch.setenv("EPUBCHECK_JAR", str(jar))

    def failed_run(args, **_kwargs):
        Path(args[6]).write_text(json.dumps({"checker": {"checkerVersion": "5.4.0",
            "filename": "book.epub", "nFatal": 1, "nError": 2, "nWarning": 0}}), encoding="utf-8")
        return SimpleNamespace(returncode=1)

    monkeypatch.setattr(epubcheck_runner.subprocess, "run", failed_run)
    assert epubcheck_runner.run_epubcheck(b"PKbad") == epubcheck_runner.EpubCheckResult("invalid", 3, 0)

    def false_success(args, **_kwargs):
        Path(args[6]).write_text(json.dumps({"checker": {"checkerVersion": "5.3.0",
            "filename": "book.epub", "nFatal": 0, "nError": 0, "nWarning": 0}}), encoding="utf-8")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(epubcheck_runner.subprocess, "run", false_success)
    assert epubcheck_runner.run_epubcheck(b"PKbad").status == "unavailable"
