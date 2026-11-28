import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from customer_dispatch_http import customer_dispatch_router
from test_customer_dispatch import NOW, SIGNING_KEY, KEY, SqliteReceipts, fixture, sign, transport

PATH = "/v1/internal/customer-text/dispatch"


def client_for(tmp_path, calls, *, authorize=lambda scope: True, token="synthetic-service-auth", clock=lambda: NOW, handler=None):
    app = FastAPI()
    app.include_router(customer_dispatch_router(service_token=token, signing_keys={"synthetic": SIGNING_KEY},
        authorize_scope=authorize, store_factory=lambda: SqliteReceipts(tmp_path / "r.db"),
        _clock=clock, _test_transport=transport("openai", calls, handler)))
    return TestClient(app, headers={"x-service-token": "synthetic-service-auth", "content-type": "application/json"})


def test_real_http_agent_receipt_pipeline_and_restart(tmp_path):
    scope, request = fixture()
    body, calls = sign(scope, request), []
    with client_for(tmp_path, calls) as client:
        result = client.post(PATH, content=body)
        assert result.status_code == 201, result.text
        assert result.json()["usage"]["estimatedCostUsd"] is None
    with client_for(tmp_path, calls) as client:
        assert client.post(PATH, content=body).json() == result.json()
    assert len(calls) == 1


@pytest.mark.parametrize("case", ["no-auth", "wrong-auth", "bad-json", "tamper", "query", "type", "gzip", "too-large", "scope-denied", "scope-exception", "not-activated"])
def test_rejected_http_never_leaks_body_or_calls_provider(case, tmp_path):
    scope, request = fixture()
    calls, body = [], sign(scope, request)
    def fail(scope): raise RuntimeError(KEY)
    authorize = None if case == "not-activated" else (lambda scope: False) if case == "scope-denied" else fail if case == "scope-exception" else lambda scope: True
    headers, path = {}, PATH
    if case == "no-auth": headers["x-service-token"] = ""
    if case == "wrong-auth": headers["x-service-token"] = "wrong"
    if case == "bad-json": body = KEY.encode()
    if case == "tamper": body = body.replace(b'"synthetic"', b'"wrong"', 1)
    if case == "query": path += "?unexpected=true"
    if case == "type": headers["content-type"] = "text/plain"
    if case == "gzip": headers["content-encoding"] = "gzip"
    if case == "too-large": body = b"x" * 1048577
    with client_for(tmp_path, calls, authorize=authorize) as client:
        result = client.post(path, content=body, headers=headers)
    assert result.status_code >= 400 and KEY not in result.text
    assert "payload" not in result.text and not calls and not (tmp_path / "r.db").exists()


def test_authorizer_gets_only_scope_and_expiry_checked_after_authorizer(tmp_path):
    scope, request = fixture()
    calls, scopes = [], []
    clock = iter([NOW, NOW + 60])
    def authorize(value): scopes.append(value); return True
    with client_for(tmp_path, calls, authorize=authorize, clock=lambda: next(clock)) as client:
        result = client.post(PATH, content=sign(scope, request))
    assert result.status_code == 422 and scopes == [scope] and not calls
    assert KEY not in json.dumps(scopes)


def test_network_error_is_static_and_replay_does_not_regenerate(tmp_path):
    scope, request = fixture()
    calls = []
    def fail(req): raise httpx.ReadTimeout(KEY)
    with client_for(tmp_path, calls, handler=fail) as client:
        result = client.post(PATH, content=sign(scope, request))
        assert result.status_code == 503 and KEY not in result.text
        assert client.post(PATH, content=sign(scope, request)).status_code == 409
    assert len(calls) == 1


def test_no_customer_generation_route_is_registered_in_real_app():
    assert not any("customer-text" in route.path for route in main.app.routes)


def test_environment_receipt_store_cannot_implicitly_activate_dispatch(monkeypatch):
    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "AI_SERVICE_TOKEN"):
        monkeypatch.setenv(name, "synthetic-ambient-configuration")
    app = FastAPI()
    app.include_router(customer_dispatch_router(service_token="synthetic-service-auth",
        signing_keys={"synthetic": SIGNING_KEY}, authorize_scope=lambda scope: True))
    with TestClient(app) as client:
        response = client.post(PATH, content=sign(*fixture()), headers={
            "x-service-token": "synthetic-service-auth", "content-type": "application/json"})
    assert response.status_code == 503 and "not activated" in response.text


def test_chunked_and_dishonest_length_bodies_are_bounded(tmp_path):
    calls = []
    def chunks():
        yield b"x" * 524288
        yield b"y" * 524289
    with client_for(tmp_path, calls) as client:
        response = client.post(PATH, content=chunks(), headers={"content-length": "1"})
        assert response.status_code == 413
    assert not calls and not (tmp_path / "r.db").exists()
