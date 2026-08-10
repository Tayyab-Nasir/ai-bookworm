"""Deterministic preflight rule engine (PRD section 19).

Rule sets are versioned under rules/ (core_v1 + per-channel). Channel rules are
placeholders with effective_date + source_ref that MUST be verified against current
official retailer documentation at release time — never treat as permanent requirements.

Findings are deterministic: rules run in id order, findings sorted by (rule_id, location).
"""
import io
import re
import zipfile
from dataclasses import dataclass, field
from typing import Callable, Literal

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


def _open_epub(ctx: dict) -> zipfile.ZipFile | None:
    blob = ctx.get("artifact")
    if not blob:
        return None
    try:
        return zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        return None


def _meta(ctx: dict) -> dict:
    return ctx["book"].get("metadata", {})
