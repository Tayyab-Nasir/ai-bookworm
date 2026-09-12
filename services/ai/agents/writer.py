"""Drafting agent: generates or rewrites one reviewable chapter-node span."""

from agents.base import BaseAgent


class WriterAgent(BaseAgent):
    agent_type = "writer"
    prompt_version = "v1"
    allowed_tools = ["propose_edit"]
    max_suggestion_span = 20000
