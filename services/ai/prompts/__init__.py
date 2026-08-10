"""Versioned prompt loader. Each prompt file has `version: <name>` frontmatter;
the loader refuses unknown agent/version pairs."""
from pathlib import Path

_PROMPTS_DIR = Path(__file__).resolve().parent


def load_prompt(agent_type: str, version: str) -> str:
    path = _PROMPTS_DIR / f"{agent_type}_{version}.md"
    if not path.is_file():
        raise ValueError(f"unknown prompt {agent_type}_{version}; file {path.name} not found")
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError(f"prompt {path.name} missing frontmatter")
    try:
        end = lines.index("---", 1)
        meta = dict(
            line.split(":", 1) for line in lines[1:end] if ":" in line
        )
    except ValueError as e:
        raise ValueError(f"prompt {path.name} malformed frontmatter") from e
    declared = meta.get("version", "").strip()
    if declared != version:
        raise ValueError(f"prompt {path.name} declares version {declared!r}, expected {version!r}")
    return "\n".join(lines[end + 1:]).strip()
