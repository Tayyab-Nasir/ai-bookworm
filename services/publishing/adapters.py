"""Publishing channel adapters (spec section 14). Export-first: validate + buildPackage
work locally; submit/getStatus raise NotSupportedError until official integrations exist.
"""
import hashlib
import json
import re
import sys
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Protocol

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "rendering"))
from preflight import run_preflight  # noqa: E402
from rules import load_ruleset  # noqa: E402


class NotSupportedError(Exception):
    """Raised for submit/getStatus: export-first mode, no live retailer integration."""


def publishing_metadata(book: dict) -> dict:
    """Project public listing fields only; never serialize the full book model."""
    source = book.get("metadata", {})
    if not isinstance(source, dict):
        raise ValueError("publishing metadata must be an object")
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
    return {"schemaVersion": "1.0", "metadata": result}


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
        if set(artifacts) & {"manifest.json", "metadata.json", "README.txt"}:
            raise ValueError("package artifact name is reserved")
        files = {**artifacts,
                 "metadata.json": json.dumps(publishing_metadata(ctx.get("book", {})),
                                             indent=2, sort_keys=True, ensure_ascii=False).encode("utf-8"),
                 "README.txt": (
                     f"AI Bookworm - {self.CHANNEL} author handoff\n\n"
                     "This package has NOT been submitted, published or approved by a retailer.\n"
                     "Use book.epub or book.pdf and the included cover, when present, in the retailer's own upload form.\n"
                     "metadata.json contains the saved listing text for manual entry, not a retailer import schema.\n"
                     "Review description, keywords and categories against the current retailer form.\n"
                     "Confirm rights, ISBN entitlement, territories, pricing and required AI-content disclosures yourself.\n"
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


_ADAPTERS: dict[str, ExportAdapter] = {
    a.CHANNEL: a for a in (KdpAdapter(), AppleBooksAdapter(), BarnesNobleAdapter(), LuluAdapter())
}


def get_adapter(channel: str) -> ExportAdapter:
    try:
        return _ADAPTERS[channel]
    except KeyError:
        raise KeyError(f"unknown channel {channel!r}; known: {sorted(_ADAPTERS)}") from None
