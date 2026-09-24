"""Book Bible agent (spec 12.1): reads book chunks, emits structured entity
candidates {type, name, description, attributes, sourceRefs, confidence}.

Candidates come back as SUGGESTIONS only — this agent never writes to
book_bible_items. The caller persists them after human approval.
"""
from __future__ import annotations

import json
import jsonschema

from agents.base import AgentValidationError, BaseAgent

TOOL_NAME = "propose_book_bible_candidates"

ENTITY_CANDIDATE_SCHEMA: dict = {
    "type": "object",
    "required": ["type", "name", "description", "attributes", "sourceRefs", "confidence"],
    "properties": {
        "type": {"type": "string", "enum": ["character", "place", "organization", "object", "event", "term"]},
        "name": {"type": "string", "minLength": 1, "maxLength": 160},
        "description": {"type": "string", "maxLength": 12000},
        "attributes": {"type": "object", "maxProperties": 40, "propertyNames": {"minLength": 1, "maxLength": 80}},
        "sourceRefs": {
            "type": "array",
            "minItems": 1,
            "maxItems": 30,
            "items": {
                "type": "object",
                "required": ["chapterId", "documentVersionId", "nodeId", "textHash"],
                "properties": {
                    "chapterId": {"type": "string", "format": "uuid"},
                    "documentVersionId": {"type": "string", "format": "uuid"},
                    "nodeId": {"type": "string", "minLength": 1, "maxLength": 200},
                    "textHash": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
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
        "properties": {"candidates": {"type": "array", "maxItems": 10, "items": ENTITY_CANDIDATE_SCHEMA}},
        "additionalProperties": False,
    },
}


class BookBibleAgent(BaseAgent):
    agent_type = "book_bible"
    prompt_version = "v2"
    allowed_tools = [TOOL_NAME]
    max_output_tokens = 6000

    def __init__(self, provider, executor, model: str = "mock-1"):
        super().__init__(provider, executor, model)
        self._evidence_refs: set[tuple[str, str, str, str]] = set()

    def build_user_message(self, request: dict) -> str:
        self._evidence_refs = set()
        for chapter_id in request.get("chapterIds") or []:
            chapter = self.executor.get_chapter(chapter_id)
            version_id = chapter.get("documentVersionId") or chapter.get("document_version_id")
            for node in chapter.get("nodes", []):
                node_id = node.get("id")
                text_hash = node.get("textHash") or node.get("text_hash")
                if all(isinstance(value, str) and value for value in (chapter_id, version_id, node_id, text_hash)):
                    self._evidence_refs.add((chapter_id, version_id, node_id, text_hash))
        message = super().build_user_message(request)
        # Related search and existing Bible entries may inform wording, but
        # generated facts must cite the selected, version-pinned manuscript.
        self._evidence_refs = {
            ref for ref in self._evidence_refs
            if all(value in message for value in ref)
        }
        if not self._evidence_refs:
            raise AgentValidationError("Book Bible extraction needs versioned, hashed manuscript nodes")
        return message

    def tool_schemas(self) -> list[dict]:
        return [*super().tool_schemas(), TOOL_SCHEMA]

    def validate_tool_call(self, call: dict) -> dict:
        if call.get("name") == TOOL_NAME:
            payload = call.get("input") or {}
            try:
                jsonschema.validate(payload, TOOL_SCHEMA["input_schema"], format_checker=jsonschema.FormatChecker())
            except jsonschema.ValidationError as e:
                raise AgentValidationError(f"{TOOL_NAME}: {e.message}") from e
            for candidate in payload["candidates"]:
                if candidate["name"] != candidate["name"].strip() or candidate["description"] != candidate["description"].strip():
                    raise AgentValidationError(f"{TOOL_NAME}: name and description must be trimmed")
                attrs = candidate["attributes"]
                if len(json.dumps(attrs, ensure_ascii=False)) > 24000 or any(
                    key in attrs for key in ("imageAssetIds", "__proto__", "constructor", "prototype")
                ):
                    raise AgentValidationError(f"{TOOL_NAME}: attributes exceed the Book Bible storage contract")
                for ref in candidate["sourceRefs"]:
                    cited = (ref["chapterId"], ref["documentVersionId"], ref["nodeId"], ref["textHash"])
                    if cited not in self._evidence_refs:
                        raise AgentValidationError(f"{TOOL_NAME}: sourceRef was not present in the selected manuscript evidence")
            return payload
        return super().validate_tool_call(call)

    def handle_tool_payload(self, name: str, payload: dict, suggestions: list, diagnostics: list) -> None:
        if name == TOOL_NAME:
            for c in payload["candidates"]:
                suggestions.append({**c, "suggestionKind": "book_bible_candidate", "status": "pending"})
        else:
            super().handle_tool_payload(name, payload, suggestions, diagnostics)
