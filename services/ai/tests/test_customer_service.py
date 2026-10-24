"""Composed private HTTP -> DB contract -> actual agent -> synthetic provider."""
import copy
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from customer_database import CustomerAiDatabase
from customer_service import customer_service_router
from result_store import ReceiptUnavailable
from test_customer_database import DB_KEY, ROOT, RPC, DatabaseFixture
from test_customer_dispatch import NOW, SIGNING_KEY, KEY, sign
from test_customer_prepare import source, body_for
from test_customer_provider import NAMES, response_for
from test_customer_provider_agents import CHAPTER, EDIT
from test_metadata_agent import VALID_CANDIDATE

PREPARE = "/v1/internal/customer-text/prepare"
DISPATCH = "/v1/internal/customer-text/dispatch"
TOKEN = "synthetic-service-auth"


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def reject(*args, **kwargs): raise AssertionError("Real network forbidden.")
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", reject)


def client_for(database, provider, *, clock=lambda: NOW):
    app = FastAPI()
    app.include_router(customer_service_router(service_token=TOKEN, signing_keys={"synthetic": SIGNING_KEY},
        database=database, _clock=clock, _test_provider_transport=httpx.MockTransport(provider)))
    return TestClient(app, headers={"x-service-token": TOKEN, "content-type": "application/json"})


def provider_response(name, kind, request):
    node = request["input"]["chapters"][CHAPTER]["nodes"][0]
    ref = {"chapterId": CHAPTER, "documentVersionId": request["input"]["chapters"][CHAPTER]["documentVersionId"],
           "nodeId": node["id"], "textHash": node["textHash"]}
    if kind == "bookbible":
        tool, payload = "propose_book_bible_candidates", {"candidates": [{"type": "event", "name": "Rainfall",
            "description": "Rain falls at the opening.", "attributes": {}, "confidence": 0.9, "sourceRefs": [ref]}]}
    elif kind == "metadata":
        tool, payload = "propose_metadata", {**copy.deepcopy(VALID_CANDIDATE), "sourceRefs": [ref]}
    else:
        tool, payload = "propose_edit", copy.deepcopy(EDIT)
    return httpx.Response(200, json=response_for(name, tool, payload))


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("kind", ("writer", "proofreader", "copyeditor", "consistency", "metadata", "bookbible"))
def test_preparation_signed_dispatch_database_receipt_and_process_restart(name, kind):
    scope, request = source(name, kind)
    fixture_db, calls = DatabaseFixture(), []
    def provider(wire):
        calls.append(wire)
        assert [row[1] for row in fixture_db.calls] == [RPC, "/rest/v1/ai_review_service_receipts", RPC]
        assert fixture_db.rows[scope["jobId"]]["result_json"] is None
        assert DB_KEY not in wire.content.decode() + str(wire.headers)
        return provider_response(name, kind, request)
    with client_for(fixture_db.adapter(), provider) as client:
        prepared = client.post(PREPARE, content=body_for(scope, request))
        assert prepared.status_code == 200 and not fixture_db.calls and not calls
        scope["expectedRequestSha256"] = prepared.json()["requestSha256"]
        result = client.post(DISPATCH, content=sign(scope, request))
        assert result.status_code == 201, result.text
        value = result.json()
        assert value["usage"]["estimatedCostUsd"] is None and value["suggestions"][0]["status"] == "pending"
    # New adapter/router/client, same persisted receipt; no in-memory replay cache.
    with client_for(fixture_db.adapter(), provider) as client:
        replay = client.post(DISPATCH, content=sign(scope, request))
        assert replay.status_code == 201 and replay.json() == value
    assert len(calls) == 1
    assert [row[0] for row in fixture_db.calls] == ["POST", "POST", "POST", "PATCH", "POST", "POST", "GET"]
    assert [row[3]["p_scope"] for row in fixture_db.calls if row[1] == RPC] == [scope, scope, scope]
    assert KEY not in json.dumps(fixture_db.rows) + json.dumps(fixture_db.calls)


@pytest.mark.parametrize("case", ["reserve-lost", "save-lost", "save-rejected", "provider-lost"])
def test_ambiguous_outcomes_keep_fence_and_saved_receipt_replays_without_regeneration(case):
    scope, request = source()
    fixture_db, calls = DatabaseFixture(), []
    broken = True
    def database(wire):
        response = fixture_db.send(wire)
        if broken and ((case == "reserve-lost" and wire.method == "POST" and wire.url.path != RPC)
                       or (case == "save-lost" and wire.method == "PATCH")):
            raise httpx.ReadTimeout(DB_KEY + KEY)
        return response
    def send(wire):
        if broken and case == "save-rejected" and wire.method == "PATCH":
            return httpx.Response(500, text=DB_KEY + KEY)
        return database(wire)
    def provider(wire):
        calls.append(wire)
        if case == "provider-lost": raise httpx.ReadTimeout(KEY)
        return provider_response("openai", "writer", request)
    db = CustomerAiDatabase(ROOT, DB_KEY, _test_transport=httpx.MockTransport(send))
    with client_for(db, provider) as client:
        scope["expectedRequestSha256"] = client.post(PREPARE, content=body_for(scope, request)).json()["requestSha256"]
        failed = client.post(DISPATCH, content=sign(scope, request))
        assert failed.status_code == 503 and KEY not in failed.text and DB_KEY not in failed.text
    broken = False
    with client_for(fixture_db.adapter(), provider) as client:
        retry = client.post(DISPATCH, content=sign(scope, request))
        assert retry.status_code == (201 if case == "save-lost" else 409), retry.text
    assert len(calls) == (0 if case == "reserve-lost" else 1)


def test_revocation_is_rechecked_even_when_a_saved_receipt_exists():
    scope, request = source()
    fixture_db, calls = DatabaseFixture(), []
    def provider(wire):
        calls.append(wire)
        return provider_response("openai", "writer", request)
    with client_for(fixture_db.adapter(), provider) as client:
        scope["expectedRequestSha256"] = client.post(PREPARE, content=body_for(scope, request)).json()["requestSha256"]
        assert client.post(DISPATCH, content=sign(scope, request)).status_code == 201
        count = len(fixture_db.calls)
        fixture_db.allowed = False
        assert client.post(DISPATCH, content=sign(scope, request)).status_code == 403
    assert len(fixture_db.calls) == count + 1 and fixture_db.calls[-1][1] == RPC and len(calls) == 1
    # Separate worker completion is receipt-only; rejection does not delete it.
    assert fixture_db.rows[scope["jobId"]]["result_json"] is not None


def test_authorization_failure_has_no_receipt_or_provider_side_effects():
    scope, request = source()
    fixture_db, calls = DatabaseFixture(), []
    fixture_db.allowed = False
    with client_for(fixture_db.adapter(), lambda wire: calls.append(wire)) as client:
        scope["expectedRequestSha256"] = client.post(PREPARE, content=body_for(scope, request)).json()["requestSha256"]
        assert client.post(DISPATCH, content=sign(scope, request)).status_code == 403
    assert not fixture_db.rows and not calls and len(fixture_db.calls) == 1


@pytest.mark.parametrize("failure", ["revoked", "unavailable", "expired"])
def test_authority_is_rechecked_after_reservation_before_provider(failure):
    scope, request = source()
    fixture_db, calls = DatabaseFixture(), []
    current = NOW
    auth_calls = 0
    def database(wire):
        nonlocal current, auth_calls
        if wire.url.path == RPC:
            auth_calls += 1
            if auth_calls == 2:
                if failure == "unavailable": raise httpx.ReadTimeout(DB_KEY)
                if failure == "revoked": fixture_db.allowed = False
                if failure == "expired": current = NOW + 60
        return fixture_db.send(wire)
    db = CustomerAiDatabase(ROOT, DB_KEY, _test_transport=httpx.MockTransport(database))
    with client_for(db, lambda wire: calls.append(wire), clock=lambda: current) as client:
        scope["expectedRequestSha256"] = client.post(PREPARE, content=body_for(scope, request)).json()["requestSha256"]
        response = client.post(DISPATCH, content=sign(scope, request))
        assert response.status_code == 503 and DB_KEY not in response.text
    assert auth_calls == 2 and not calls and fixture_db.rows[scope["jobId"]]["result_json"] is None
    fixture_db.allowed = True
    with client_for(fixture_db.adapter(), lambda wire: calls.append(wire)) as client:
        assert client.post(DISPATCH, content=sign(scope, request)).status_code == 409
    assert not calls


def test_concurrent_private_requests_reserve_one_provider_call():
    scope, request = source()
    fixture_db, calls = DatabaseFixture(), []
    def provider(wire):
        calls.append(wire)
        return provider_response("openai", "writer", request)
    with client_for(fixture_db.adapter(), provider) as client:
        scope["expectedRequestSha256"] = client.post(PREPARE, content=body_for(scope, request)).json()["requestSha256"]
        body = sign(scope, request)
        with ThreadPoolExecutor(max_workers=4) as pool:
            statuses = list(pool.map(lambda _: client.post(DISPATCH, content=body).status_code, range(4)))
    assert 201 in statuses and set(statuses) <= {201, 409} and len(calls) == 1


def test_no_default_app_activation_or_implicit_database_configuration():
    assert not any("customer-text" in route.path for route in main.app.routes)
    with pytest.raises(ReceiptUnavailable):
        customer_service_router(service_token=TOKEN, signing_keys={"synthetic": SIGNING_KEY}, database=None)
