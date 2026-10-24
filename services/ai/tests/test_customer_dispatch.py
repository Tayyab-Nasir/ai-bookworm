"""Private transport/real-agent proofs. Synthetic keys and HTTP only."""
import base64
import copy
import hashlib
import hmac
import json
import sqlite3
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agents.copyeditor import get_agent
from customer_dispatch import (AgentRequest, CustomerTextResultStore, DispatchRejected, FORMAT, ReceiptConflict,
    ReceiptUnavailable, Scope, VerifiedDispatch, execute_dispatch, verify_dispatch)
from customer_protocol import prepare_customer_request
from gateway import ProviderOutcomeUnknown
from tools import InMemoryExecutor
from test_customer_provider import KEY, NAMES, policy_for, response_for
from test_customer_provider_agents import CHAPTER, EDIT

SIGNING_KEY = bytes(range(32))  # deliberately public synthetic signing fixture
NOW = 1900000000


def fixture(name="openai"):
    policy = policy_for(name)
    scope = {key: str(uuid.uuid4()) for key in ("grantId", "jobId", "workspaceId", "bookId", "ownerId", "connectionId", "leaseToken")}
    scope.update(credentialRevision=1, provider=name, agentType="writer", expectedRequestSha256="a" * 64,
        policy={"model": policy.model, "responseModels": list(policy.response_models), "maxOutputTokens": 1024,
                "upstream": policy.upstream, "responseUpstreams": list(policy.response_upstreams)})
    request = {"input": {"chapterIds": [CHAPTER], "chapters": {CHAPTER: {
        "id": CHAPTER, "version": 1, "nodes": [{"id": "n1", "text": "Rain fell."}]}},
        "book": {"title": "A quiet café 雨"}}}
    executor = InMemoryExecutor(chapters=request["input"]["chapters"])
    agent = get_agent("writer", None, executor, policy.model)
    agent.max_output_tokens = 1024
    messages, tools, choice = agent.provider_request({"workspaceId": scope["workspaceId"], "bookId": scope["bookId"],
        "chapterIds": [CHAPTER], "book": request["input"]["book"], "userInstruction": None,
        "contextPolicy": AgentRequest.model_validate(request).contextPolicy.model_dump()})
    scope["expectedRequestSha256"] = prepare_customer_request(name, policy, messages, tools, policy.model,
        max_output_tokens=1024, tool_choice=choice).sha256
    return scope, request


def sign(scope, request, *, key=SIGNING_KEY, kid="synthetic", raw=None, **changes):
    payload = {"format": FORMAT, "scope": scope, "requestJson": json.dumps(request, ensure_ascii=False),
               "apiKey": KEY, "issuedAt": NOW, "expiresAt": NOW + 60, **changes}
    raw = json.dumps(payload, ensure_ascii=False).encode() if raw is None else raw
    signature = hmac.new(key, (FORMAT + "\n" + kid + "\n").encode() + raw, "sha256").hexdigest()
    return json.dumps({"keyId": kid, "payload": base64.urlsafe_b64encode(raw).decode().rstrip("="), "signature": signature}).encode()


def verify(body):
    return verify_dispatch(body, {"synthetic": SIGNING_KEY}, now=NOW)


class SqliteReceipts:
    """Test durable storage, not a production fallback or migration substitute."""
    def __init__(self, path):
        self.path = str(path)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("create table if not exists receipts (job text primary key, fingerprint text, result text)")

    def reserve(self, job, fingerprint):
        with closing(sqlite3.connect(self.path)) as db, db:
            inserted = db.execute("insert or ignore into receipts values (?, ?, null)", (job, fingerprint)).rowcount
            if inserted:
                return None
            row = db.execute("select fingerprint, result from receipts where job=?", (job,)).fetchone()
            if row[0] != fingerprint or row[1] is None:
                raise ReceiptConflict("Unresolved or mismatched receipt.")
            return json.loads(row[1])

    def save(self, job, fingerprint, result):
        with closing(sqlite3.connect(self.path)) as db, db:
            assert db.execute("update receipts set result=? where job=? and fingerprint=? and result is null",
                (json.dumps(result), job, fingerprint)).rowcount == 1


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def reject(*args, **kwargs):
        raise AssertionError("Real provider network forbidden.")
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", reject)


def transport(name, calls, handler=None):
    def send(request):
        calls.append(request.content)
        if handler:
            return handler(request)
        return httpx.Response(200, json=response_for(name, "propose_edit", copy.deepcopy(EDIT)))
    return httpx.MockTransport(send)


@pytest.mark.parametrize("name", NAMES)
def test_durable_receipt_process_loss_replay_and_no_secret_storage(name, tmp_path):
    scope, request = fixture(name)
    body = sign(scope, request)
    grant, calls = verify(body), []
    db_path = tmp_path / "receipts.db"
    result = execute_dispatch(grant, SqliteReceipts(db_path), now=lambda: NOW, _test_transport=transport(name, calls))
    assert grant.credential is None and result["status"] == "succeeded" and len(calls) == 1
    assert result["usage"]["estimatedCostUsd"] is None and result["usage"]["providerTokenUsage"]
    assert result["suggestions"][0]["status"] == "pending"
    fresh = verify_dispatch(sign(scope, request, issuedAt=NOW + 61, expiresAt=NOW + 121), {"synthetic": SIGNING_KEY}, now=NOW + 61)
    recovered = execute_dispatch(fresh, SqliteReceipts(db_path), now=lambda: NOW + 61, _test_transport=transport(name, calls))
    assert recovered == result and len(calls) == 1
    for secret in (KEY.encode(), body, SIGNING_KEY):
        assert secret not in db_path.read_bytes()
    assert KEY not in repr(grant) + json.dumps(result)


@pytest.mark.parametrize("field", ("ownerId", "workspaceId", "bookId", "connectionId", "grantId", "leaseToken", "credentialRevision"))
def test_same_job_changed_authority_never_replays_or_generates(field, tmp_path):
    scope, request = fixture()
    calls, store = [], SqliteReceipts(tmp_path / "r.db")
    execute_dispatch(verify(sign(scope, request)), store, now=lambda: NOW, _test_transport=transport("openai", calls))
    scope[field] = 2 if field == "credentialRevision" else str(uuid.uuid4())
    with pytest.raises(ReceiptConflict):
        execute_dispatch(verify(sign(scope, request)), store, now=lambda: NOW, _test_transport=transport("openai", calls))
    assert len(calls) == 1


def test_same_job_changed_provider_cannot_use_a_different_receipt_namespace(tmp_path):
    scope, request = fixture()
    calls, store = [], SqliteReceipts(tmp_path / "r.db")
    execute_dispatch(verify(sign(scope, request)), store, now=lambda: NOW, _test_transport=transport("openai", calls))
    another, request2 = fixture("google")
    another["jobId"] = scope["jobId"]
    with pytest.raises(ReceiptConflict):
        execute_dispatch(verify(sign(another, request2)), store, now=lambda: NOW, _test_transport=transport("google", calls))
    assert len(calls) == 1


@pytest.mark.parametrize("changes", [
    {"expiresAt": NOW}, {"expiresAt": NOW + 61}, {"issuedAt": NOW + 6}, {"issuedAt": True},
    {"expiresAt": float("nan")}, {"format": "other-purpose"}, {"apiKey": "short"},
    {"apiKey": "secret\n" + "x" * 30}, {"unexpected": "value"}, {"requestJson": '{"input":{},"input":{}}'},
    {"requestJson": '{"input":{"apiKey":"not-allowed"}}'},
], ids=["expired", "lifetime", "future", "bool-time", "nan", "domain", "short", "newline", "extra", "duplicate", "extra-input"])
def test_signed_invalid_contract_is_rejected_without_echo(changes):
    scope, request = fixture()
    with pytest.raises(DispatchRejected) as error:
        verify(sign(scope, request, **changes))
    assert str(error.value) == "Customer dispatch is invalid or expired. No generation was started."


@pytest.mark.parametrize("mutation", ["signature", "payload", "kid", "padding", "duplicate", "oversize", "bad-json", "wrong-key"])
def test_unsigned_envelope_tamper_and_bounds(mutation):
    scope, request = fixture()
    body = sign(scope, request)
    data = json.loads(body)
    if mutation == "signature": data["signature"] = "a" * 64
    if mutation == "payload": data["payload"] += "A"
    if mutation == "kid": data["keyId"] = "other"
    if mutation == "padding": data["payload"] += "="
    if mutation == "duplicate": body = body[:-1] + b',"keyId":"synthetic"}'
    elif mutation == "oversize": body = b" " * 1048577
    elif mutation == "bad-json": body = KEY.encode()
    elif mutation == "wrong-key": body = sign(scope, request, key=b"x" * 32)
    else: body = json.dumps(data).encode()
    with pytest.raises(DispatchRejected): verify(body)


def test_scope_and_request_validation_precedes_any_receipt_io(tmp_path):
    scope, request = fixture()
    store, calls = SqliteReceipts(tmp_path / "r.db"), []
    request["input"]["chapters"][CHAPTER]["nodes"][0]["text"] = "Changed snapshot"
    grant = verify(sign(scope, request))
    with pytest.raises(DispatchRejected):
        execute_dispatch(grant, store, now=lambda: NOW, _test_transport=transport("openai", calls))
    assert not calls and grant.credential is None
    with closing(sqlite3.connect(store.path)) as db:
        assert db.execute("select count(*) from receipts").fetchone()[0] == 0
    request["input"]["book"]["title"] = KEY
    with pytest.raises(DispatchRejected): verify(sign(scope, request))


@pytest.mark.parametrize("failure", ["provider-timeout", "invalid-output", "domain-output", "save-timeout", "reserve-timeout", "expiry"])
def test_ambiguous_outcome_fences_retries(failure, tmp_path):
    scope, request = fixture()
    store, calls = SqliteReceipts(tmp_path / "r.db"), []
    original_save, original_reserve = store.save, store.reserve
    def unavailable(*args): raise ReceiptUnavailable("private detail must not escape HTTP")
    def reserve(*args): original_reserve(*args); unavailable()
    def handler(req):
        if failure == "provider-timeout": raise httpx.ReadTimeout(KEY)
        if failure == "invalid-output": return httpx.Response(200, json={"echo": KEY})
        payload = copy.deepcopy(EDIT)
        payload["operation"]["payload"]["nodeId"] = "wrong-domain-node"
        return httpx.Response(200, json=response_for("openai", "propose_edit", payload))
    if failure == "save-timeout": store.save = unavailable
    if failure == "reserve-timeout": store.reserve = reserve
    clock = iter([NOW, NOW + 60]) if failure == "expiry" else None
    handler = handler if failure in ("provider-timeout", "invalid-output", "domain-output") else None
    with pytest.raises((ReceiptUnavailable, ProviderOutcomeUnknown)):
        execute_dispatch(verify(sign(scope, request)), store, now=lambda: next(clock) if clock else NOW,
            _test_transport=transport("openai", calls, handler))
    store.save, store.reserve = original_save, original_reserve
    with pytest.raises(ReceiptConflict):
        execute_dispatch(verify(sign(scope, request)), store, now=lambda: NOW, _test_transport=transport("openai", calls))
    assert len(calls) == (0 if failure in ("reserve-timeout", "expiry") else 1)


def test_concurrent_submissions_only_dispatch_once(tmp_path):
    scope, request = fixture()
    path = tmp_path / "r.db"
    SqliteReceipts(path)
    barrier, calls = threading.Barrier(4), []
    def work():
        barrier.wait()
        try:
            return execute_dispatch(verify(sign(scope, request)), SqliteReceipts(path), now=lambda: NOW,
                _test_transport=transport("openai", calls))["status"]
        except ReceiptConflict:
            return "unresolved"
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: work(), range(4)))
    assert "succeeded" in results and len(calls) == 1


def test_customer_receipts_use_one_existing_private_table():
    assert CustomerTextResultStore.table == "ai_review_service_receipts"


def test_key_rotation_preserves_job_fingerprint_not_credential_fingerprints():
    scope, request = fixture()
    first = verify(sign(scope, request))
    second = verify_dispatch(sign(scope, request, key=b"x" * 32, kid="rotated", apiKey="different-synthetic-credential"),
        {"rotated": b"x" * 32}, now=NOW)
    assert first.fingerprint == second.fingerprint
    # A replaced credential requires a NEW revision and cannot alter an old job.
    scope["credentialRevision"] += 1
    assert verify(sign(scope, request)).fingerprint != first.fingerprint


@pytest.mark.parametrize("field,value", [("ownerId", "not-a-uuid"), ("credentialRevision", True), ("credentialRevision", 0),
    ("provider", "custom-endpoint"), ("agentType", "story_blueprint"), ("agentType", "narrator"),
    ("expectedRequestSha256", "https://untrusted.invalid"), ("additional", "forbidden")])
def test_signed_invalid_scope_is_not_coerced(field, value):
    scope, request = fixture()
    scope[field] = value
    with pytest.raises(DispatchRejected): verify(sign(scope, request))


@pytest.mark.parametrize("field,value", [("model", "wrong"), ("workspaceId", "wrong"), ("provider", "google"),
    ("customerDispatchSha256", "a" * 64), ("status", "failed"), ("usage", None),
    ("usage", {"estimatedCostUsd": 0}), ("diagnostics", [{"message": KEY}])])
def test_mismatched_or_sensitive_saved_receipts_never_escape(field, value, tmp_path):
    scope, request = fixture()
    store, calls = SqliteReceipts(tmp_path / "r.db"), []
    result = execute_dispatch(verify(sign(scope, request)), store, now=lambda: NOW, _test_transport=transport("openai", calls))
    result[field] = value
    # Corrupt-storage fixture; real DB immutability forbids this rewrite.
    store.reserve = lambda *args: result
    with pytest.raises(ReceiptConflict):
        execute_dispatch(verify(sign(scope, request)), store, now=lambda: NOW, _test_transport=transport("openai", calls))
    assert len(calls) == 1


def test_supabase_receipt_adapter_reserves_before_dispatch_and_replays(monkeypatch):
    scope, request = fixture()
    rows, operations, calls = {}, [], []
    monkeypatch.setenv("SUPABASE_URL", "https://fixture.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-database-token")
    monkeypatch.setenv("AI_SERVICE_TOKEN", "synthetic-service-auth")
    def database(self, method, *, params=None, payload=None):
        assert self.table == "ai_review_service_receipts"
        operations.append(method)
        if method == "POST":
            assert set(payload) == {"job_id", "request_sha256"}
            job = payload["job_id"]
            if job in rows: return httpx.Response(409)
            rows[job] = {**payload, "result_json": None}
            return httpx.Response(201)
        row = rows[params["job_id"][3:]]
        if method == "PATCH":
            assert params["request_sha256"] == "eq." + row["request_sha256"]
            assert params["result_json"] == "is.null" and row["result_json"] is None
            row.update(payload)
        return httpx.Response(200, json=[row])
    monkeypatch.setattr(CustomerTextResultStore, "_request", database)
    def provider(req):
        assert rows[scope["jobId"]]["result_json"] is None and operations == ["POST"]
        return httpx.Response(200, json=response_for("openai", "propose_edit", copy.deepcopy(EDIT)))
    result = execute_dispatch(verify(sign(scope, request)), CustomerTextResultStore(), now=lambda: NOW,
        _test_transport=transport("openai", calls, provider))
    replay = execute_dispatch(verify(sign(scope, request)), CustomerTextResultStore(), now=lambda: NOW,
        _test_transport=transport("openai", calls))
    assert result == replay and operations == ["POST", "PATCH", "POST", "GET"] and len(calls) == 1
    assert KEY not in json.dumps(rows) and "apiKey" not in json.dumps(rows)
