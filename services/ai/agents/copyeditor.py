"""Copy editor agent (P0): clarity and style suggestions.

Reads chapter + style guide + retrieval. Spec 12.1.
"""
from agents.base import BaseAgent


class CopyEditorAgent(BaseAgent):
    agent_type = "copyeditor"
    prompt_version = "v1"
    allowed_tools = ["propose_edit", "create_diagnostic"]
    max_suggestion_span = 400  # chars — sentence-level rewrites allowed


AGENTS = {}


def _register():
    from agents.bookbible import BookBibleAgent as _B
    from agents.consistency import ConsistencyAgent as _C
    from agents.metadata import MetadataAgent as _M
    from agents.proofreader import ProofreaderAgent as _P
    from agents.story_blueprint import StoryBlueprintAgent as _SB
    from agents.writer import WriterAgent as _W

    AGENTS[_P.agent_type] = _P
    AGENTS[CopyEditorAgent.agent_type] = CopyEditorAgent
    AGENTS[_B.agent_type] = _B
    AGENTS[_C.agent_type] = _C
    AGENTS[_W.agent_type] = _W
    AGENTS[_M.agent_type] = _M
    AGENTS[_SB.agent_type] = _SB


_register()


def get_agent(agent_type: str, provider, executor, model: str) -> BaseAgent:
    if agent_type not in AGENTS:
        raise ValueError(f"unknown agentType {agent_type!r}; expected one of {sorted(AGENTS)}")
    return AGENTS[agent_type](provider, executor, model)
