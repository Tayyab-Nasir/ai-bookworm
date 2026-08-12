"""P0 critical journey, service-level E2E (PRD section 28 / Step 15).

Drives all four FastAPI services via TestClient (in-process, no ports):
create book payload -> document parse (import) -> AI job (mock provider) ->
apply suggestion -> render EPUB -> deterministic preflight -> idempotent
export job. Auth failure paths of the TS API live in
services/api/src/app.test.ts (fake Supabase); the Python services sit behind
that API in production (known gap: they carry no auth middleware of their
own yet — see docs/release-checklist.md).

Run: pytest tests/e2e -q
"""
from __future__ import annotations

import base64
import importlib
import sys
from pathlib import Path

from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]

# Each service uses flat imports (from agents..., from parsers...); its dir
# must precede shadowed module names (main, rules). Order is collision-safe:
# ai (agents/gateway/prompts/tools) -> publishing (adapters; its main inserts
# rendering before itself) -> rendering (editions/*_renderer/preflight/rules)
# -> document (parsers).
for rel in ("services/ai", "services/publishing", "services/rendering", "services/document"):
    p = str(REPO / rel)
    if p not in sys.path:
        sys.path.insert(0, p)

_apps: dict = {}


def _client(name: str) -> TestClient:
    if not _apps:
        for n in ("ai", "document", "rendering", "publishing"):
            sys.modules.pop("main", None)  # `main` collides across services; alias each
            sys.path.insert(0, str(REPO / "services" / n))  # ensure THIS service's main wins
            mod = importlib.import_module("main")
            sys.path.pop(0)
            sys.modules[f"{n}_main"] = sys.modules.pop("main")
            _apps[n] = mod.app
    return TestClient(_apps[name])


WORKSPACE_ID = "11111111-1111-1111-1111-111111111111"
BOOK_ID = "22222222-2222-2222-2222-222222222222"
CHAPTER_ID = "33333333-3333-3333-3333-333333333333"

# Manuscript with one doubled word the mock provider "fixes".
TEXT = "The the night was quiet. Mara counted her coins twice."

BOOK_MODEL = {
    "schemaVersion": "1.0",
    "bookId": BOOK_ID,
    "metadata": {"title": "Critical Journey", "author": "E2E Author", "language": "en",
                 "description": "E2E fixture book."},
    "styleGuide": {"spellingVariant": "en-US"},
    "bookBible": {"entities": []},
    "chapters": [{
        "id": CHAPTER_ID, "order": 0, "title": "Chapter 1",
        "nodes": [{"id": "n1", "type": "paragraph", "text": TEXT}],
    }],
    "assets": [],
}

EDITION = {"kind": "ebook", "flow": "reflowable", "navigation": "toc"}

# What the mock provider returns: one schema-valid propose_edit suggestion.
MOCK_SUGGESTION = {
    "toolCalls": [{
        "name": "propose_edit",
        "input": {
            "chapterId": CHAPTER_ID,
            "nodeId": "n1",
            "operation": {
                "operationId": "op-e2e-1",
                "type": "replace_text",
                "target": {"chapterId": CHAPTER_ID, "nodeId": "n1"},
                "payload": {"from": 0, "to": 7, "text": "The"},
                "expectedVersion": 1,
            },
            "rationale": "doubled word",
            "confidence": 0.95,
        },
    }],
    "usage": {"inputTokens": 10, "outputTokens": 5},
}


def test_p0_journey(monkeypatch, tmp_path):
    # Document service: import TXT manuscript -> canonical Book Model.
    doc = _client("document")
    parsed = doc.post("/parse", json={
        "assetId": "a-1", "format": "txt", "title": "Critical Journey",
        "contentBase64": base64.b64encode(TEXT.encode()).decode(),
    })
    assert parsed.status_code == 200, parsed.text
    assert parsed.json()["bookModel"]["chapters"], "import produced no chapters"

    # AI service: create job (mock provider -> one valid suggestion).
    import gateway
    from gateway import MockProvider
    monkeypatch.setenv("DEFAULT_AI_PROVIDER", "mock")
    monkeypatch.setattr(gateway, "_REGISTRY",
                        {**gateway._REGISTRY, "mock": lambda: MockProvider([MOCK_SUGGESTION])})

    ai = _client("ai")
    job = ai.post("/v1/ai/jobs", json={
        "workspaceId": WORKSPACE_ID, "bookId": BOOK_ID, "agentType": "proofreader",
        "idempotencyKey": "e2e-job-1",
        "input": {"chapterIds": [CHAPTER_ID],
                  "chapters": {CHAPTER_ID: BOOK_MODEL["chapters"][0]},
                  "styleGuide": {"spellingVariant": "en-US"}},
    })
    assert job.status_code == 201, job.text
    body = job.json()
    assert body["status"] == "succeeded"
    assert len(body["suggestions"]) == 1

    # Idempotency: replay returns the same job.
    replay = ai.post("/v1/ai/jobs", json={
        "workspaceId": WORKSPACE_ID, "bookId": BOOK_ID, "agentType": "proofreader",
        "idempotencyKey": "e2e-job-1", "input": {}})
    assert replay.json()["jobId"] == body["jobId"]

    # Apply suggestion: returns the validated operation for the API to submit
    # to POST /v1/chapters/{id}/operations (expectedVersion/409 covered in API tests).
    sid = body["suggestions"][0]["id"]
    applied = ai.post(f"/v1/ai/suggestions/{sid}/apply")
    assert applied.status_code == 200, applied.text
    assert applied.json()["operation"]["type"] == "replace_text"
    # Second apply conflicts (already accepted).
    assert ai.post(f"/v1/ai/suggestions/{sid}/apply").status_code == 409

    # Rendering service: render EPUB (deterministic sha256).
    rend = _client("rendering")
    epub = rend.post("/render", json={"editionConfig": EDITION, "bookModel": BOOK_MODEL})
    assert epub.status_code == 200, epub.text
    epub_body = epub.json()
    assert epub_body["format"] == "epub" and len(epub_body["sha256"]) == 64
    epub2 = rend.post("/render", json={"editionConfig": EDITION, "bookModel": BOOK_MODEL})
    assert epub2.json()["sha256"] == epub_body["sha256"], "render not reproducible"

    # Deterministic preflight: zero errors on a valid model.
    pf = rend.post("/preflight", json={
        "editionConfig": EDITION, "bookModel": BOOK_MODEL, "channel": "kdp"})
    assert pf.status_code == 200, pf.text
    assert pf.json()["errors"] == 0, pf.json()["findings"]

    # Publishing service: export job, idempotent replay.
    import publishing_main
    monkeypatch.setattr(publishing_main, "_JOBS_DIR", tmp_path)
    pub = _client("publishing")
    export = pub.post("/v1/publishing/jobs", json={
        "channel": "kdp", "editionConfig": EDITION, "bookModel": BOOK_MODEL,
        "idempotencyKey": "e2e-export-1"})
    assert export.status_code == 201, export.text
    assert export.json()["status"] == "exported"
    assert export.json()["packages"], "no export artifacts"
    replay = pub.post("/v1/publishing/jobs", json={
        "channel": "kdp", "editionConfig": EDITION, "bookModel": BOOK_MODEL,
        "idempotencyKey": "e2e-export-1"})
    assert replay.json()["replayed"] is True


def test_validation_failure_paths():
    ai = _client("ai")
    rend = _client("rendering")
    pub = _client("publishing")

    # Missing required fields -> 422
    assert ai.post("/v1/ai/jobs", json={}).status_code == 422
    # Unknown agent type -> 422
    bad_agent = ai.post("/v1/ai/jobs", json={
        "workspaceId": "w", "bookId": "b", "agentType": "admin_override",
        "idempotencyKey": "k-bad", "input": {}})
    assert bad_agent.status_code == 422
    # Unknown suggestion -> 404
    assert ai.post("/v1/ai/suggestions/nope/apply").status_code == 404
    # Unknown job -> 404
    assert ai.get("/v1/ai/jobs/nope").status_code == 404
    # Bad edition kind -> 422
    assert rend.post("/render", json={
        "editionConfig": {"kind": "audiobook"}, "bookModel": BOOK_MODEL}).status_code == 422
    # Unknown channel -> 422
    assert pub.post("/v1/publishing/validate", json={
        "channel": "darkweb", "editionConfig": EDITION, "bookModel": BOOK_MODEL}).status_code == 422
    # Path-unsafe idempotency key -> 422 (job path traversal guard)
    assert pub.post("/v1/publishing/jobs", json={
        "channel": "kdp", "editionConfig": EDITION, "bookModel": BOOK_MODEL,
        "idempotencyKey": "../../evil"}).status_code == 422
