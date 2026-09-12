"""Versioned preflight registry. Channel modules record verification dates and sources."""
import importlib

from preflight import RuleSet

_REGISTRY: dict[str, str] = {
    "core": "rules.core_v1",
    "kdp": "rules.kdp_v1",
    "apple": "rules.apple_v1",
    "barnesnoble": "rules.bn_v1",
    "lulu": "rules.lulu_v1",
}


def load_ruleset(channel: str | None = None) -> RuleSet:
    """Core rules + channel rules if channel given."""
    core = importlib.import_module(_REGISTRY["core"]).RULESET
    rules = list(core.rules)
    version = core.version
    if channel:
        if channel not in _REGISTRY:
            raise KeyError(f"unknown channel {channel!r}; known: {sorted(_REGISTRY)}")
        mod = importlib.import_module(_REGISTRY[channel])
        rules += mod.RULESET.rules
        version = f"{core.version}+{mod.RULESET.version}"
    return RuleSet(name=f"core{'+' + channel if channel else ''}", version=version, rules=rules)


def rule_version(channel: str | None = None) -> str:
    return load_ruleset(channel).version
