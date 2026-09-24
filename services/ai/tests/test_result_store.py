import json
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
import result_store
from gateway import ProviderOutcomeUnknown


@pytest.fixture
def durable_service(monkeypatch):
    rows = {}
    calls = []
    original_client = httpx.Client
    def handle(request):
        assert request.headers["apikey"] == "fixture-service-key"
        assert request.headers["authorization"] == "Bearer fixture-service-key"
        assert request.url.path in {"/rest/v1/metadata_service_receipts", "/rest/v1/ai_review_service_receipts",
                                    "/rest/v1/book_bible_service_receipts"}
        body = json.loads(request.content) if request.content else {}
        job_id = request.url.params.get("job_id", "eq.")[3:]
        prefix = ("review:" if request.url.path.endswith("/ai_review_service_receipts") else
                  "bible:" if request.url.path.endswith("/book_bible_service_receipts") else "")
        key = prefix + (body.get("job_id", job_id))
        if request.method == "POST":
            if key in rows:
                return httpx.Response(409, json={"code": "23505"})
            rows[key] = {**body, "result_json": None}
            return httpx.Response(201, json=[rows[key]])
        if request.method == "PATCH":
            row = rows.get(key)
            assert row and row["request_sha256"] == request.url.params["request_sha256"][3:]
            assert row["result_json"] is None
            row.update(body)
            return httpx.Response(200, json=[row])
        assert request.method == "GET"
        return httpx.Response(200, json=[rows[key]] if key in rows else [])
    transport = httpx.MockTransport(handle)
    monkeypatch.setattr(result_store.httpx, "Client", lambda **kwargs: original_client(transport=transport, **kwargs))
    monkeypatch.setenv("SUPABASE_URL", "https://fixture.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "fixture-service-key")
    monkeypatch.setenv("AI_SERVICE_TOKEN", "fixture-private-token")
    monkeypatch.setenv("DEFAULT_AI_PROVIDER", "openai")
    monkeypatch.setattr(main, "get_provider", lambda: SimpleNamespace(name="openai"))
    monkeypatch.setattr(main, "default_model", lambda name: "fixture-model")
    def run(*args, **kwargs):
        calls.append(kwargs["job_id"])
        return SimpleNamespace(to_dict=lambda: {"status": "succeeded", "suggestions": [{"description": "Recovered draft"}]})
    monkeypatch.setattr(main, "get_agent", lambda *args: SimpleNamespace(run=run))
    main._JOBS.clear(); main._JOBS_BY_IDEMPOTENCY.clear()
    client = TestClient(main.app)
    client.headers["x-service-token"] = "fixture-private-token"
    payload = {"jobId": "12345678-1234-4234-8234-123456789012", "workspaceId": "workspace",
               "bookId": "book", "agentType": "metadata", "idempotencyKey": "receipt-key", "input": {}}
    yield client, payload, rows, calls
    client.close()
    main._JOBS.clear(); main._JOBS_BY_IDEMPOTENCY.clear()


def test_metadata_receipt_survives_process_cache_loss_and_replay(durable_service):
    client, payload, rows, calls = durable_service
    first = client.post("/v1/ai/jobs", json=payload)
    assert first.status_code == 201, first.text
    main._JOBS.clear(); main._JOBS_BY_IDEMPOTENCY.clear()
    restored = client.get("/v1/ai/jobs/" + payload["jobId"])
    assert restored.status_code == 200
    assert restored.json() == first.json()
    assert client.post("/v1/ai/jobs", json=payload).json() == first.json()
    assert len(calls) == 1
    assert "input" not in rows[payload["jobId"]]
    assert client.post("/v1/ai/jobs", json={**payload, "bookId": "other"}).status_code == 409
    assert len(calls) == 1
    assert client.get("/v1/ai/jobs/" + payload["jobId"], headers={"x-service-token": "wrong"}).status_code == 401


def test_paid_review_receipt_survives_cache_loss_without_second_generation(durable_service):
    client, payload, rows, calls = durable_service
    review = {**payload, "agentType": "proofreader", "idempotencyKey": "review-receipt"}
    first = client.post("/v1/ai/jobs", json=review)
    assert first.status_code == 201, first.text
    assert "review:" + payload["jobId"] in rows
    main._JOBS.clear(); main._JOBS_BY_IDEMPOTENCY.clear()
    assert client.get("/v1/ai/jobs/" + payload["jobId"]).json() == first.json()
    assert client.post("/v1/ai/jobs", json=review).json() == first.json()
    assert len(calls) == 1
    assert client.post("/v1/ai/jobs", json={**review, "bookId": "other"}).status_code == 409


def test_book_bible_receipt_survives_cache_loss_without_second_generation(durable_service):
    client, payload, rows, calls = durable_service
    bible = {**payload, "agentType": "bookbible", "idempotencyKey": "bible-receipt"}
    first = client.post("/v1/ai/jobs", json=bible)
    assert first.status_code == 201, first.text
    assert "bible:" + payload["jobId"] in rows
    main._JOBS.clear(); main._JOBS_BY_IDEMPOTENCY.clear()
    assert client.get("/v1/ai/jobs/" + payload["jobId"]).json() == first.json()
    assert client.post("/v1/ai/jobs", json=bible).json() == first.json()
    assert len(calls) == 1
    assert client.post("/v1/ai/jobs", json={**bible, "bookId": "other"}).status_code == 409


def test_real_book_bible_agent_saves_and_recovers_quoted_result(durable_service, monkeypatch):
    from agents.copyeditor import get_agent
    from gateway import MockProvider
    client, body, rows, _ = durable_service
    provider = MockProvider([{"toolCalls": [{"name": "propose_book_bible_candidates", "input": {"candidates": []}}]}])
    provider.name = "openai"
    monkeypatch.setattr(main, "get_agent", get_agent)
    monkeypatch.setattr(main, "get_provider", lambda: provider)
    chapter_id = "00000000-0000-4000-8000-000000000001"
    request = {**body, "agentType": "bookbible", "model": "fixture-model", "maxOutputTokens": 2400,
        "input": {"chapterIds": [chapter_id], "chapters": {chapter_id: {
            "documentVersionId": "00000000-0000-4000-8000-000000000002",
            "nodes": [{"id": "n1", "text": "A quiet morning.", "textHash": "f" * 64}],
        }}}}
    canonical = main.story_blueprint_generation_request(main.TextQuoteRequest.model_validate(request), provider)
    request["expectedInputSha256"] = main.canonical_story_blueprint_request_hash(canonical)
    first = client.post("/v1/ai/jobs", json=request)
    assert first.status_code == 201 and first.json()["status"] == "succeeded", first.text
    assert rows["bible:" + body["jobId"]]["result_json"] == first.json()
    main._JOBS.clear(); main._JOBS_BY_IDEMPOTENCY.clear()
    assert client.get("/v1/ai/jobs/" + body["jobId"]).json() == first.json()
    assert client.post("/v1/ai/jobs", json=request).json() == first.json()
    assert len(provider.calls) == 1


def test_book_bible_unconfirmed_reservation_never_regenerates(durable_service, monkeypatch):
    client, payload, rows, calls = durable_service
    bible = {**payload, "agentType": "bookbible", "idempotencyKey": "bible-uncertain"}
    def uncertain(*args, **kwargs):
        raise ProviderOutcomeUnknown("Paid provider outcome is unconfirmed.")
    monkeypatch.setattr(main, "get_agent", lambda *args: SimpleNamespace(run=uncertain))
    assert client.post("/v1/ai/jobs", json=bible).status_code == 503
    assert rows["bible:" + payload["jobId"]]["result_json"] is None
    assert client.post("/v1/ai/jobs", json=bible).status_code == 409
    assert client.get("/v1/ai/jobs/" + payload["jobId"]).status_code == 404
    assert calls == []


@pytest.mark.parametrize("requested", [None, 128000])
def test_book_bible_output_is_capped_before_provider_dispatch(durable_service, monkeypatch, requested):
    client, payload, _, _ = durable_service
    seen = []
    class Agent:
        max_output_tokens = None
        def run(self, *args, **kwargs):
            seen.append(self.max_output_tokens)
            return SimpleNamespace(to_dict=lambda: {"status": "succeeded", "suggestions": []})
    monkeypatch.setattr(main, "get_agent", lambda *args: Agent())
    bible = {**payload, "agentType": "bookbible", "idempotencyKey": f"bible-output-{requested}"}
    if requested is not None:
        bible["maxOutputTokens"] = requested
    assert client.post("/v1/ai/jobs", json=bible).status_code == 201
    assert seen == [6000]


def test_paid_review_unconfirmed_reservation_never_regenerates(durable_service, monkeypatch):
    client, payload, rows, calls = durable_service
    review = {**payload, "agentType": "proofreader", "idempotencyKey": "review-uncertain"}
    def uncertain(*args, **kwargs):
        raise ProviderOutcomeUnknown("Paid provider outcome is unconfirmed.")
    monkeypatch.setattr(main, "get_agent", lambda *args: SimpleNamespace(run=uncertain))
    assert client.post("/v1/ai/jobs", json=review).status_code == 503
    assert rows["review:" + payload["jobId"]]["result_json"] is None
    assert client.post("/v1/ai/jobs", json=review).status_code == 409
    assert client.get("/v1/ai/jobs/" + payload["jobId"]).status_code == 404
    assert calls == []


def test_unknown_reserved_result_never_regenerates(durable_service):
    client, payload, rows, calls = durable_service
    assert client.post("/v1/ai/jobs", json=payload).status_code == 201
    rows[payload["jobId"]]["result_json"] = None
    main._JOBS.clear(); main._JOBS_BY_IDEMPOTENCY.clear()
    assert client.post("/v1/ai/jobs", json=payload).status_code == 409
    assert client.get("/v1/ai/jobs/" + payload["jobId"]).status_code == 404
    assert len(calls) == 1


def test_uncertain_paid_provider_result_leaves_metadata_receipt_reserved(durable_service, monkeypatch):
    client, payload, rows, calls = durable_service
    def uncertain(*args, **kwargs):
        raise ProviderOutcomeUnknown("Paid provider outcome is unconfirmed.")
    monkeypatch.setattr(main, "get_agent", lambda *args: SimpleNamespace(run=uncertain))
    assert client.post("/v1/ai/jobs", json=payload).status_code == 503
    assert rows[payload["jobId"]]["result_json"] is None
    assert client.post("/v1/ai/jobs", json=payload).status_code == 409
    assert calls == []


def test_missing_receipt_configuration_stops_before_generation(durable_service, monkeypatch):
    client, payload, rows, calls = durable_service
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY")
    response = client.post("/v1/ai/jobs", json=payload)
    assert response.status_code == 503
    assert calls == [] and rows == {}


def test_save_failure_keeps_reservation_and_never_repeats_generation(durable_service, monkeypatch):
    client, payload, rows, calls = durable_service
    def unavailable(*args):
        raise result_store.ReceiptUnavailable("Storage response lost")
    monkeypatch.setattr(result_store.MetadataResultStore, "save", unavailable)
    assert client.post("/v1/ai/jobs", json=payload).status_code == 503
    assert rows[payload["jobId"]]["result_json"] is None
    assert client.post("/v1/ai/jobs", json=payload).status_code == 409
    assert len(calls) == 1


def test_missing_job_identity_and_unavailable_storage_stop_before_provider(durable_service, monkeypatch):
    client, payload, rows, calls = durable_service
    assert client.post("/v1/ai/jobs", json={k: v for k, v in payload.items() if k != "jobId"}).status_code == 422
    monkeypatch.setattr(result_store.MetadataResultStore, "_request", lambda *args, **kwargs: httpx.Response(503))
    assert client.post("/v1/ai/jobs", json=payload).status_code == 503
    assert calls == [] and rows == {}
