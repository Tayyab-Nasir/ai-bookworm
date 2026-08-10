"""Consistency agent (spec 12.1): reads the book + Book Bible and reports
name/date/character/fact conflicts as create_diagnostic findings (plus optional
propose_edit suggestions). Never mutates anything.
"""
from __future__ import annotations

import json

from agents.base import BaseAgent, wrap_manuscript


class ConsistencyAgent(BaseAgent):
    agent_type = "consistency"
    prompt_version = "v1"
    allowed_tools = ["get_chapter", "search_book", "get_book_bible", "propose_edit", "create_diagnostic"]

    def build_user_message(self, request: dict) -> str:
        bible = self.executor.get_book_bible(None, None)
        parts = [
            "BOOK BIBLE (canonical facts; treat the manuscript as suspect when it disagrees):\n"
            + wrap_manuscript(json.dumps(bible, default=str))
        ]
        return "\n\n".join([*parts, super().build_user_message(request)])
