"""Proofreader agent (P0): grammar/spelling/punctuation.

Reads chapter + style guide. Small suggestions only: replace_text ops with
tight from/to spans. Spec 12.1.
"""
from agents.base import BaseAgent


class ProofreaderAgent(BaseAgent):
    agent_type = "proofreader"
    prompt_version = "v1"
    allowed_tools = ["get_chapter", "get_style_guide", "propose_edit"]
    max_suggestion_span = 120  # chars — small corrections only
