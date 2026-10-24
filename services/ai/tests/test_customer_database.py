"""Synthetic PostgREST boundary tests; never contacts a database/provider."""
import copy
import json
import sys
import threading
from dataclasses import FrozenInstanceError
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from customer_database import CustomerAiDatabase
from customer_protocol import MAX_BYTES
from result_store import ReceiptConflict, ReceiptUnavailable
from test_customer_dispatch import fixture

DB_KEY = "synthetic-private-database-token"
ROOT = "https://database.invalid"
TABLE = "/rest/v1/ai_review_service_receipts"
RPC = "/rest/v1/rpc/customer_ai_dispatch_authorized"
COLUMNS = "job_id,request_sha256,result_json"
JOB = "00000000-0000-4000-8000-000000000009"
HASH = "a" * 64
RESULT = {"jobId": JOB, "customerDispatchSha256": HASH, "status": "succeeded", "text": "Rain 雨."}


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def reject(*args, **kwargs):
        raise AssertionError("Real network is forbidden in customer database tests.")
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", reject)


class DatabaseFixture:
    """HTTP contract emulator, NOT proof of SQL authorization/ACLs."""
    def __init__(self):
        self.rows, self.calls = {}, []
        self.allowed = True
        self.lock = threading.Lock()

    def send(self, request):
        with self.lock:
            payload = json.loads(request.content) if request.content else None
            self.calls.append((request.method, request.url.path, dict(request.url.params), payload))
            assert request.url.host == "database.invalid"
            assert request.headers["apikey"] == DB_KEY
            assert request.headers["authorization"] == "Bearer " + DB_KEY
            assert request.headers["prefer"] == "return=representation"
            assert request.headers["accept-profile"] == "public" and request.headers["content-profile"] == "public"
            assert request.headers["accept-encoding"] == "identity"
            if request.url.path == RPC:
                assert request.method == "POST" and set(payload) == {"p_scope"} and not request.url.query
                return httpx.Response(200, json=self.allowed)
            assert request.url.path == TABLE and request.url.params["select"] == COLUMNS
            if request.method == "POST":
                assert set(payload) == {"job_id", "request_sha256"}
                if payload["job_id"] in self.rows:
                    return httpx.Response(409, text=DB_KEY)  # Error body must be discarded.
                self.rows[payload["job_id"]] = {**payload, "result_json": None}
                return httpx.Response(201, json=[self.rows[payload["job_id"]]])
            row = self.rows.get(request.url.params["job_id"][3:])
            if request.method == "GET":
                assert request.url.params["limit"] == "2"
                return httpx.Response(200, json=[row] if row else [])
            assert request.method == "PATCH" and set(payload) == {"result_json"}
            assert request.url.params["result_json"] == "is.null"
            if not row or request.url.params["request_sha256"] != "eq." + row["request_sha256"] or row["result_json"] is not None:
                return httpx.Response(200, json=[])
            row.update(payload)
            return httpx.Response(200, json=[row])

    def adapter(self):
        return CustomerAiDatabase(ROOT, DB_KEY, _test_transport=httpx.MockTransport(self.send))


def adapter(handler):
    return CustomerAiDatabase(ROOT, DB_KEY, _test_transport=httpx.MockTransport(handler))


@pytest.mark.parametrize("url", ["", "http://database.invalid", "http://localhost", "https://", "https://u:p@host.invalid",
    "https://host.invalid/path", "https://host.invalid?", "https://host.invalid#", "https://host.invalid/../",
    "https://host.invalid\\path", "https://host.invalid/%2f", "https://host.invalid:0", "https://host.invalid:65536",
    " https://host.invalid", "https://host.invalid\n", "https://💻.invalid"])
def test_configuration_rejects_untrusted_or_ambiguous_urls(url):
    with pytest.raises(ReceiptUnavailable) as error:
        CustomerAiDatabase(url, DB_KEY)
    assert DB_KEY not in str(error.value)


@pytest.mark.parametrize("url", ["http://localhost:54321", "http://127.0.0.1:54321/", "http://[::1]:54321"])
def test_loopback_requires_explicit_operator_opt_in(url):
    with pytest.raises(ReceiptUnavailable): CustomerAiDatabase(url, DB_KEY)
    assert CustomerAiDatabase(url, DB_KEY, allow_loopback_http=True).url == url.rstrip("/")
    with pytest.raises(ReceiptUnavailable): CustomerAiDatabase("http://localhost.attacker.invalid", DB_KEY, allow_loopback_http=True)


@pytest.mark.parametrize("key", [None, "short", "\n" + DB_KEY, DB_KEY + " ", "x" * 4097, "🚫" * 32])
def test_invalid_keys_never_leak_in_error(key):
    with pytest.raises(ReceiptUnavailable) as error: CustomerAiDatabase(ROOT, key)
    assert str(error.value) == "Explicit trusted customer database configuration is required."


def test_explicit_configuration_is_frozen_and_environment_cannot_activate_it(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://ambient.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "ambient-forbidden-key")
    monkeypatch.setenv("HTTPS_PROXY", "http://ambient.invalid")
    with pytest.raises(TypeError): CustomerAiDatabase()
    db = DatabaseFixture().adapter()
    assert ROOT not in repr(db) and DB_KEY not in repr(db)
    with pytest.raises(FrozenInstanceError): db.service_key = "changed"
    assert db.authorize_scope(fixture()[0]) is True


@pytest.mark.parametrize("response", [True, False, None, 1, 0, "true", {"allowed": True}, [True]])
def test_only_literal_true_authorizes_and_scope_is_non_secret(response):
    scope, _ = fixture()
    calls = []
    def send(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json=response)
    db = adapter(send)
    assert db.authorize_scope(scope) is (response is True)
    assert calls == [{"p_scope": scope}] and DB_KEY not in json.dumps(calls)


@pytest.mark.parametrize("field,value", [("apiKey", DB_KEY), ("ownerId", "wrong"), ("credentialRevision", True),
    ("provider", "unknown"), ("expectedRequestSha256", "bad"), ("policy", {"model": "unknown"})])
def test_invalid_scope_fails_before_any_network(field, value):
    scope, _ = fixture()
    scope[field] = value
    calls = []
    db = adapter(lambda request: calls.append(request))
    assert db.authorize_scope(scope) is False and not calls


@pytest.mark.parametrize("case", ["redirect", "server", "html", "encoding", "oversize", "chunked", "duplicate", "nan", "deep", "timeout", "deadline"])
def test_malformed_database_response_fails_closed_without_echo_or_retry(case, monkeypatch):
    calls = []
    class Chunks(httpx.SyncByteStream):
        def __iter__(self):
            yield b" " * 6000
            yield b" " * 6000
            yield b"true"
    if case == "deadline":
        ticks = iter([0, 16])
        monkeypatch.setattr("customer_database.time", SimpleNamespace(monotonic=lambda: next(ticks)))
    def send(request):
        calls.append(request)
        if case == "timeout": raise httpx.ReadTimeout(DB_KEY)
        if case == "redirect": return httpx.Response(307, headers={"location": "https://untrusted.invalid"}, text=DB_KEY)
        if case == "server": return httpx.Response(500, text=DB_KEY)
        if case == "html": return httpx.Response(200, text=DB_KEY)
        if case == "encoding": return httpx.Response(200, headers={"content-encoding": "br", "content-type": "application/json"}, stream=Chunks())
        if case == "oversize": return httpx.Response(200, json=True, headers={"content-length": "8193"})
        if case == "chunked": return httpx.Response(200, headers={"content-type": "application/json"}, stream=Chunks())
        raw = b'{"x":true,"x":false}' if case == "duplicate" else b"NaN" if case == "nan" else b"[" * 2000 if case == "deep" else b"true"
        return httpx.Response(200, content=raw, headers={"content-type": "application/json"})
    assert adapter(send).authorize_scope(fixture()[0]) is False
    assert len(calls) == 1


def test_http_client_disables_ambient_proxies_redirects_and_bounds_time(monkeypatch):
    real, observed = httpx.Client, []
    def client(**kwargs):
        observed.append(kwargs)
        return real(**kwargs)
    monkeypatch.setattr("customer_database.httpx.Client", client)
    assert DatabaseFixture().adapter().authorize_scope(fixture()[0])
    assert observed[0]["trust_env"] is False and observed[0]["follow_redirects"] is False
    assert observed[0]["timeout"].read == 5 and observed[0]["timeout"].connect == 5


def test_receipts_reserve_once_save_cas_and_recover_with_new_adapter():
    fixture_db = DatabaseFixture()
    db = fixture_db.adapter()
    assert db.reserve(JOB, HASH) is None
    with pytest.raises(ReceiptConflict): fixture_db.adapter().reserve(JOB, HASH)
    db.save(JOB, HASH, RESULT)
    assert fixture_db.adapter().reserve(JOB, HASH) == RESULT
    with pytest.raises(ReceiptUnavailable): db.save(JOB, HASH, RESULT)
    with pytest.raises(ReceiptConflict): db.reserve(JOB, "b" * 64)
    assert fixture_db.rows[JOB]["result_json"] == RESULT
    assert all(method in ("POST", "GET", "PATCH") for method, *_ in fixture_db.calls)
    assert DB_KEY not in json.dumps(fixture_db.rows)


@pytest.mark.parametrize("job,fingerprint", [(JOB + ",x.eq.y", HASH), (None, HASH), (JOB, "a" * 63), (JOB, "z" * 64), (JOB, True)])
def test_receipt_identifiers_are_validated_before_network(job, fingerprint):
    calls = []
    db = adapter(lambda request: calls.append(request))
    with pytest.raises(ReceiptUnavailable): db.reserve(job, fingerprint)
    with pytest.raises(ReceiptUnavailable): db.save(job, fingerprint, RESULT)
    assert not calls


@pytest.mark.parametrize("case", ["empty", "many", "object", "wrong-job", "wrong-hash", "extra", "missing", "saved", "list"])
def test_reservation_requires_exact_new_receipt_representation(case):
    row = {"job_id": JOB, "request_sha256": HASH, "result_json": None}
    if case == "wrong-job": row["job_id"] = "wrong"
    if case == "wrong-hash": row["request_sha256"] = "b" * 64
    if case == "extra": row["credential"] = DB_KEY
    if case == "missing": del row["result_json"]
    if case == "saved": row["result_json"] = RESULT
    if case == "list": row["result_json"] = []
    rows = [] if case == "empty" else [row, row] if case == "many" else row if case == "object" else [row]
    with pytest.raises(ReceiptUnavailable) as error:
        adapter(lambda request: httpx.Response(201, json=rows)).reserve(JOB, HASH)
    assert DB_KEY not in str(error.value)


@pytest.mark.parametrize("result", [None, [], "saved", {"huge": "x" * MAX_BYTES}])
def test_existing_unresolved_invalid_or_oversized_result_never_allows_regeneration(result):
    fixture_db = DatabaseFixture()
    fixture_db.rows[JOB] = {"job_id": JOB, "request_sha256": HASH, "result_json": result}
    with pytest.raises(ReceiptConflict): fixture_db.adapter().reserve(JOB, HASH)
    assert [x[0] for x in fixture_db.calls] == ["POST", "GET"]


@pytest.mark.parametrize("case", ["empty", "many", "wrong-job", "wrong-hash", "different", "null", "extra", "type"])
def test_save_requires_exact_same_result_not_just_one_returned_row(case):
    result = copy.deepcopy(RESULT)
    row = {"job_id": JOB, "request_sha256": HASH, "result_json": result}
    if case == "wrong-job": row["job_id"] = "wrong"
    if case == "wrong-hash": row["request_sha256"] = "b" * 64
    if case == "different": result["text"] = "Other private text"
    if case == "null": row["result_json"] = None
    if case == "extra": row["extra"] = DB_KEY
    if case == "type": result["text"] = True
    rows = [] if case == "empty" else [row, row] if case == "many" else [row]
    with pytest.raises(ReceiptUnavailable) as error:
        adapter(lambda request: httpx.Response(200, json=rows)).save(JOB, HASH, RESULT)
    assert DB_KEY not in str(error.value)


@pytest.mark.parametrize("change", [{"jobId": "wrong"}, {"customerDispatchSha256": "b" * 64}, {"status": "failed"},
    {"text": float("nan")}, {"text": DB_KEY}, {"text": "x" * MAX_BYTES}])
def test_bad_or_sensitive_result_never_reaches_database(change):
    calls = []
    with pytest.raises(ReceiptUnavailable):
        adapter(lambda request: calls.append(request)).save(JOB, HASH, {**RESULT, **change})
    assert not calls
