"""Evidence-grounded, review-only book metadata generation.

The metadata agent emits exactly one structured candidate. It never changes
saved metadata. Source references are accepted only when they identify chapter,
retrieval, or author-approved Book Bible evidence that was actually supplied in
the bounded prompt.
"""
from __future__ import annotations

from typing import Any

from agents.base import AgentResult, AgentValidationError, BaseAgent
from tools import ToolValidationError, validate_tool_input

TOOL_NAME = "propose_metadata"
_REF_KEYS = ("chapterId", "documentVersionId", "nodeId", "textHash")


def _value(source: dict, camel: str, snake: str) -> Any:
    value = source.get(camel)
    return value if value is not None else source.get(snake)


def _normalized_ref(source: object) -> dict[str, str] | None:
    if not isinstance(source, dict):
        return None
    chapter_id = _value(source, "chapterId", "chapter_id")
    node_id = _value(source, "nodeId", "node_id")
    if not isinstance(chapter_id, str) or not isinstance(node_id, str):
        return None
    ref = {"chapterId": chapter_id, "nodeId": node_id}
    document_version_id = _value(source, "documentVersionId", "document_version_id")
    text_hash = _value(source, "textHash", "text_hash")
    if isinstance(document_version_id, str):
        ref["documentVersionId"] = document_version_id
    if isinstance(text_hash, str):
        ref["textHash"] = text_hash
    return ref


class MetadataAgent(BaseAgent):
    agent_type = "metadata"
    prompt_version = "v1"
    allowed_tools = [TOOL_NAME]

    def __init__(self, provider, executor, model: str = "mock-1"):
        super().__init__(provider, executor, model)
        self._evidence_refs: list[dict[str, str]] = []

    def _remember_ref(self, source: object) -> None:
        ref = _normalized_ref(source)
        if ref is not None and ref not in self._evidence_refs:
            self._evidence_refs.append(ref)

    def build_user_message(self, request: dict) -> str:
        # Collect only references from inputs that BaseAgent will place in the
        # prompt. The provider may cite a less-specific version of a known ref,
        # but may never invent a version or hash absent from that evidence.
        self._evidence_refs = []
        for chapter_id in request.get("chapterIds") or []:
            chapter = self.executor.get_chapter(chapter_id)
            chapter_version = _value(chapter, "documentVersionId", "document_version_id")
            for node in chapter.get("nodes", []):
                evidence = {
                    "chapterId": chapter_id,
                    "nodeId": node.get("id"),
                    "documentVersionId": chapter_version,
                    "textHash": _value(node, "textHash", "text_hash"),
                }
                self._remember_ref(evidence)

        policy = request.get("contextPolicy", {})
        if policy.get("includeBookBible", False):
            for item in self.executor.get_book_bible(None, None):
                refs = item.get("sourceRefs") or item.get("source_refs_json") or []
                for ref in refs if isinstance(refs, list) else []:
                    self._remember_ref(ref)
        if policy.get("includeRelatedContext", True):
            top_k = min(int(policy.get("semanticTopK", 5)), 20)
            for source in self.executor.search_book(request.get("userInstruction") or "", top_k, None):
                self._remember_ref(source)

        message = super().build_user_message(request)
        visible_refs: list[dict[str, str]] = []
        for ref in self._evidence_refs:
            if ref["chapterId"] not in message or ref["nodeId"] not in message:
                continue
            visible = {"chapterId": ref["chapterId"], "nodeId": ref["nodeId"]}
            for key in ("documentVersionId", "textHash"):
                value = ref.get(key)
                if value and value in message:
                    visible[key] = value
            if visible not in visible_refs:
                visible_refs.append(visible)
        self._evidence_refs = visible_refs
        return message

    def tool_schemas(self) -> list[dict]:
        from tools import TOOL_SCHEMAS

        return [tool for tool in TOOL_SCHEMAS if tool["name"] == TOOL_NAME]

    def validate_tool_call(self, call: dict) -> dict:
        if call.get("name") != TOOL_NAME:
            raise AgentValidationError(f"tool {call.get('name', '')!r} not allowed for agent {self.agent_type}")
        try:
            payload = validate_tool_input(TOOL_NAME, call.get("input") or {})
        except ToolValidationError as error:
            raise AgentValidationError(str(error)) from error

        for field in ("description", "audience", "rationale"):
            if payload[field] != payload[field].strip():
                raise AgentValidationError(f"{TOOL_NAME}: {field} must not have leading or trailing whitespace")
        for field in ("keywords", "categories"):
            values = payload[field]
            if any(value != value.strip() for value in values):
                raise AgentValidationError(f"{TOOL_NAME}: {field} entries must be trimmed")
            if len({value.casefold() for value in values}) != len(values):
                raise AgentValidationError(f"{TOOL_NAME}: {field} entries must be unique ignoring case")

        for source_ref in payload["sourceRefs"]:
            if not any(self._ref_matches_evidence(source_ref, evidence) for evidence in self._evidence_refs):
                raise AgentValidationError(
                    f"{TOOL_NAME}: sourceRef {source_ref['chapterId']}/{source_ref['nodeId']} "
                    "was not present in the supplied evidence"
                )
        return payload

    @staticmethod
    def _ref_matches_evidence(candidate: dict[str, str], evidence: dict[str, str]) -> bool:
        if candidate["chapterId"] != evidence.get("chapterId") or candidate["nodeId"] != evidence.get("nodeId"):
            return False
        return all(key not in candidate or candidate[key] == evidence.get(key) for key in _REF_KEYS[1:])

    def handle_tool_payload(self, name: str, payload: dict, suggestions: list, diagnostics: list) -> None:
        if name == TOOL_NAME:
            suggestions.append({
                **payload,
                "suggestionKind": "metadata_candidate",
                "status": "pending",
            })
            return
        super().handle_tool_payload(name, payload, suggestions, diagnostics)

    def _run(self, request: dict, job_id: str) -> AgentResult:
        result = super()._run(request, job_id)
        if len(result.suggestions) != 1:
            raise AgentValidationError("metadata agent must emit exactly one metadata candidate")
        return result
