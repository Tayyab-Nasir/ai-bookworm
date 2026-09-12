"""Shared helpers for channel rule modules."""
from preflight import Finding, Rule, RuleSet, _meta


def metadata_rules(channel: str, prefix: str, required: list[str], effective_date: str,
                   source_ref: str) -> list[Rule]:
    def check(ctx, _required=required):
        md = _meta(ctx)
        def missing(value):
            return value is None or (isinstance(value, str) and not value.strip()) or (isinstance(value, list) and not value)
        return [
            Finding(code=f"{prefix}-META-MISSING",
                    message=f"{channel} requires metadata.{key}",
                    location=f"book.metadata.{key}")
            for key in _required
            if missing(md.get(key))
        ]

    return [Rule(f"{prefix}-META-001", "error", "channel",
                 f"{channel} required metadata", check,
                 channels=(channel,), effective_date=effective_date, source_ref=source_ref)]


def make_ruleset(channel: str, version: str, rules: list) -> RuleSet:
    return RuleSet(name=channel, version=version, rules=rules)
