"""Publishing channel adapters (spec section 14). Export-first: validate + buildPackage
work locally; submit/getStatus raise NotSupportedError until official integrations exist.
"""
import hashlib
import json
import re
import sys
import zipfile
import zlib
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Protocol
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "rendering"))
from preflight import run_preflight  # noqa: E402
from rules import load_ruleset  # noqa: E402
from publication_metadata import effective_publication_metadata  # noqa: E402


class NotSupportedError(Exception):
    """Raised for submit/getStatus: export-first mode, no live retailer integration."""


def publishing_metadata(book: dict, edition: dict | None = None) -> dict:
    """Project public listing fields only; never serialize the full book model."""
    config = edition or {}
    overrides = config.get("metadata_overrides") if config.get("kind") == "ebook" else None
    source = effective_publication_metadata(book.get("metadata", {}), overrides)
    result = {}
    for field in ("title", "subtitle", "author", "language", "description", "isbn13", "edition"):
        value = source.get(field)
        if value is not None and not isinstance(value, str):
            raise ValueError(f"publishing metadata {field} must be text")
        if field in source:
            result[field] = value
    for field in ("keywords", "categories"):
        value = source.get(field, [])
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise ValueError(f"publishing metadata {field} must be a text list")
        result[field] = value
    if "publicationDate" in source:
        result["publicationDate"] = source["publicationDate"]
    return {"schemaVersion": "1.0", "metadata": result}


def _assert_saved_epub_metadata(blob: bytes, metadata: dict) -> None:
    """Check the exact saved artifact, including proofs made before this policy."""
    unreadable = "Saved EPUB publication metadata cannot be verified. Render again before packaging."
    mismatch = "Saved EPUB publication date or language does not match this edition. Render again before packaging."
    max_opf_bytes = 1_000_000  # Same inspection bound used by Google Play OPF checks.
    try:
        with zipfile.ZipFile(BytesIO(blob)) as archive:
            matches = [info for info in archive.infolist() if info.filename == "OEBPS/content.opf"]
            if len(matches) != 1 or matches[0].file_size > max_opf_bytes:
                raise ValueError(unreadable)
            with archive.open(matches[0]) as document:
                raw = document.read(max_opf_bytes + 1)
            if len(raw) > max_opf_bytes:
                raise ValueError(unreadable)
        text = raw.decode("utf-8-sig")
        # Worker-generated OPFs are UTF-8 and never need DTD/entity expansion.
        if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
            raise ValueError(unreadable)
        declaration = re.match(r"<\?xml\b.*?\?>", text, re.DOTALL)
        encoding = re.search(r"\bencoding\s*=\s*(['\"])(.*?)\1", declaration.group()) if declaration else None
        if encoding and encoding.group(2).upper() not in ("UTF-8", "UTF8"):
            raise ValueError(unreadable)
        # Parse the same UTF-8 text we validated, not bytes with another declared codec.
        root = ET.fromstring(text)
    except (zipfile.BadZipFile, KeyError, OSError, RuntimeError, NotImplementedError,
            EOFError, zlib.error, UnicodeDecodeError, ET.ParseError) as error:
        raise ValueError(unreadable) from error
    opf_namespace = "{http://www.idpf.org/2007/opf}"
    dc_namespace = "{http://purl.org/dc/elements/1.1/}"
    entries = root.findall(opf_namespace + "metadata")
    if root.tag != opf_namespace + "package" or len(entries) != 1:
        raise ValueError(unreadable)
    dates = entries[0].findall(dc_namespace + "date")
    languages = entries[0].findall(dc_namespace + "language")
    if any(len(element) or (element.tail or "").strip() for element in dates + languages):
        raise ValueError(unreadable)
    expected_date = metadata.get("publicationDate")
    if (len(dates) != (1 if expected_date is not None else 0)
            or (dates and dates[0].text != expected_date)
            or len(languages) != 1 or languages[0].text != (metadata.get("language") or "en")):
        raise ValueError(mismatch)


@dataclass(frozen=True)
class ChannelCapabilities:
    formats: tuple[str, ...]  # "epub" | "pdf"
    can_submit: bool
    can_check_status: bool
    required_metadata: tuple[str, ...]


@dataclass
class PackageArtifact:
    path: str  # logical name inside export dir
    data: bytes
    sha256: str


class PublishingAdapter(Protocol):
    def channel(self) -> str: ...
    def capabilities(self) -> ChannelCapabilities: ...
    def validate(self, ctx: dict) -> dict: ...           # -> {ruleVersion, findings}
    def build_package(self, ctx: dict, artifacts: dict[str, bytes]) -> list[PackageArtifact]: ...
    def submit(self, *a, **k): ...
    def get_status(self, job_id: str): ...


class ExportAdapter:
    """Base for export-first channels. Subclasses set CHANNEL + _CAPS."""

    CHANNEL: str = ""
    _CAPS = ChannelCapabilities(formats=("epub", "pdf"), can_submit=False,
                                can_check_status=False, required_metadata=("title", "author"))

    def channel(self) -> str:
        return self.CHANNEL

    def capabilities(self) -> ChannelCapabilities:
        return self._CAPS

    def validate(self, ctx: dict) -> dict:
        ruleset = load_ruleset(self.CHANNEL)
        findings = run_preflight(ctx, ruleset)
        return {
            "channel": self.CHANNEL,
            "ruleVersion": ruleset.version,
            "errors": sum(1 for f in findings if f.severity == "error"),
            "warnings": sum(1 for f in findings if f.severity == "warning"),
            "findings": [f.to_dict() for f in findings],
        }

    def build_package(self, ctx: dict, artifacts: dict[str, bytes]) -> list[PackageArtifact]:
        """Deterministic export zip: rendered artifact(s) + manifest.json with sha256s,
        rule version, and channel. Fixed entry order, fixed timestamps."""
        result = self.validate(ctx)
        if result["errors"]:
            raise ValueError(f"{self.CHANNEL} package has unresolved validation errors")
        if not artifacts or len(artifacts) > 3 or any(
                not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", name)
                for name in artifacts):
            raise ValueError("package artifacts must use safe flat filenames")
        if set(artifacts) & {"manifest.json", "metadata.json", "preflight.json", "README.txt"}:
            raise ValueError("package artifact name is reserved")
        listing = publishing_metadata(ctx.get("book", {}), ctx.get("edition"))
        if (ctx.get("edition") or {}).get("kind") == "ebook":
            if "book.epub" not in artifacts:
                raise ValueError("A saved book.epub is required. Render again before packaging.")
            _assert_saved_epub_metadata(artifacts["book.epub"], listing["metadata"])
        files = {**artifacts,
                 "preflight.json": json.dumps({"schemaVersion": "1.0", **result},
                                              indent=2, sort_keys=True, ensure_ascii=False).encode("utf-8"),
                 "metadata.json": json.dumps(listing,
                                             indent=2, sort_keys=True, ensure_ascii=False).encode("utf-8"),
                 "README.txt": (
                     f"AI Bookworm - {self.CHANNEL} author handoff\n\n"
                     "This package has NOT been submitted, published or approved by a retailer.\n"
                     "Use book.epub or book.pdf and the included cover, when present, in the retailer's own upload form.\n"
                     "metadata.json contains the saved listing text for manual entry, not a retailer import schema.\n"
                     "Review description, keywords and categories against the current retailer form.\n"
                     "preflight.json contains the validation findings and their locations for this snapshot; review all warnings before uploading.\n"
                     + ("For Google Play Books, upload book.epub in an existing single-book Partner Center Content tab; this generic filename is not for bulk upload.\n"
                        "Run EpubCheck and review Google's processing result, pricing, territories and Review tab before you click Publish.\n"
                        if self.CHANNEL == "googleplay" else "")
                     + "Confirm rights, ISBN entitlement, territories, pricing and required AI-content disclosures yourself.\n"
                     "Inspect the retailer preview or physical proof before approving publication.\n"
                     "manifest.json records checksums and the validation rule version; zero errors is not retailer approval.\n"
                     "This is a snapshot: later book changes require a new render, preflight and package.\n"
                 ).encode("utf-8")}
        manifest = {
            "packageVersion": "2.0",
            "channel": self.CHANNEL,
            "ruleVersion": result["ruleVersion"],
            "errors": result["errors"],
            "warnings": result["warnings"],
            "files": {},
        }
        buf = BytesIO()
        names = sorted(files)
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for name in names:
                data = files[name]
                manifest["files"][name] = hashlib.sha256(data).hexdigest()
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, data)
            info = zipfile.ZipInfo("manifest.json", date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, json.dumps(manifest, indent=2, sort_keys=True).encode())
        blob = buf.getvalue()
        return [PackageArtifact(path=f"{self.CHANNEL}-export.zip", data=blob,
                                sha256=hashlib.sha256(blob).hexdigest())]

    def submit(self, *a, **k):
        raise NotSupportedError(
            f"{self.CHANNEL}: export-first mode; official submission integration not yet available")

    def get_status(self, job_id: str):
        raise NotSupportedError(
            f"{self.CHANNEL}: export-first mode; no live submission status to check")


class KdpAdapter(ExportAdapter):
    CHANNEL = "kdp"
    _CAPS = ChannelCapabilities(formats=("epub", "pdf"), can_submit=False,
                                can_check_status=False,
                                required_metadata=("title", "author", "language", "description"))


class AppleBooksAdapter(ExportAdapter):
    CHANNEL = "apple"
    _CAPS = ChannelCapabilities(formats=("epub",), can_submit=False,
                                can_check_status=False,
                                required_metadata=("title", "author", "language", "description",
                                                   "categories"))


class BarnesNobleAdapter(ExportAdapter):
    CHANNEL = "barnesnoble"
    _CAPS = ChannelCapabilities(formats=("epub", "pdf"), can_submit=False,
                                can_check_status=False,
                                required_metadata=("title", "author", "language"))


class LuluAdapter(ExportAdapter):
    CHANNEL = "lulu"
    _CAPS = ChannelCapabilities(formats=("pdf",), can_submit=False,
                                can_check_status=False,
                                required_metadata=("title", "author", "language"))


class GooglePlayAdapter(ExportAdapter):
    CHANNEL = "googleplay"
    _CAPS = ChannelCapabilities(formats=("epub",), can_submit=False,
                                can_check_status=False,
                                required_metadata=("title", "author", "language"))


_ADAPTERS: dict[str, ExportAdapter] = {
    a.CHANNEL: a for a in (KdpAdapter(), AppleBooksAdapter(), BarnesNobleAdapter(), LuluAdapter(), GooglePlayAdapter())
}


def get_adapter(channel: str) -> ExportAdapter:
    try:
        return _ADAPTERS[channel]
    except KeyError:
        raise KeyError(f"unknown channel {channel!r}; known: {sorted(_ADAPTERS)}") from None
