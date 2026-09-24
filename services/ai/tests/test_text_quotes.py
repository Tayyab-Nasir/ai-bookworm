"""Private exact-input quotes: synthetic provider/counter only, no network."""
import copy
import hashlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main
from agents.base import BaseAgent
from gateway import MockProvider, openai_request

CHAPTER = "00000000-0000-4000-8000-000000000001"
VERSION = "00000000-0000-4000-8000-000000000002"
HEADERS = {"x-service-token": "synthetic-internal-token"}
TEXT = "The mapmaker carried her silver compass into the winter city."
HASH = hashlib.sha256(TEXT.encode()).hexdigest()
AGENTS = ["writer", "proofreader", "copyeditor", "consistency", "metadata", "bookbible"]


def payload(agent="copyeditor"):
    return {
        "jobId": "00000000-0000-4000-8000-000000000099",
        "workspaceId": "workspace-1", "bookId": "book-1", "agentType": agent,
        "model": "synthetic-pinned-model", "maxOutputTokens": 2400,
        "input": {
            "chapterIds": [CHAPTER], "book": {"title": "The Silver Compass"},
            "chapters": {CHAPTER: {"id": CHAPTER, "documentVersionId": VERSION,
                "nodes": [{"id": "n1", "text": TEXT, "textHash": HASH}]}},
            "userInstruction": "Review the selected passage.",
        },
    }


@pytest.fixture
def configured(monkeypatch):
    main._JOBS.clear()
    main._JOBS_BY_IDEMPOTENCY.clear()
    main._SUGGESTIONS.clear()
    monkeypatch.setenv("DEFAULT_AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_SERVICE_TOKEN", HEADERS["x-service-token"])
    provider = MockProvider()
    provider.name = "openai"
    monkeypatch.setattr(main, "get_provider", lambda: provider)
    count_calls = []
    monkeypatch.setattr(main, "count_story_blueprint_input", lambda req: count_calls.append(copy.deepcopy(req)) or 321)
    reservations, saved = [], []
    store = SimpleNamespace(reserve=lambda *args: reservations.append(args), save=lambda *args: saved.append(args))
    for name in ("MetadataResultStore", "BookBibleResultStore", "AiReviewResultStore"):
        monkeypatch.setattr(main, name, lambda: store)
    yield TestClient(main.app), provider, count_calls, reservations, saved
    main._JOBS.clear()
    main._JOBS_BY_IDEMPOTENCY.clear()
    main._SUGGESTIONS.clear()


def result_for(agent):
    if agent == "metadata":
        candidate = {
            "description": "A mapmaker carries a silver compass into a winter city, where her journey promises a compelling fantasy adventure.",
            "keywords": ["silver compass", "winter city", "fantasy adventure"],
            "categories": ["Fiction / Fantasy / Adventure"], "audience": "Adult fantasy readers.",
            "rationale": "Uses the selected passage without inventing plot events.", "confidence": 0.8,
            "sourceRefs": [{"chapterId": CHAPTER, "documentVersionId": VERSION, "nodeId": "n1", "textHash": HASH}],
        }
        return {"toolCalls": [{"name": "propose_metadata", "input": candidate}]}
    if agent == "bookbible":
        return {"toolCalls": [{"name": "propose_book_bible_candidates", "input": {"candidates": [{
            "type": "object", "name": "Silver compass", "description": "Carried by the mapmaker.",
            "attributes": {}, "confidence": 0.9,
            "sourceRefs": [{"chapterId": CHAPTER, "documentVersionId": VERSION, "nodeId": "n1", "textHash": HASH}],
        }]}}]}
    return {"toolCalls": []}


@pytest.mark.parametrize("agent", AGENTS)
def test_quote_identity_equals_dispatched_wire_request_with_single_context_build(configured, monkeypatch, agent):
    client, provider, counts, reservations, saved = configured
    body = payload(agent)
    quote = client.post("/v1/ai/text/quote", headers=HEADERS, json=body)
    assert quote.status_code == 200, quote.text
    assert quote.json()["inputTokens"] == 321
    assert quote.json()["maxOutputTokens"] == 2400
    checked = client.post("/v1/ai/text/request-hash", headers=HEADERS, json=body)
    assert checked.status_code == 200
    assert checked.json()["inputSha256"] == quote.json()["inputSha256"]
    assert len(counts) == 1 and provider.calls == [] and reservations == []
    provider.responses = [result_for(agent)]
    original = BaseAgent.provider_request
    builds = []

    def one_build(self, request):
        builds.append(self)
        assert len(builds) == 1, "Dispatch must not rebuild a checked prompt"
        return original(self, request)

    monkeypatch.setattr(BaseAgent, "provider_request", one_build)
    response = client.post("/v1/ai/jobs", headers=HEADERS, json={
        **body, "idempotencyKey": "quoted-" + agent, "expectedInputSha256": quote.json()["inputSha256"],
    })
    assert response.status_code == 201, response.text
    assert response.json()["status"] == "succeeded", response.text
    assert len(provider.calls) == len(builds) == len(reservations) == len(saved) == 1
    call = provider.calls[0]
    actual = openai_request(call["messages"], call["tools"], call["model"],
                           max_output_tokens=call["maxOutputTokens"], tool_choice=call["toolChoice"])
    assert actual == counts[0]
    assert main.canonical_story_blueprint_request_hash(actual) == quote.json()["inputSha256"]
    assert builds[0]._prepared_request is None


@pytest.mark.parametrize("change", ["model", "maxOutputTokens", "source", "instruction", "agent", "style"])
def test_changed_request_rejected_before_receipt_or_provider(configured, change):
    client, provider, counts, reservations, saved = configured
    body = payload()
    quote = client.post("/v1/ai/text/quote", headers=HEADERS, json=body).json()
    if change == "model":
        body["model"] += "-new"
    elif change == "maxOutputTokens":
        body["maxOutputTokens"] += 1
    elif change == "source":
        body["input"]["chapters"][CHAPTER]["nodes"][0]["text"] += " Changed."
    elif change == "instruction":
        body["input"]["userInstruction"] += " Changed."
    elif change == "agent":
        body["agentType"] = "proofreader"
    else:
        body["input"]["styleGuide"] = {"tone": "formal"}
    response = client.post("/v1/ai/jobs", headers=HEADERS, json={
        **body, "idempotencyKey": "changed", "expectedInputSha256": quote["inputSha256"],
    })
    assert response.status_code == 409, response.text
    assert provider.calls == reservations == saved == []


def test_book_bible_effective_output_cap_is_counted_and_dispatched(configured):
    client, provider, counts, reservations, saved = configured
    body = {**payload("bookbible"), "maxOutputTokens": 12000}
    quote = client.post("/v1/ai/text/quote", headers=HEADERS, json=body).json()
    assert quote["maxOutputTokens"] == counts[0]["max_output_tokens"] == 6000
    capped = client.post("/v1/ai/text/request-hash", headers=HEADERS, json={**body, "maxOutputTokens": 6000})
    assert capped.json()["inputSha256"] == quote["inputSha256"]
    provider.responses = [result_for("bookbible")]
    result = client.post("/v1/ai/jobs", headers=HEADERS, json={
        **body, "idempotencyKey": "bible-cap", "expectedInputSha256": quote["inputSha256"],
    })
    assert result.status_code == 201 and result.json()["status"] == "succeeded"
    assert provider.calls[0]["maxOutputTokens"] == 6000


def test_existing_operational_book_bible_http_contract_runs_real_agent(configured):
    client, provider, counts, reservations, saved = configured
    provider.responses = [result_for("bookbible")]
    result = client.post("/v1/ai/jobs", headers=HEADERS, json={
        **payload("bookbible"), "idempotencyKey": "operational-bible",
    })
    assert result.status_code == 201 and result.json()["status"] == "succeeded", result.text
    assert result.json()["agentType"] == "bookbible"
    assert result.json()["suggestions"][0]["name"] == "Silver compass"
    assert len(reservations) == len(saved) == len(provider.calls) == 1
    assert counts == []


def test_prompt_drift_rejected_before_reservation(configured, monkeypatch):
    import prompts
    client, provider, counts, reservations, saved = configured
    body = payload()
    quote = client.post("/v1/ai/text/quote", headers=HEADERS, json=body).json()
    original = prompts.load_prompt
    monkeypatch.setattr(prompts, "load_prompt", lambda *args: original(*args) + " Changed system prompt.")
    result = client.post("/v1/ai/jobs", headers=HEADERS, json={
        **body, "idempotencyKey": "prompt-drift", "expectedInputSha256": quote["inputSha256"],
    })
    assert result.status_code == 409
    assert provider.calls == reservations == saved == []


@pytest.mark.parametrize("missing", ["model", "maxOutputTokens"])
def test_bound_job_requires_explicit_generation_parameters(configured, missing):
    client, provider, counts, reservations, saved = configured
    body = payload()
    body.pop(missing)
    result = client.post("/v1/ai/jobs", headers=HEADERS, json={
        **body, "idempotencyKey": "missing", "expectedInputSha256": "f" * 64,
    })
    assert result.status_code == 422
    assert provider.calls == reservations == saved == []


@pytest.mark.parametrize("route", ["quote", "request-hash"])
def test_private_auth_is_required_before_counting(configured, monkeypatch, route):
    client, provider, counts, reservations, saved = configured
    assert client.post("/v1/ai/text/" + route, json=payload()).status_code == 401
    monkeypatch.delenv("AI_SERVICE_TOKEN")
    assert client.post("/v1/ai/text/" + route, headers=HEADERS, json=payload()).status_code == 503
    assert provider.calls == counts == reservations == saved == []


def test_count_failure_never_creates_a_job(configured, monkeypatch):
    client, provider, counts, reservations, saved = configured
    def unavailable(request):
        raise RuntimeError("private upstream error")
    monkeypatch.setattr(main, "count_story_blueprint_input", unavailable)
    response = client.post("/v1/ai/text/quote", headers=HEADERS, json=payload())
    assert response.status_code == 503 and "private upstream" not in response.text
    assert provider.calls == reservations == saved == []


@pytest.mark.parametrize("value", [True, False, None, -1, 0, 1.5, "100", 2147483648])
def test_counter_rejects_unknown_or_invalid_measurement(monkeypatch, value):
    import openai
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-not-a-real-key")
    monkeypatch.setattr(openai, "OpenAI", lambda **kwargs: SimpleNamespace(
        responses=SimpleNamespace(input_tokens=SimpleNamespace(count=lambda **args: SimpleNamespace(input_tokens=value)))))
    with pytest.raises(RuntimeError, match="invalid input token count"):
        main.count_story_blueprint_input({"model": "test", "input": [], "tools": [], "max_output_tokens": 42})


def test_counter_uses_only_wire_input_fields_and_no_retry(monkeypatch):
    import openai
    captured = []
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-not-a-real-key")
    def client(**options):
        assert options["max_retries"] == 0 and options["timeout"] == 20
        return SimpleNamespace(responses=SimpleNamespace(input_tokens=SimpleNamespace(
            count=lambda **args: captured.append(args) or SimpleNamespace(input_tokens=123))))
    monkeypatch.setattr(openai, "OpenAI", client)
    request = {"model": "test", "input": [], "tools": [], "max_output_tokens": 42}
    assert main.count_story_blueprint_input(request) == 123
    assert captured == [{"model": "test", "input": [], "tools": []}]
