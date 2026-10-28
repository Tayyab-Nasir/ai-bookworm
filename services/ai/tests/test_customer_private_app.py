"""Explicit private app composition; no hosted or paid calls."""
import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from customer_private_app import create_customer_private_app
from test_customer_database import DB_KEY, ROOT, DatabaseFixture
from test_customer_dispatch import KEY, NOW, SIGNING_KEY, sign
from test_customer_prepare import body_for, source
from test_customer_service import DISPATCH, PREPARE, TOKEN, provider_response


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch):
    def reject(*_args, **_kwargs):
        raise AssertionError("Real network forbidden")
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", reject)


def config(**overrides):
    return {"database_url": ROOT, "service_role_key": DB_KEY, "service_token": TOKEN,
            "signing_keys": {"synthetic": SIGNING_KEY}, **overrides}


@pytest.mark.parametrize("overrides", [
    {"service_token": "short"}, {"service_token": "bad token with spaces"},
    {"signing_keys": {}}, {"signing_keys": {"invalid key": b"x" * 32}},
    {"signing_keys": {"ok": b"x" * 31}}, {"signing_keys": {"ok": "x" * 32}},
    {"database_url": "https://user:synthetic-secret@example.test"},
    {"database_url": "http://example.test"},
    {"database_url": "http://127.0.0.1:54321", "allow_loopback_http": True},
    {"mode": "production", "_test_database_transport": httpx.MockTransport(lambda _: httpx.Response(200))},
])
def test_invalid_configuration_fails_at_construction_without_secret_details(overrides):
    with pytest.raises(ValueError, match="^Private customer AI service configuration is invalid\\.$") as exc:
        create_customer_private_app(**config(**overrides))
    assert "synthetic-secret" not in repr(exc.value)
    assert DB_KEY not in repr(exc.value)


def test_default_service_remains_unmounted_and_private_app_exposes_no_docs():
    assert not any("customer-text" in route.path for route in main.app.routes)
    app = create_customer_private_app(**config())
    with TestClient(app) as client:
        for path in ("/docs", "/redoc", "/openapi.json", "/health", "/v1/ai/jobs"):
            assert client.get(path).status_code == 404
        assert client.post(PREPARE, content=b"{}", headers={"content-type": "application/json"}).status_code == 401


def test_explicit_app_prepares_dispatches_and_replays_one_synthetic_provider_call():
    scope, request = source(); db = DatabaseFixture(); calls = []
    def provider(wire):
        calls.append(wire)
        return provider_response("openai", "writer", request)
    keyring = {"synthetic": SIGNING_KEY, "rotation": b"r" * 32}
    app = create_customer_private_app(**config(mode="test", signing_keys=keyring, _test_database_transport=httpx.MockTransport(db.send),
        _test_provider_transport=httpx.MockTransport(provider), _test_clock=lambda: NOW))
    keyring.clear()  # The app retains its own configured verification snapshot.
    headers = {"x-service-token": TOKEN, "content-type": "application/json"}
    with TestClient(app, headers=headers) as client:
        prepared = client.post(PREPARE, content=body_for(scope, request))
        assert prepared.status_code == 200 and not calls and not db.calls
        scope["expectedRequestSha256"] = prepared.json()["requestSha256"]
        invalid = client.post(DISPATCH, content=b'{}')
        assert invalid.status_code == 422 and not calls and not db.calls
        unknown = json.loads(sign(scope, request)); unknown["keyId"] = "missing"
        assert client.post(DISPATCH, json=unknown).status_code == 422 and not calls and not db.calls
        result = client.post(DISPATCH, content=sign(scope, request))
        assert result.status_code == 201 and result.json()["usage"]["estimatedCostUsd"] is None
        assert client.post(DISPATCH, content=sign(scope, request)).status_code == 201
        db.allowed = False
        assert client.post(DISPATCH, content=sign(scope, request)).status_code == 403
    assert len(calls) == 1
    assert KEY not in result.text and DB_KEY not in result.text


def test_loopback_requires_explicit_development_or_test_opt_in():
    app = create_customer_private_app(**config(database_url="http://127.0.0.1:54321",
                                                mode="test", allow_loopback_http=True))
    assert app.openapi_url is None
    with pytest.raises(ValueError):
        create_customer_private_app(**config(database_url="http://127.0.0.1:54321", mode="test"))
