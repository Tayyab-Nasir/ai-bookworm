"""Agent tool schemas (spec section 12) + executor interface.

Schemas are JSON-schema dicts, one per spec tool. propose_edit's operation
must be a validated typed document operation (spec section 8 shape).
"""
from __future__ import annotations

from typing import Any

import jsonschema

UUID = {"type": "string", "format": "uuid"}

PROPOSE_EDIT_OPERATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["operationId", "type", "target", "payload", "expectedVersion"],
    "properties": {
        "operationId": {"type": "string"},
        "type": {
            "type": "string",
            # suggestion mode (spec 12.1): agents may only propose replace_text
            "enum": ["replace_text"],
        },
        "target": {
            "type": "object",
            "required": ["chapterId", "nodeId"],
            "properties": {"chapterId": UUID, "nodeId": {"type": "string"}},
        },
        "payload": {
            "type": "object",
            "required": ["from", "to", "text"],
            "properties": {
                "from": {"type": "integer", "minimum": 0},
                "to": {"type": "integer", "minimum": 0},
                "text": {"type": "string"},
            },
            "additionalProperties": False,
        },
        "source": {"type": "string", "enum": ["human", "ai"]},
        "sourceRef": {"type": ["string", "null"]},
        "expectedVersion": {"type": "integer"},
    },
    "additionalProperties": False,
}

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "get_chapter",
        "description": "Fetch the canonical structured chapter (nodes) by id.",
        "input_schema": {
            "type": "object",
            "required": ["chapterId"],
            "properties": {"chapterId": UUID},
            "additionalProperties": False,
        },
    },
    {
        "name": "search_book",
        "description": "Semantic retrieval over the book's chunks.",
        "input_schema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string"},
                "topK": {"type": "integer", "minimum": 1, "maximum": 50},
                "chapterIds": {"type": "array", "items": UUID},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_book_bible",
        "description": "Retrieve Book Bible entities/facts.",
        "input_schema": {
            "type": "object",
            "properties": {
                "types": {"type": "array", "items": {"type": "string"}},
                "query": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_style_guide",
        "description": "Retrieve the book's style policy.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "propose_edit",
        "description": "Propose a human-reviewable edit as a typed document operation.",
        "input_schema": {
            "type": "object",
            "required": ["chapterId", "nodeId", "operation", "rationale"],
            "properties": {
                "chapterId": UUID,
                "nodeId": {"type": "string"},
                "operation": PROPOSE_EDIT_OPERATION_SCHEMA,
                "rationale": {"type": "string"},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "create_diagnostic",
        "description": "Record a book-quality finding (no mutation).",
        "input_schema": {
            "type": "object",
            "required": ["severity", "code", "message", "location"],
            "properties": {
                "severity": {"type": "string", "enum": ["error", "warning", "info"]},
                "code": {"type": "string"},
                "message": {"type": "string"},
                "location": {
                    "type": "object",
                    "properties": {
                        "chapterId": UUID,
                        "nodeId": {"type": "string"},
                        "from": {"type": "integer"},
                        "to": {"type": "integer"},
                    },
                    "additionalProperties": False,
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_asset",
        "description": "Read approved asset metadata.",
        "input_schema": {
            "type": "object",
            "required": ["assetId"],
            "properties": {"assetId": UUID},
            "additionalProperties": False,
        },
    },
]

_SCHEMA_BY_NAME = {t["name"]: t["input_schema"] for t in TOOL_SCHEMAS}


class ToolValidationError(ValueError):
    pass


def validate_tool_input(name: str, payload: dict) -> dict:
    schema = _SCHEMA_BY_NAME.get(name)
    if schema is None:
        raise ToolValidationError(f"unknown tool {name!r}")
    try:
        jsonschema.validate(payload, schema)
    except jsonschema.ValidationError as e:
        raise ToolValidationError(f"{name}: {e.message}") from e
    return payload


class ToolExecutor:
    """Executes the read-side tools. Write-side tools (propose_edit,
    create_diagnostic) never mutate — they return validated suggestions."""

    def get_chapter(self, chapter_id: str) -> dict:
        raise NotImplementedError

    def search_book(self, query: str, top_k: int, chapter_ids: list[str] | None) -> list[dict]:
        raise NotImplementedError

    def get_book_bible(self, types: list[str] | None, query: str | None) -> list[dict]:
        raise NotImplementedError

    def get_style_guide(self) -> dict:
        raise NotImplementedError

    def get_asset(self, asset_id: str) -> dict:
        raise NotImplementedError


class PostgresBackedExecutor(ToolExecutor):
    """ponytail: stub — wire to Postgres (document_versions/style_guides/
    book_bible_items/assets, RLS-scoped) when the AI service gains DB access."""

    def __init__(self, workspace_id: str, book_id: str):
        self.workspace_id = workspace_id
        self.book_id = book_id

    def _todo(self) -> NotImplementedError:
        return NotImplementedError(
            "TODO: wire to Postgres (workspace/book-scoped query); see migration 0002-0004 tables"
        )

    def get_chapter(self, chapter_id: str) -> dict:
        raise self._todo()

    def search_book(self, query: str, top_k: int, chapter_ids: list[str] | None) -> list[dict]:
        raise self._todo()  # TODO: Qdrant book_chunks, Step 8

    def get_book_bible(self, types: list[str] | None, query: str | None) -> list[dict]:
        raise self._todo()

    def get_style_guide(self) -> dict:
        raise self._todo()

    def get_asset(self, asset_id: str) -> dict:
        raise self._todo()


class InMemoryExecutor(ToolExecutor):
    """Test/eval executor backed by plain dicts."""

    def __init__(
        self,
        chapters: dict[str, dict] | None = None,
        style_guide: dict | None = None,
        bible: list[dict] | None = None,
        assets: dict[str, dict] | None = None,
        search_results: list[dict] | None = None,
    ):
        self.chapters = chapters or {}
        self.style_guide = style_guide or {}
        self.bible = bible or []
        self.assets = assets or {}
        self.search_results = search_results or []

    def get_chapter(self, chapter_id: str) -> dict:
        if chapter_id not in self.chapters:
            raise KeyError(f"chapter {chapter_id} not found")
        return self.chapters[chapter_id]

    def search_book(self, query: str, top_k: int, chapter_ids: list[str] | None) -> list[dict]:
        return self.search_results[:top_k]

    def get_book_bible(self, types: list[str] | None, query: str | None) -> list[dict]:
        if not types:
            return self.bible
        return [e for e in self.bible if e.get("type") in types]

    def get_style_guide(self) -> dict:
        return self.style_guide

    def get_asset(self, asset_id: str) -> dict:
        if asset_id not in self.assets:
            raise KeyError(f"asset {asset_id} not found")
        return self.assets[asset_id]
