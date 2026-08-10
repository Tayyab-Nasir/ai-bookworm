"""Publishing channel adapters (spec section 14). Export-first: validate + buildPackage
work locally; submit/getStatus raise NotSupportedError until official integrations exist.
"""
import hashlib
import json
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
            "findings": [f.to_dict() for f in findings],
        }

    def build_package(self, ctx: dict, artifacts: dict[str, bytes]) -> list[PackageArtifact]:
        """Deterministic export zip: rendered artifact(s) + manifest.json with sha256s,
        rule version, and channel. Fixed entry order, fixed timestamps."""
        result = self.validate(ctx)
        manifest = {
            "channel": self.CHANNEL,
            "ruleVersion": result["ruleVersion"],
            "errors": result["errors"],
            "files": {},
        }
        buf = BytesIO()
        names = sorted(artifacts)
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for name in names:
                data = artifacts[name]
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
