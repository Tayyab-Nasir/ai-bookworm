"""Shared helpers for channel rule modules.

ALL channel thresholds are PLACEHOLDERS. Verify against current official retailer
documentation at release before shipping (spec section 14). effective_date records
when the placeholder was written; source_ref points at the doc to verify.
"""
from preflight import Finding, Rule, RuleSet, _meta


def metadata_rules(channel: str, prefix: str, required: list[str], effective_date: str,
                   source_ref: str) -> list[Rule]:
    def check(ctx, _required=required):
        md = _meta(ctx)
        return [
            Finding(code=f"{prefix}-META-MISSING",
                    message=f"{channel} requires metadata.{key}",
                    location=f"book.metadata.{key}")
            for key in _required
            if not (md.get(key) or "").strip() if isinstance(md.get(key), str) or md.get(key) is None
        ]

    return [Rule(f"{prefix}-META-001", "error", "channel",
                 f"{channel} required metadata", check,
                 channels=(channel,), effective_date=effective_date, source_ref=source_ref)]


def make_ruleset(channel: str, version: str, rules: list) -> RuleSet:
    return RuleSet(name=channel, version=version, rules=rules)
