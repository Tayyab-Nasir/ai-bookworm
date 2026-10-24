"""One explicitly authorized customer-key request; no environment credentials.

This is an adapter, NOT an authorization boundary. Do not register it as a
default provider or expose it over HTTP before payer-bound jobs, credential
revision checks, durable dispatch fencing and reconciliation are implemented.
"""
from __future__ import annotations

import hmac
import re
import threading
import time

import httpx

from customer_protocol import (
    MAX_BYTES, PROVIDERS, CustomerRequestError, ModelPolicy,
    parse_customer_response, prepare_customer_request, strict_json,
)
from gateway import Completion, ProviderOutcomeUnknown


def _contains_credential(value, credential: str) -> bool:
    if isinstance(value, str):
        return credential in value
    if isinstance(value, dict):
        return any(credential in key or _contains_credential(item, credential) for key, item in value.items())
    if isinstance(value, list):
        return any(_contains_credential(item, credential) for item in value)
    return False


class CustomerProvider:
    """A single-use instance owns one key; it never mutates shared clients/env.

    `_test_transport` is an in-process deterministic test seam, never an HTTP
    parameter. Production always constructs a zero-retry verified TLS transport.
    """

    def __init__(self, name: str, *, api_key: str, policy: ModelPolicy, expected_request_sha256: str,
                 _test_transport: httpx.MockTransport | None = None):
        if not (
            name in PROVIDERS and type(policy) is ModelPolicy
            and type(api_key) is str and 16 <= len(api_key) <= 4096
            and all(33 <= ord(char) <= 126 for char in api_key)
            and type(expected_request_sha256) is str and re.fullmatch(r"[a-f0-9]{64}", expected_request_sha256)
            and (_test_transport is None or type(_test_transport) is httpx.MockTransport)
        ):
            raise CustomerRequestError("An explicit credential and bound request are required.")
        self.name = name
        self._api_key: str | None = api_key
        self._policy = policy
        self._expected_hash = expected_request_sha256
        self._test_transport = _test_transport
        self._lock = threading.Lock()
        self._consumed = False
        self._dispatched = False

    @property
    def outcome_requires_review(self) -> bool:
        # BaseAgent must not turn a domain-invalid *paid* completion into a
        # refundable failure after a successful transport/schema validation.
        return self._dispatched

    def complete(self, messages: list[dict], tools: list[dict], model: str, *,
                 max_output_tokens: int | None = None, tool_choice: dict | str | None = None) -> Completion:
        request = prepare_customer_request(self.name, self._policy, messages, tools, model,
                                           max_output_tokens=max_output_tokens, tool_choice=tool_choice)
        if not hmac.compare_digest(request.sha256, self._expected_hash):
            raise CustomerRequestError("Customer-provider request identity changed before dispatch.")
        with self._lock:
            if self._consumed:
                raise CustomerRequestError("Customer-provider instance was already consumed; do not retry.")
            self._consumed = True
            key, self._api_key = self._api_key, None
        headers = {"Accept": "application/json", "Content-Type": "application/json", "Accept-Encoding": "identity"}
        if self.name == "google":
            headers["x-goog-api-key"] = key
        else:
            headers["Authorization"] = "Bearer " + key
        if self.name == "anthropic":
            headers["anthropic-version"] = "2026-10-21"
        try:
            # No ambient proxies/base URLs, automatic retries, redirects, auth
            # discovery or platform-key fallback. No long-lived cookie jar.
            transport = self._test_transport or httpx.HTTPTransport(retries=0, verify=True, trust_env=False)
            with httpx.Client(transport=transport, trust_env=False, follow_redirects=False,
                              timeout=httpx.Timeout(120, connect=10, write=30, pool=10)) as client:
                self._dispatched = True
                started = time.monotonic()
                with client.stream("POST", request.url, content=request.body, headers=headers) as response:
                    if response.status_code != 200 or response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                        raise ValueError("Provider response was not a completion.")
                    if response.headers.get("content-encoding", "identity").lower() != "identity":
                        raise ValueError("Compressed provider responses are unsupported.")
                    length = response.headers.get("content-length")
                    if length is not None and (not re.fullmatch(r"[0-9]{1,10}", length) or int(length) > MAX_BYTES):
                        raise ValueError("Provider response exceeded the bound.")
                    body = bytearray()
                    # Do not buffer to a target chunk size: inspect each network
                    # chunk so a slow trickle cannot evade the elapsed-time check.
                    # A blocked read still has its separate 120-second timeout.
                    for chunk in response.iter_bytes():
                        if time.monotonic() - started > 180 or len(body) + len(chunk) > MAX_BYTES:
                            raise ValueError("Provider response exceeded the bound.")
                        body.extend(chunk)
                    data = strict_json(bytes(body))
                    # Never promote echoed credentials into output or receipts,
                    # including escaped JSON strings. No raw error body escapes.
                    if _contains_credential(data, key):
                        raise ValueError("Provider response could not be retained.")
                    header_name = "request-id" if self.name == "anthropic" else "x-request-id"
                    request_id = response.headers.get(header_name) if self.name in ("openai", "anthropic") else None
                    if request_id and key in request_id:
                        raise ValueError("Provider response could not be retained.")
                    completion = parse_customer_response(request, data, request_id)
                    # Function arguments on Responses/Chat APIs contain a
                    # second JSON layer; check its decoded values as well.
                    if _contains_credential({"text": completion.text, "calls": completion.tool_calls}, key):
                        raise ValueError("Provider output could not be retained.")
                    return completion
        except Exception:
            # Includes errors after sending, malformed responses and exceptions
            # containing request headers. Never auto-retry/refund on ambiguity.
            raise ProviderOutcomeUnknown("Customer-provider outcome requires reconciliation; do not retry.") from None
        finally:
            headers.clear()
            key = None  # releases our reference; Python cannot guarantee zeroing
