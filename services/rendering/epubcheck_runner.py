"""Bounded, fail-closed validation of exact EPUB bytes with W3C EPUBCheck 5.4.0."""
import json
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal


@dataclass(frozen=True)
class EpubCheckResult:
    status: Literal["valid", "invalid", "unavailable"]
    errors: int = 0
    warnings: int = 0


def run_epubcheck(epub: bytes) -> EpubCheckResult:
    jar = Path(os.environ.get("EPUBCHECK_JAR", ""))
    if not epub or len(epub) > 175 * 1024 * 1024 or not jar.is_file() or jar.suffix.lower() != ".jar":
        return EpubCheckResult("unavailable")
    try:
        with tempfile.TemporaryDirectory(prefix="bookworm-epubcheck-") as temp:
            source = Path(temp) / "book.epub"
            report = Path(temp) / "report.json"
            source.write_bytes(epub)
            result = subprocess.run(
                ["java", "-Xmx256m", "-jar", str(jar), str(source), "--json", str(report)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=90, check=False,
            )
            if result.returncode not in (0, 1) or not report.is_file() or report.stat().st_size > 1_000_000:
                return EpubCheckResult("unavailable")
            parsed = json.loads(report.read_text(encoding="utf-8"))
            checker = parsed.get("checker") if isinstance(parsed, dict) else None
            if not isinstance(checker, dict) or checker.get("checkerVersion") != "5.4.0" or checker.get("filename") != "book.epub":
                return EpubCheckResult("unavailable")
            counts = [checker.get(key) for key in ("nFatal", "nError", "nWarning")]
            if any(type(count) is not int or count < 0 for count in counts):
                return EpubCheckResult("unavailable")
            errors = counts[0] + counts[1]
            warnings = counts[2]
            if result.returncode == 0 and errors == 0:
                return EpubCheckResult("valid", 0, warnings)
            if result.returncode == 1 and errors > 0:
                return EpubCheckResult("invalid", errors, warnings)
    except (OSError, ValueError, json.JSONDecodeError, subprocess.TimeoutExpired):
        pass
    return EpubCheckResult("unavailable")
