"""Book Bible agent (spec 12.1): reads book chunks, emits structured entity
candidates {type, name, description, attributes, sourceRefs, confidence}.

Candidates come back as SUGGESTIONS only — this agent never writes to
book_bible_items. The caller persists them after human approval.
"""
from __future__ import annotations

import jsonschema

from agents.base import AgentValidationError, BaseAgent

TOOL_NAME = "propose_book_bible_candidates"

ENTITY_CANDIDATE_SCHEMA: dict = {
    "type": "object",
    "required": ["type", "name", "description", "attributes", "sourceRefs", "confidence"],
    "properties": {
        "type": {"type": "string", "enum": ["character", "place", "organization", "object", "event", "term"]},
        "name": {"type": "string", "minLength": 1},
        "description": {"type": "string"},
        "attributes": {"type": "object"},
        "sourceRefs": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["chapterId", "nodeId"],
                "properties": {
                    "chapterId": {"type": "string", "format": "uuid"},
                    "nodeId": {"type": "string"},
                    "textHash": {"type": "string"},
                },
                "additionalProperties": False,
            },
        },
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "additionalProperties": False,
}

TOOL_SCHEMA = {
    "name": TOOL_NAME,
    "description": (
        "Emit Book Bible entity candidates extracted from the book. Candidates are "
        "reviewed by a human before anything is stored; never state them as facts."
    ),
    "input_schema": {
        "type": "object",
        "required": ["candidates"],
        "properties": {"candidates": {"type": "array", "items": ENTITY_CANDIDATE_SCHEMA}},
        "additionalProperties": False,
    },
}


class BookBibleAgent(BaseAgent):
    agent_type = "book_bible"
    prompt_version = "v1"
    allowed_tools = [TOOL_NAME]

    def tool_schemas(self) -> list[dict]:
        return [*super().tool_schemas(), TOOL_SCHEMA]

    def validate_tool_call(self, call: dict) -> dict:
        if call.get("name") == TOOL_NAME:
            payload = call.get("input") or {}
            try:
                jsonschema.validate(payload, TOOL_SCHEMA["input_schema"])
            except jsonschema.ValidationError as e:
                raise AgentValidationError(f"{TOOL_NAME}: {e.message}") from e
            return payload
        return super().validate_tool_call(call)

    def handle_tool_payload(self, name: str, payload: dict, suggestions: list, diagnostics: list) -> None:
        if name == TOOL_NAME:
            for c in payload["candidates"]:
                suggestions.append({**c, "suggestionKind": "book_bible_candidate", "status": "pending"})
        else:
            super().handle_tool_payload(name, payload, suggestions, diagnostics)
