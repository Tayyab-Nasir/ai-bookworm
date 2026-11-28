"""Explicit service-only customer dispatch authority and durable receipts.

No environment lookup, credential resolution, provider call, job creation,
retry, refund, receipt deletion or activation lives here. Only trusted operator
configuration may construct this adapter; never accept its URL/key from users.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import httpx

from customer_dispatch import Scope, UUID
from customer_protocol import MAX_BYTES, json_bytes, strict_json
from result_store import ReceiptConflict, ReceiptUnavailable

_RPC = "/rest/v1/rpc/customer_ai_dispatch_authorized"
_TABLE = "/rest/v1/ai_review_service_receipts"
_COLUMNS = "job_id,request_sha256,result_json"
_RECEIPT_LIMIT = 6_001_024  # Existing SQL result limit plus row metadata.
_UNAVAILABLE = "Customer database outcome is unconfirmed. Recover before retrying."
_CONFLICT = "Customer receipt is unresolved or different. Do not regenerate."


def _require(condition):
    if not condition:
        raise ValueError("Invalid private database contract.")


def _decode(data: bytes):
    def pairs(items):
        value = {}
        for key, item in items:
            _require(key not in value)
            value[key] = item
        return value

    def invalid(_):
        raise ValueError("Invalid JSON constant.")

    return json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=invalid)


@dataclass(frozen=True, repr=False)
class CustomerAiDatabase:
    """Immutable configuration; every authorization goes to the existing RPC.

    Fixed paths and no ambient proxy/.netrc/TLS settings. Local HTTP is opt-in
    and restricted to literal loopback hosts. Instances hold no authorization
    cache, sessions, user keys or manuscript data between operations.
    """

    url: str = field(repr=False)
    service_key: str = field(repr=False)
    allow_loopback_http: bool = False
    _test_transport: httpx.MockTransport | None = field(default=None, repr=False)

    def __post_init__(self):
        try:
            _require(type(self.url) is str and 1 <= len(self.url) <= 2048
                     and self.url.isascii() and self.url.isprintable()
                     and not any(c in self.url for c in (" ", "\\", "?", "#", "%")))
            parts = urlsplit(self.url)
            _require(parts.hostname is not None and parts.username is None and parts.password is None
                     and parts.path in ("", "/") and (parts.port is None or 1 <= parts.port <= 65535))
            _require(type(self.allow_loopback_http) is bool)
            _require(parts.scheme == "https" or (parts.scheme == "http" and self.allow_loopback_http
                     and parts.hostname in ("localhost", "127.0.0.1", "::1")))
            _require(type(self.service_key) is str
                     and re.fullmatch(r"[A-Za-z0-9_./+=-]{16,4096}", self.service_key) is not None)
            _require(self._test_transport is None or isinstance(self._test_transport, httpx.MockTransport))
            object.__setattr__(self, "url", self.url.rstrip("/"))
        except Exception:
            raise ReceiptUnavailable("Explicit trusted customer database configuration is required.") from None

    def _request(self, method, path, *, params=None, payload=None, statuses=(200,), limit=8192):
        # Call sites below are the complete operation allowlist, not a user API.
        try:
            _require((method, path) in (("POST", _RPC), ("POST", _TABLE), ("GET", _TABLE), ("PATCH", _TABLE)))
            encoded = None if payload is None else json.dumps(payload, ensure_ascii=False,
                sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
            _require(encoded is None or len(encoded) <= MAX_BYTES + 8192)
            deadline = time.monotonic() + 15
            with httpx.Client(timeout=httpx.Timeout(5), follow_redirects=False, trust_env=False,
                              transport=self._test_transport) as client:
                with client.stream(method, self.url + path, params=params, content=encoded,
                    headers={"apikey": self.service_key, "authorization": "Bearer " + self.service_key,
                             "content-type": "application/json", "accept": "application/json",
                             "accept-profile": "public", "content-profile": "public",
                             "accept-encoding": "identity", "prefer": "return=representation"}) as response:
                    _require(time.monotonic() < deadline and response.status_code in statuses)
                    if response.status_code == 409:
                        # Discard error bodies (which can contain private database data).
                        return 409, None
                    _require(response.headers.get("content-encoding", "identity").lower() == "identity"
                             and response.headers.get("content-type", "").split(";", 1)[0].strip().lower() == "application/json")
                    length = response.headers.get("content-length")
                    _require(length is None or (length.isascii() and length.isdecimal()
                             and len(length) <= 10 and int(length) <= limit))
                    data = bytearray()
                    try:
                        for chunk in response.iter_bytes(chunk_size=65536):
                            _require(time.monotonic() < deadline and len(data) + len(chunk) <= limit)
                            data.extend(chunk)
                        value = _decode(bytes(data))
                        _require(time.monotonic() < deadline)
                        return response.status_code, value
                    finally:
                        data[:] = b"\0" * len(data)
        except Exception:
            # No response bodies, URL/key, request values or chained transport errors.
            raise ReceiptUnavailable(_UNAVAILABLE) from None

    def authorize_scope(self, value: dict) -> bool:
        try:
            _require(type(value) is dict)
            # Copy/validate before network I/O; no request/credential fields allowed.
            scope = Scope.model_validate(strict_json(json_bytes(value)))
            scope.policy.policy()
            _, allowed = self._request("POST", _RPC, payload={"p_scope": scope.model_dump()})
            return allowed is True
        except Exception:
            return False

    @staticmethod
    def _identity(job_id, fingerprint):
        try:
            _require(type(job_id) is str and re.fullmatch(UUID, job_id) is not None
                     and type(fingerprint) is str and re.fullmatch(r"[a-f0-9]{64}", fingerprint) is not None)
        except Exception:
            raise ReceiptUnavailable(_UNAVAILABLE) from None

    @staticmethod
    def _row(rows, job_id, fingerprint):
        _require(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict)
        row = rows[0]
        _require(set(row) == {"job_id", "request_sha256", "result_json"}
                 and row["job_id"] == job_id and row["request_sha256"] == fingerprint)
        _require(row["result_json"] is None or type(row["result_json"]) is dict)
        return row

    def reserve(self, job_id: str, fingerprint: str) -> dict | None:
        self._identity(job_id, fingerprint)
        status, rows = self._request("POST", _TABLE, params={"select": _COLUMNS},
            payload={"job_id": job_id, "request_sha256": fingerprint}, statuses=(201, 409), limit=_RECEIPT_LIMIT)
        if status == 201:
            try:
                _require(self._row(rows, job_id, fingerprint)["result_json"] is None)
                return None
            except Exception:
                # Even malformed success may have reserved the row. Never retry.
                raise ReceiptUnavailable(_UNAVAILABLE) from None
        _, rows = self._request("GET", _TABLE,
            params={"job_id": "eq." + job_id, "select": _COLUMNS, "limit": "2"}, limit=_RECEIPT_LIMIT)
        try:
            result = self._row(rows, job_id, fingerprint)["result_json"]
            _require(type(result) is dict)
            return strict_json(json_bytes(result))
        except Exception:
            raise ReceiptConflict(_CONFLICT) from None

    def save(self, job_id: str, fingerprint: str, result: dict) -> None:
        self._identity(job_id, fingerprint)
        try:
            _require(type(result) is dict and result.get("jobId") == job_id
                     and result.get("customerDispatchSha256") == fingerprint and result.get("status") == "succeeded")
            encoded = json_bytes(result)
            _require(self.service_key.encode() not in encoded)
            detached = strict_json(encoded)
        except Exception:
            raise ReceiptUnavailable(_UNAVAILABLE) from None
        _, rows = self._request("PATCH", _TABLE, params={"job_id": "eq." + job_id,
            "request_sha256": "eq." + fingerprint, "result_json": "is.null", "select": _COLUMNS},
            payload={"result_json": detached}, limit=_RECEIPT_LIMIT)
        try:
            saved = self._row(rows, job_id, fingerprint)["result_json"]
            _require(type(saved) is dict and json_bytes(saved) == encoded)
        except Exception:
            raise ReceiptUnavailable(_UNAVAILABLE) from None
