"""Copy editor agent (P0): clarity and style suggestions.

Reads chapter + style guide + retrieval. Spec 12.1.
"""
from agents.base import BaseAgent


class CopyEditorAgent(BaseAgent):
    agent_type = "copyeditor"
    prompt_version = "v1"
    allowed_tools = ["get_chapter", "get_style_guide", "search_book", "propose_edit", "create_diagnostic"]
    max_suggestion_span = 400  # chars — sentence-level rewrites allowed


AGENTS = {}


def _register():
    from agents.proofreader import ProofreaderAgent as _P

    AGENTS[_P.agent_type] = _P
    AGENTS[CopyEditorAgent.agent_type] = CopyEditorAgent


_register()


def get_agent(agent_type: str, provider, executor, model: str) -> BaseAgent:
    if agent_type not in AGENTS:
        raise ValueError(f"unknown agentType {agent_type!r}; expected one of {sorted(AGENTS)}")
    return AGENTS[agent_type](provider, executor, model)
