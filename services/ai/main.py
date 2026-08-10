"""AI gateway/agents service (Step 7).

Jobs run synchronously in-process for now. Uses MockProvider automatically
when no provider API key is configured, so the service is fully usable
in tests/dev without credentials.
"""
from __future__ import annotations

import uuid

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from agents.copyeditor import get_agent
from gateway import default_model, get_provider
from tools import InMemoryExecutor

app = FastAPI(title="bookworm-ai")


class ContextPolicy(BaseModel):
    includeBookBible: bool = False
    includeStyleGuide: bool = True
    semanticTopK: int = 5
    maxTokens: int = 4096


class AgentInput(BaseModel):
    chapterIds: list[str] = []
    chapters: dict[str, dict] = {}  # inline chapter content (until Postgres wiring)
    styleGuide: dict = {}
    userInstruction: str | None = None


class CreateAiJobRequest(BaseModel):
    workspaceId: str = Field(min_length=1)
    bookId: str = Field(min_length=1)
    agentType: str = Field(min_length=1)
    input: AgentInput = AgentInput()
    idempotencyKey: str = Field(min_length=1)
    contextPolicy: ContextPolicy = ContextPolicy()


# ponytail: in-memory stores — replace with Postgres ai_jobs/ai_suggestions/ai_runs
# tables (migration 0004_ai) when the service gets DB access; keys already unique there.
_JOBS: dict[str, dict] = {}
_JOBS_BY_IDEMPOTENCY: dict[str, str] = {}
_SUGGESTIONS: dict[str, dict] = {}


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/v1/ai/jobs", status_code=201)
def create_job(req: CreateAiJobRequest) -> dict:
    if req.idempotencyKey in _JOBS_BY_IDEMPOTENCY:
        return _JOBS[_JOBS_BY_IDEMPOTENCY[req.idempotencyKey]]

    job_id = str(uuid.uuid4())
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

    provider = get_provider()  # mock when no API key configured
    executor = InMemoryExecutor(chapters=req.input.chapters, style_guide=req.input.styleGuide)
    try:
        agent = get_agent(req.agentType, provider, executor, default_model(provider.name))
        result = agent.run(
            {
                "workspaceId": req.workspaceId,
                "bookId": req.bookId,
                "chapterIds": req.input.chapterIds,
                "userInstruction": req.input.userInstruction,
                "contextPolicy": req.contextPolicy.model_dump(),
            },
            job_id=job_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    job.update(result.to_dict())
    for s in job["suggestions"]:
        _SUGGESTIONS[s["id"]] = {**s, "jobId": job_id}
    _JOBS[job_id] = job
    _JOBS_BY_IDEMPOTENCY[req.idempotencyKey] = job_id
    return job


@app.get("/v1/ai/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    if job_id not in _JOBS:
        raise HTTPException(status_code=404, detail="job not found")
    return _JOBS[job_id]


@app.post("/v1/ai/suggestions/{suggestion_id}/apply")
def apply_suggestion(suggestion_id: str) -> dict:
    """Validate + mark accepted; return the operation for the API caller to
    submit to POST /v1/chapters/{chapterId}/operations. This service never
    mutates the document itself (spec: default read-only + suggestion mode)."""
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
