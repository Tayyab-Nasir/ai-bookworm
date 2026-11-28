"""Non-billable preparation across every provider/agent. No real network."""
import hashlib
import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from customer_dispatch import build_customer_agent, prepare_customer_agent
from customer_prepare_http import prepare_customer_input, customer_preparation_router
from test_customer_dispatch import fixture, sign, verify
from test_customer_provider import NAMES
from test_customer_provider_agents import CHAPTER

PATH = "/v1/internal/customer-text/prepare"
TOKEN = "synthetic-service-auth"
VERSION = "00000000-0000-4000-8000-000000000002"


@pytest.fixture(autouse=True)
def forbid_provider(monkeypatch):
    def reject(*args, **kwargs): raise AssertionError("No provider or credential resolution allowed.")
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", reject)
    monkeypatch.setattr("customer_provider.CustomerProvider.__init__", reject)
    monkeypatch.setattr("customer_dispatch.CustomerTextResultStore.reserve", reject)


def source(name="openai", kind="writer"):
    scope, request = fixture(name)
    scope["agentType"] = kind
    chapter = request["input"]["chapters"][CHAPTER]
    chapter["documentVersionId"] = VERSION
    chapter["nodes"][0]["textHash"] = hashlib.sha256(chapter["nodes"][0]["text"].encode()).hexdigest()
    request["input"].update(styleGuide={"z": "last", "a": {"style": "calm", "order": ["z", "a"]}},
                            bookBible=[{"name": "Town", "attributes": {"z": "rain", "a": "quiet"}}],
                            userInstruction="Clarify this opening.")
    request["input"]["book"].update(author="Writer", language="en")
    request["contextPolicy"] = {"includeStyleGuide": True, "includeBookBible": True, "includeRelatedContext": False,
                                "semanticTopK": 5, "maxTokens": 4096}
    scope["policy"]["maxOutputTokens"] = 8000
    return scope, request


def body_for(scope, request):
    return json.dumps({"scope": {key: scope[key] for key in ("workspaceId", "bookId", "provider", "agentType", "policy")},
                       "requestJson": json.dumps(request, ensure_ascii=False)}).encode()


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("kind", ("writer", "proofreader", "copyeditor", "consistency", "metadata", "bookbible"))
def test_actual_prompt_hash_matches_signed_dispatch_after_database_reorders_nested_objects(name, kind):
    scope, request = source(name, kind)
    body = body_for(scope, request)
    result = prepare_customer_input(body)
    assert result["sourceSha256"] == hashlib.sha256(json.loads(body)["requestJson"].encode()).hexdigest()
    assert result["maxOutputTokens"] == (6000 if kind == "bookbible" else 8000)
    scope["expectedRequestSha256"] = result["requestSha256"]
    def reorder(value):
        if type(value) is list: return [reorder(item) for item in value]
        if type(value) is dict: return {key: reorder(value[key]) for key in sorted(value, reverse=True)}
        return value
    rewritten = reorder(request)
    grant = verify(sign(scope, rewritten))
    agent, _, _ = build_customer_agent(grant)
    assert agent.provider is None
    assert prepare_customer_agent(grant.scope, grant.request)[3].sha256 == result["requestSha256"]
    assert result["contextOmitted"] == 0
    assert set(result) == {"provider", "agentType", "model", "maxOutputTokens", "sourceSha256", "requestSha256", "contextOmitted"}
    assert "Rain fell." not in json.dumps(result)


def client_for(token=TOKEN):
    app = FastAPI()
    app.include_router(customer_preparation_router(service_token=token))
    return TestClient(app, headers={"x-service-token": TOKEN, "content-type": "application/json"})


def test_private_http_success_and_not_registered_or_activated_by_environment(monkeypatch):
    for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AI_SERVICE_TOKEN"):
        monkeypatch.setenv(key, "synthetic-irrelevant-credential")
    scope, request = source()
    with client_for() as client:
        response = client.post(PATH, content=body_for(scope, request))
        assert response.status_code == 200 and response.json() == prepare_customer_input(body_for(scope, request))
    with client_for(None) as client:
        assert client.post(PATH, content=body_for(scope, request)).status_code == 503
    assert not any("customer-text" in route.path for route in main.app.routes)


@pytest.mark.parametrize("case", ("no-auth", "wrong-auth", "bad-token", "bad-json", "duplicate", "query", "type", "gzip", "length", "chunked", "extra", "provider", "model", "unicode", "oversize", "depth", "context"))
def test_static_http_rejections_do_not_echo_source(case):
    scope, request = source()
    marker = "private-manuscript-marker"
    request["input"]["book"]["title"] = marker
    envelope = json.loads(body_for(scope, request))
    path, headers = PATH, {}
    if case == "no-auth": headers["x-service-token"] = ""
    if case == "wrong-auth": headers["x-service-token"] = "not-the-token"
    if case == "query": path += "?unexpected=true"
    if case == "type": headers["content-type"] = "text/plain"
    if case == "gzip": headers["content-encoding"] = "gzip"
    if case == "length": headers["content-length"] = "1048577"
    if case == "extra": envelope["apiKey"] = marker
    if case == "provider": envelope["scope"]["provider"] = marker
    if case == "model": envelope["scope"]["policy"]["model"] = "https://invalid.test?secret=" + marker
    if case == "unicode": envelope["requestJson"] = '\ud800'
    if case == "oversize": envelope["requestJson"] = " " * 400001
    if case == "context":
        request["input"]["chapters"][CHAPTER]["nodes"][0]["text"] = marker * 1000
        envelope["requestJson"] = json.dumps(request)
    if case == "depth": envelope["requestJson"] = '{"input":{"book":' + '{"a":' * 35 + 'null' + '}' * 35 + '}}'
    body = json.dumps(envelope).encode()
    if case == "bad-json": body = marker.encode()
    if case == "duplicate": body = b'{"scope":{},"scope":{},"requestJson":"' + marker.encode() + b'"}'
    if case == "chunked":
        body = (chunk for chunk in (b"x" * 524288, b"y" * 524289))
        headers["content-length"] = "1"
    with client_for("spaces in invalid token" if case == "bad-token" else TOKEN) as client:
        response = client.post(path, content=body, headers=headers)
        assert response.status_code >= 400 and marker not in response.text


def test_reference_omission_is_explicit_but_main_source_is_never_truncated():
    scope, request = source()
    request["input"]["styleGuide"] = {"rules": "x" * 20000}
    result = prepare_customer_input(body_for(scope, request))
    assert result["contextOmitted"] == 1
    request["input"]["chapters"][CHAPTER]["nodes"][0]["text"] = "x" * 20000
    with pytest.raises(ValueError): prepare_customer_input(body_for(scope, request))
