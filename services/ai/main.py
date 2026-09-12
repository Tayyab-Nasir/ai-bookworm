"""AI gateway/agents service (Step 7).

Jobs run synchronously in-process for now. OpenAI is the production default;
tests select the deterministic mock provider explicitly.
"""
from __future__ import annotations

import uuid
import os
from hmac import compare_digest
from typing import Literal

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from agents.copyeditor import get_agent
from gateway import default_model, get_provider
from tools import InMemoryExecutor

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
    userInstruction: str | None = None


class CreateAiJobRequest(BaseModel):
    jobId: uuid.UUID | None = None
    workspaceId: str = Field(min_length=1)
    bookId: str = Field(min_length=1)
    agentType: Literal["proofreader", "copyeditor", "bookbible", "consistency", "writer", "metadata"]
    input: AgentInput = Field(default_factory=AgentInput)
    idempotencyKey: str = Field(min_length=1)
    contextPolicy: ContextPolicy = Field(default_factory=ContextPolicy)


# ponytail: in-memory stores — replace with Postgres ai_jobs/ai_suggestions/ai_runs
# tables (migration 0004_ai) when the service gets DB access; keys already unique there.
_JOBS: dict[str, dict] = {}
_JOBS_BY_IDEMPOTENCY: dict[str, str] = {}
_SUGGESTIONS: dict[str, dict] = {}


def authorize_service(token: str | None) -> None:
    expected = os.environ.get("AI_SERVICE_TOKEN", "")
    if expected and (not token or not compare_digest(token, expected)):
        raise HTTPException(status_code=401, detail="invalid service token")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/v1/ai/jobs", status_code=201)
def create_job(req: CreateAiJobRequest, x_service_token: str | None = Header(default=None)) -> dict:
    authorize_service(x_service_token)
    if req.idempotencyKey in _JOBS_BY_IDEMPOTENCY:
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

    provider = get_provider()  # production default is OpenAI; missing keys fail closed
    model = default_model(provider.name)
    job.update({"provider": provider.name, "model": model})
    executor = InMemoryExecutor(
        chapters=req.input.chapters, style_guide=req.input.styleGuide, bible=req.input.bookBible,
        search_results=req.input.relatedContext,
    )
    try:
        agent = get_agent(req.agentType, provider, executor, model)
        result = agent.run(
            {
                "workspaceId": req.workspaceId,
                "bookId": req.bookId,
                "chapterIds": req.input.chapterIds,
                "book": req.input.book,
                "userInstruction": req.input.userInstruction,
                "contextPolicy": req.contextPolicy.model_dump(),
            },
            job_id=job_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    job.update(result.to_dict())
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


@app.get("/v1/ai/jobs/{job_id}")
def get_job(job_id: str, x_service_token: str | None = Header(default=None)) -> dict:
    authorize_service(x_service_token)
    if job_id not in _JOBS:
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
