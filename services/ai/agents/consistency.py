"""Consistency agent (spec 12.1): reads the book + Book Bible and reports
name/date/character/fact conflicts as create_diagnostic findings (plus optional
propose_edit suggestions). Never mutates anything.
"""
from __future__ import annotations

from agents.base import BaseAgent


class ConsistencyAgent(BaseAgent):
    agent_type = "consistency"
    prompt_version = "v1"
    allowed_tools = ["propose_edit", "create_diagnostic"]
