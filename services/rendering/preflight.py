"""Deterministic preflight rule engine (PRD section 19).

Rule sets are versioned under rules/ (core_v1 + per-channel). Channel rules are
placeholders with effective_date + source_ref that MUST be verified against current
official retailer documentation at release time — never treat as permanent requirements.

Findings are deterministic: rules run in id order, findings sorted by (rule_id, location).
"""
import io
import re
import struct
import zipfile
import zlib
from dataclasses import dataclass, field
from typing import Callable, Literal
from publication_metadata import effective_publication_metadata

RULE_ENGINE_VERSION = "1.0.0"

Category = Literal[
    "package_integrity", "epub_structure", "navigation", "metadata", "images",
    "fonts", "accessibility", "links", "language", "channel",
]
Severity = Literal["error", "warning", "info"]


@dataclass(frozen=True)
class Finding:
    code: str
    message: str
    location: str = ""
    severity: Severity = "error"
    category: Category = "package_integrity"
    rule_id: str = ""
    rule_version: str = ""

    def to_dict(self) -> dict:
        return {
            "code": self.code, "message": self.message, "location": self.location,
            "severity": self.severity, "category": self.category,
            "rule_id": self.rule_id, "rule_version": self.rule_version,
        }


@dataclass(frozen=True)
class Rule:
    id: str
    severity: Severity
    category: Category
    description: str
    check: Callable[[dict], list[Finding]]  # ctx -> findings (rule_id stamped by runner)
    channels: tuple[str, ...] = ("*",)  # "*" = core, else channel slug
    effective_date: str = ""
    source_ref: str = ""  # official retailer doc URL, verified at release


@dataclass
class RuleSet:
    name: str
    version: str
    rules: list[Rule] = field(default_factory=list)


def run_preflight(ctx: dict, ruleset: RuleSet) -> list[Finding]:
    """ctx: {book, edition (dict), artifact (epub bytes|None), channel, image_bytes {assetId: bytes}}.
    Findings sorted by (rule_id, code, location) for determinism."""
    # Rules share request-local parsing results. Never reuse a caller's cache
    # when the same context is evaluated again with a different artifact.
    ctx = dict(ctx)
    ctx.pop("_print_pdf_page_count", None)
    ctx.pop("_epub_readable", None)
    ctx.pop("_apple_epubcheck_result", None)
    ctx.pop("_google_epubcheck_result", None)
    out: list[Finding] = []
    for rule in sorted(ruleset.rules, key=lambda r: r.id):
        for f in rule.check(ctx):
            out.append(Finding(
                code=f.code, message=f.message, location=f.location,
                severity=rule.severity, category=rule.category,
                rule_id=rule.id, rule_version=ruleset.version))
    out.sort(key=lambda f: (f.rule_id, f.code, f.location))
    return out


# ---- shared check helpers -------------------------------------------------

_LANG_RE = re.compile(r"^[a-z]{2,3}(-[A-Za-z]{2,4})?$")
_EPUB_MAX_ENTRIES = 10_000
_EPUB_MAX_DIRECTORY_BYTES = 8 * 1024 * 1024
_EPUB_MAX_EXPANDED_BYTES = 512 * 1024 * 1024
_EPUB_MAX_COMPRESSION_RATIO = 1000
_EPUB_STREAM_CHUNK = 64 * 1024


def _check_epub_directory_bounds(blob: bytes) -> None:
    """Bound ZipFile's central-directory allocation before constructing it.

    Bookworm packages are limited to 175 MiB and 10,000 entries, so ZIP64 is
    unnecessary here. Reject it explicitly instead of guessing its offsets.
    """
    first = max(0, len(blob) - (65_535 + 22))
    offset = blob.rfind(b"PK\x05\x06", first)
    if offset < 0 or offset + 22 > len(blob):
        raise ValueError("invalid EPUB archive")
    signature, disk, directory_disk, disk_entries, entries, size, directory_offset, comment_length = struct.unpack_from("<4s4H2IH", blob, offset)
    if (signature != b"PK\x05\x06" or disk or directory_disk or disk_entries != entries
            or entries == 0xFFFF or size == 0xFFFFFFFF or directory_offset == 0xFFFFFFFF
            or (offset >= 20 and blob[offset - 20:offset - 16] == b"PK\x06\x07") or entries > _EPUB_MAX_ENTRIES
            or size > _EPUB_MAX_DIRECTORY_BYTES or offset + 22 + comment_length != len(blob)):
        raise ValueError("invalid EPUB archive")


def _open_epub(ctx: dict) -> zipfile.ZipFile | None:
    blob = ctx.get("artifact")
    if not blob:
        return None
    try:
        # A ZIP central directory alone does not prove its members are
        # readable. Verify every member before any rule or package can trust
        # the saved artifact. Bound entry count, expansion, and each streamed
        # read so compressed input cannot allocate an unbounded result.
        if "_epub_readable" not in ctx:
            _check_epub_directory_bounds(blob)
            with zipfile.ZipFile(io.BytesIO(blob)) as archive:
                items = archive.infolist()
                if len(items) > _EPUB_MAX_ENTRIES or len({item.filename for item in items}) != len(items):
                    raise ValueError("invalid EPUB archive")
                total = 0
                for item in items:
                    total += item.file_size
                    if (item.file_size < 0 or item.compress_size < 0 or total > _EPUB_MAX_EXPANDED_BYTES
                            or item.file_size > max(1, item.compress_size) * _EPUB_MAX_COMPRESSION_RATIO):
                        raise ValueError("invalid EPUB archive")
                    actual = 0
                    with archive.open(item) as stream:
                        while chunk := stream.read(_EPUB_STREAM_CHUNK):
                            actual += len(chunk)
                            if actual > item.file_size:
                                raise ValueError("invalid EPUB archive")
                    if actual != item.file_size:
                        raise ValueError("invalid EPUB archive")
            ctx["_epub_readable"] = True
        if not ctx["_epub_readable"]:
            return None
        return zipfile.ZipFile(io.BytesIO(blob))
    except (zipfile.BadZipFile, OSError, EOFError, RuntimeError, NotImplementedError, ValueError, struct.error, zlib.error):
        ctx["_epub_readable"] = False
        return None


def _meta(ctx: dict) -> dict:
    edition = ctx.get("edition") or {}
    overrides = edition.get("metadata_overrides") if edition.get("kind") == "ebook" else None
    return effective_publication_metadata(ctx["book"].get("metadata", {}), overrides)
