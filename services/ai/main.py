"""AI gateway/agents service (Step 7).

Jobs run synchronously in-process for now. OpenAI is the production default;
tests select the deterministic mock provider explicitly.
"""
from __future__ import annotations

import uuid
import os
import hashlib
import json
from hmac import compare_digest
from typing import Literal

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from agents.base import AgentValidationError
from agents.copyeditor import get_agent
from gateway import ProviderOutcomeUnknown, default_model, get_provider, openai_tools
from tools import InMemoryExecutor
from result_store import AiReviewResultStore, MetadataResultStore, ReceiptUnavailable, ReceiptConflict

app = FastAPI(title="bookworm-ai")


class ContextPolicy(BaseModel):
    includeBookBible: bool = False
    includeStyleGuide: bool = True
    includeRelatedContext: bool = True
    semanticTopK: int = Field(default=5, ge=1, le=20)
    maxTokens: int = Field(default=4096, ge=256, le=16000)


class AgentInput(BaseModel):
    chapterIds: list[str] = Field(default_factory=list)
    chapters: dict[str, dict] = Field(default_factory=dict)  # API-scoped canonical content
    book: dict = Field(default_factory=dict)  # API-scoped identity; treated as untrusted author data
    styleGuide: dict = Field(default_factory=dict)
    bookBible: list[dict] = Field(default_factory=list)  # approved items supplied by the API
    relatedContext: list[dict] = Field(default_factory=list, max_length=20)
    storyBlueprint: dict = Field(default_factory=dict)  # saved, API-scoped planning snapshot
    userInstruction: str | None = None


class CreateAiJobRequest(BaseModel):
    jobId: uuid.UUID | None = None
    workspaceId: str = Field(min_length=1)
    bookId: str = Field(min_length=1)
    agentType: Literal["proofreader", "copyeditor", "bookbible", "consistency", "writer", "metadata", "story_blueprint"]
    input: AgentInput = Field(default_factory=AgentInput)
    idempotencyKey: str = Field(min_length=1)
    contextPolicy: ContextPolicy = Field(default_factory=ContextPolicy)
    model: str | None = Field(default=None, min_length=1, max_length=128)
    maxOutputTokens: int | None = Field(default=None, ge=1, le=128000)
    # A quoted Story Blueprint job binds the exact provider input (including
    # tool schema and output bound) before any paid completion is dispatched.
    expectedInputSha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class StoryBlueprintQuoteRequest(BaseModel):
    jobId: uuid.UUID
    workspaceId: str = Field(min_length=1)
    bookId: str = Field(min_length=1)
    model: str = Field(min_length=1, max_length=128)
    maxOutputTokens: int = Field(ge=1, le=128000)
    input: AgentInput
    contextPolicy: ContextPolicy = Field(default_factory=ContextPolicy)


# ponytail: in-memory stores — replace with Postgres ai_jobs/ai_suggestions/ai_runs
# tables (migration 0004_ai) when the service gets DB access; keys already unique there.
_JOBS: dict[str, dict] = {}
_JOBS_BY_IDEMPOTENCY: dict[str, str] = {}
_SUGGESTIONS: dict[str, dict] = {}


def authorize_service(token: str | None) -> None:
    expected = os.environ.get("AI_SERVICE_TOKEN", "").strip()
    # A real provider endpoint must never be reachable merely because an
    # operator forgot to configure its internal service credential. Explicit
    # deterministic mock tests are the only credential-free mode.
    if not expected:
        if os.environ.get("DEFAULT_AI_PROVIDER", "openai").strip() == "mock":
            return
        raise HTTPException(status_code=503, detail="AI service authentication is not configured.")
    if not token or not compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="invalid service token")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/v1/ai/jobs", status_code=201)
def create_job(req: CreateAiJobRequest, x_service_token: str | None = Header(default=None)) -> dict:
    authorize_service(x_service_token)
    provider = get_provider()  # Missing production provider credentials fail closed.
    receipt_store = None
    fingerprint = None
    durable_type = req.agentType in {"metadata", "writer", "proofreader", "copyeditor", "consistency"}
    if durable_type and (provider.name != "mock" or os.environ.get("AI_RESULT_STORE") == "supabase"):
        if req.jobId is None:
            raise HTTPException(status_code=422, detail="Durable AI generation requires a saved job ID.")
        fingerprint = hashlib.sha256(json.dumps(req.model_dump(mode="json"), sort_keys=True,
                                               separators=(",", ":")).encode()).hexdigest()
        try:
            receipt_store = MetadataResultStore() if req.agentType == "metadata" else AiReviewResultStore()
            existing = receipt_store.reserve(req.jobId, fingerprint)
            if existing is not None:
                return existing
        except ReceiptConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ReceiptUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    if req.idempotencyKey in _JOBS_BY_IDEMPOTENCY:
        if receipt_store is None:
            return _JOBS[_JOBS_BY_IDEMPOTENCY[req.idempotencyKey]]

    job_id = str(req.jobId or uuid.uuid4())
    job = {
        "jobId": job_id,
        "workspaceId": req.workspaceId,
        "bookId": req.bookId,
        "agentType": req.agentType,
        "status": "queued",
        "suggestions": [],
        "diagnostics": [],
        "usage": {"inputTokens": 0, "outputTokens": 0, "estimatedCostUsd": 0.0},
    }

    model = req.model or default_model(provider.name)
    job.update({"provider": provider.name, "model": model})
    executor = InMemoryExecutor(
        chapters=req.input.chapters, style_guide=req.input.styleGuide, bible=req.input.bookBible,
        search_results=req.input.relatedContext,
    )
    try:
        agent = get_agent(req.agentType, provider, executor, model)
        agent.max_output_tokens = req.maxOutputTokens
        agent_request = {
            "workspaceId": req.workspaceId,
            "bookId": req.bookId,
            "chapterIds": req.input.chapterIds,
            "book": req.input.book,
            "storyBlueprint": req.input.storyBlueprint,
            "userInstruction": req.input.userInstruction,
            "contextPolicy": req.contextPolicy.model_dump(),
        }
        if req.agentType == "story_blueprint":
            if provider.name != "openai":
                raise HTTPException(status_code=503, detail="Story blueprint generation is not configured.")
            if req.maxOutputTokens is None:
                raise HTTPException(status_code=422, detail="Story Blueprint generation requires a quoted output bound.")
            if req.expectedInputSha256 is None:
                raise HTTPException(status_code=422, detail="Story Blueprint generation requires its quoted request hash.")
            messages, tools, tool_choice = agent.provider_request(agent_request)
            canonical_request = {
                "model": model,
                "input": messages,
                "tools": openai_tools(tools),
                "tool_choice": tool_choice,
                "max_output_tokens": req.maxOutputTokens,
            }
            actual_hash = canonical_story_blueprint_request_hash(canonical_request)
            if not compare_digest(actual_hash, req.expectedInputSha256):
                raise HTTPException(status_code=409, detail="Story Blueprint request no longer matches its funded quote.")
        result = agent.run(agent_request, job_id=job_id)
    except ProviderOutcomeUnknown as e:
        # Leave the durable reservation unresolved. A 503 is not proof the
        # provider did no work and must not become a failed/free result.
        raise HTTPException(status_code=503, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    job.update(result.to_dict())
    if receipt_store is not None:
        try:
            receipt_store.save(job_id, fingerprint, job)
        except ReceiptUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    # Only document-edit suggestions have an apply endpoint and durable ID in
    # this service. Review-only outputs (for example metadata candidates) are
    # returned with their job and must never be routed through the editor
    # mutation path.
    for suggestion in job["suggestions"]:
        suggestion_id = suggestion.get("id")
        if isinstance(suggestion_id, str) and suggestion_id:
            _SUGGESTIONS[suggestion_id] = {**suggestion, "jobId": job_id}
    _JOBS[job_id] = job
    _JOBS_BY_IDEMPOTENCY[req.idempotencyKey] = job_id
    return job


def canonical_story_blueprint_request_hash(request: dict) -> str:
    return hashlib.sha256(json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def story_blueprint_generation_request(req: StoryBlueprintQuoteRequest, provider=None) -> dict:
    """Canonical provider request. Its hash is bound to the funded quote."""
    provider = provider or get_provider()
    if provider.name != "openai":
        raise HTTPException(status_code=503, detail="Story blueprint generation is not configured.")
    executor = InMemoryExecutor(
        chapters=req.input.chapters, style_guide=req.input.styleGuide, bible=req.input.bookBible,
        search_results=req.input.relatedContext,
    )
    agent = get_agent("story_blueprint", provider, executor, req.model)
    agent.max_output_tokens = req.maxOutputTokens
    messages, tools, tool_choice = agent.provider_request({
        "workspaceId": req.workspaceId,
        "bookId": req.bookId,
        "chapterIds": req.input.chapterIds,
        "book": req.input.book,
        "storyBlueprint": req.input.storyBlueprint,
        "userInstruction": req.input.userInstruction,
        "contextPolicy": req.contextPolicy.model_dump(),
    })
    return {
        "model": req.model,
        "input": messages,
        "tools": openai_tools(tools),
        "tool_choice": tool_choice,
        "max_output_tokens": req.maxOutputTokens,
    }


def count_story_blueprint_input(request: dict) -> int:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OpenAI credentials unavailable")
    from openai import OpenAI

    response = OpenAI(api_key=api_key, max_retries=0, timeout=20).responses.input_tokens.count(
        model=request["model"], input=request["input"], tools=request["tools"], tool_choice=request["tool_choice"],
    )
    value = getattr(response, "input_tokens", None)
    if not isinstance(value, int) or value < 1:
        raise RuntimeError("invalid input token count")
    return value


@app.post("/v1/ai/story-blueprint/request-hash")
def verify_story_blueprint_request_hash(req: StoryBlueprintQuoteRequest, x_service_token: str | None = Header(default=None)) -> dict:
    """Build the exact provider request without contacting OpenAI.

    The leased API worker calls this immediately before the irreversible
    dispatch marker. A changed prompt, source snapshot, output bound, or model
    therefore fails before a provider request or credit settlement can start.
    """
    authorize_service(x_service_token)
    try:
        request = story_blueprint_generation_request(req)
    except HTTPException:
        raise
    except AgentValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Could not verify Story Blueprint request identity. No generation was started.") from exc
    return {"inputSha256": canonical_story_blueprint_request_hash(request), "model": req.model}


@app.post("/v1/ai/story-blueprint/quote")
def count_story_blueprint_quote(req: StoryBlueprintQuoteRequest, x_service_token: str | None = Header(default=None)) -> dict:
    authorize_service(x_service_token)
    try:
        request = story_blueprint_generation_request(req)
        input_tokens = count_story_blueprint_input(request)
    except HTTPException:
        raise
    except AgentValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Could not verify story blueprint token count. No generation was started.") from exc
    fingerprint = canonical_story_blueprint_request_hash(request)
    return {"inputTokens": input_tokens, "inputSha256": fingerprint, "model": req.model}


@app.get("/v1/ai/jobs/{job_id}")
def get_job(job_id: str, x_service_token: str | None = Header(default=None)) -> dict:
    authorize_service(x_service_token)
    if job_id not in _JOBS:
        if os.environ.get("DEFAULT_AI_PROVIDER") != "mock" or os.environ.get("AI_RESULT_STORE") == "supabase":
            try:
                uuid.UUID(job_id)
            except ValueError:
                raise HTTPException(status_code=404, detail="job not found")
            try:
                for store in (MetadataResultStore, AiReviewResultStore):
                    result = store().load(job_id)
                    if isinstance(result, dict):
                        return result
            except ReceiptUnavailable as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
        raise HTTPException(status_code=404, detail="job not found")
    return _JOBS[job_id]


@app.post("/v1/ai/suggestions/{suggestion_id}/apply")
def apply_suggestion(suggestion_id: str, x_service_token: str | None = Header(default=None)) -> dict:
    """Validate + mark accepted; return the operation for the API caller to
    submit to POST /v1/chapters/{chapterId}/operations. This service never
    mutates the document itself (spec: default read-only + suggestion mode)."""
    authorize_service(x_service_token)
    s = _SUGGESTIONS.get(suggestion_id)
    if s is None:
        raise HTTPException(status_code=404, detail="suggestion not found")
    if s["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"suggestion already {s['status']}")
    from tools import validate_tool_input  # re-validate before handing out

    validate_tool_input("propose_edit", {k: s[k] for k in ("chapterId", "nodeId", "operation", "rationale", "confidence") if s.get(k) is not None})
    s["status"] = "accepted"
    return {"suggestionId": suggestion_id, "status": "accepted", "operation": s["operation"]}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
