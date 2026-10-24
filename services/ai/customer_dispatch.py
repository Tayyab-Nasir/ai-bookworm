"""Private signed customer-key handoff, not a public job-authorization API.

No environment credentials, default provider, pricing, refund or document writes.
The HTTP factory is intentionally not mounted in main.py. Database payer/lease/
revocation authorization must exist before integration. An HMAC is not that check.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import time
from dataclasses import dataclass, field
from typing import Literal, Protocol

import httpx
from pydantic import BaseModel, ConfigDict, Field

from agents.copyeditor import get_agent
from customer_protocol import MAX_BYTES, ModelPolicy, json_bytes, prepare_customer_request, strict_json
from customer_provider import CustomerProvider, _contains_credential
from gateway import ProviderOutcomeUnknown
from result_store import AiReviewResultStore, ReceiptConflict, ReceiptUnavailable
from tools import InMemoryExecutor

FORMAT = "bookworm-customer-dispatch-v1"
UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


class DispatchRejected(ValueError):
    def __init__(self):
        super().__init__("Customer dispatch is invalid or expired. No generation was started.")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)


class Policy(StrictModel):
    model: str
    responseModels: list[str]
    maxOutputTokens: int = Field(ge=1, le=128000)
    upstream: str | None
    responseUpstreams: list[str]

    def policy(self):
        return ModelPolicy(self.model, tuple(self.responseModels), self.maxOutputTokens,
                           self.upstream, tuple(self.responseUpstreams))


class PreparationScope(StrictModel):
    workspaceId: str = Field(pattern=UUID)
    bookId: str = Field(pattern=UUID)
    provider: Literal["openai", "anthropic", "google", "openrouter", "xai"]
    agentType: Literal["writer", "proofreader", "copyeditor", "consistency", "metadata", "bookbible"]
    policy: Policy


class Scope(PreparationScope):
    grantId: str = Field(pattern=UUID)
    jobId: str = Field(pattern=UUID)
    ownerId: str = Field(pattern=UUID)
    connectionId: str = Field(pattern=UUID)
    credentialRevision: int = Field(ge=1, le=2147483647)
    leaseToken: str = Field(pattern=UUID)
    expectedRequestSha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class ContextPolicy(StrictModel):
    includeBookBible: bool = False
    includeStyleGuide: bool = True
    includeRelatedContext: bool = True
    semanticTopK: int = Field(default=5, ge=1, le=20)
    maxTokens: int = Field(default=4096, ge=256, le=16000)


class Input(StrictModel):
    chapterIds: list[str] = Field(default_factory=list, max_length=100)
    chapters: dict[str, dict] = Field(default_factory=dict)
    book: dict = Field(default_factory=dict)
    styleGuide: dict = Field(default_factory=dict)
    bookBible: list[dict] = Field(default_factory=list)
    relatedContext: list[dict] = Field(default_factory=list, max_length=20)
    userInstruction: str | None = None


class AgentRequest(StrictModel):
    input: Input
    contextPolicy: ContextPolicy = Field(default_factory=ContextPolicy)


@dataclass(repr=False)
class VerifiedDispatch:
    scope: Scope
    request: AgentRequest = field(repr=False)
    credential: str | None = field(repr=False)
    fingerprint: str
    expires_at: int

    def clear(self):
        self.credential = None  # Reference release, not guaranteed Python zeroing.


def verify_dispatch(body: bytes, keys: dict[str, bytes], *, now: int | None = None) -> VerifiedDispatch:
    """Verify MAC before decoding the secret-bearing inner JSON. Errors are static."""
    try:
        outer = strict_json(body)
        if set(outer) != {"keyId", "payload", "signature"}:
            raise ValueError()
        kid, encoded, signature = outer["keyId"], outer["payload"], outer["signature"]
        if (type(kid) is not str or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", kid)
            or type(encoded) is not str or not re.fullmatch(r"[A-Za-z0-9_-]+", encoded)
            or type(signature) is not str or not re.fullmatch(r"[a-f0-9]{64}", signature)):
            raise ValueError()
        key = keys.get(kid)
        if type(key) is not bytes or len(key) != 32:
            raise ValueError()
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        if len(raw) > 524288 or base64.urlsafe_b64encode(raw).decode().rstrip("=") != encoded:
            raise ValueError()
        expected = hmac.new(key, (FORMAT + "\n" + kid + "\n").encode() + raw, "sha256").hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise ValueError()
        payload = strict_json(raw)
        if set(payload) != {"format", "scope", "requestJson", "apiKey", "issuedAt", "expiresAt"} or payload["format"] != FORMAT:
            raise ValueError()
        issued, expires = payload["issuedAt"], payload["expiresAt"]
        current = int(time.time()) if now is None else now
        if (type(current) is not int or type(issued) is not int or type(expires) is not int
            or issued < 1 or issued > current + 5 or not 1 <= expires - issued <= 60 or current >= expires):
            raise ValueError()
        scope = Scope.model_validate(payload["scope"])
        scope.policy.policy()  # Validate exact model policy before receipt I/O.
        credential, request_json = payload["apiKey"], payload["requestJson"]
        if type(credential) is not str or not re.fullmatch(r"[A-Za-z0-9_\-./+=]{16,4096}", credential) or type(request_json) is not str:
            raise ValueError()
        parsed = strict_json(request_json)
        if _contains_credential(parsed, credential) or _contains_credential(payload["scope"], credential):
            raise ValueError()
        request = AgentRequest.model_validate(parsed)
        # Immutable grant/lease/source identity; never includes the provider key,
        # its hash, signature, signing key ID or fresh envelope timestamps.
        fingerprint = hashlib.sha256(json_bytes({"format": FORMAT, "scope": scope.model_dump(),
            "sourceSha256": hashlib.sha256(request_json.encode()).hexdigest()})).hexdigest()
        return VerifiedDispatch(scope, request, credential, fingerprint, expires)
    except Exception:
        raise DispatchRejected() from None


class ReceiptStore(Protocol):
    def reserve(self, job_id: str, fingerprint: str) -> dict | None: ...
    def save(self, job_id: str, fingerprint: str, result: dict) -> None: ...


class CustomerTextResultStore(AiReviewResultStore):
    """One job-ID fence across all customer text types using the existing table.

    Unique reservation and immutable request/result are enforced by existing
    SQL. Verify effective live ACLs before activation; never delete/release a
    reservation to retry. Never use per-agent tables for customer jobs.
    A future DB authorizer must exclude managed jobs and validate the payer.
    """

    label = "Customer text"


def prepare_customer_agent(s: PreparationScope, req: AgentRequest):
    """Same actual prompt/tools/wire for read-only preparation and dispatch."""
    # PostgreSQL JSONB reorders object keys. Canonicalize all nested source data
    # before agents embed it in prompt strings; preserve array/reading order.
    content = strict_json(json_bytes(req.input.model_dump()))
    executor = InMemoryExecutor(chapters=content["chapters"], style_guide=content["styleGuide"],
                                bible=content["bookBible"], search_results=content["relatedContext"])
    # No provider or key is needed to prepare/validate a request.
    agent = get_agent(s.agentType, None, executor, s.policy.model)
    agent.max_output_tokens = min(s.policy.maxOutputTokens, 6000) if s.agentType == "bookbible" else s.policy.maxOutputTokens
    request = {"workspaceId": s.workspaceId, "bookId": s.bookId, "chapterIds": content["chapterIds"],
               "book": content["book"], "userInstruction": content["userInstruction"],
               "contextPolicy": req.contextPolicy.model_dump()}
    prepared = agent.provider_request(request)
    messages, tools, choice = prepared
    wire = prepare_customer_request(s.provider, s.policy.policy(), messages, tools, s.policy.model,
                                    max_output_tokens=agent.max_output_tokens, tool_choice=choice)
    return agent, request, prepared, wire


def build_customer_agent(dispatch: VerifiedDispatch):
    agent, request, prepared, wire = prepare_customer_agent(dispatch.scope, dispatch.request)
    if not hmac.compare_digest(wire.sha256, dispatch.scope.expectedRequestSha256):
        raise DispatchRejected()
    return agent, request, prepared


def execute_dispatch(dispatch: VerifiedDispatch, store: ReceiptStore, *,
                     now=None, _test_transport: httpx.MockTransport | None = None) -> dict:
    """Caller must authorize the persisted owner/payer/lease/revision FIRST.
    A reserve/save timeout always leaves an unresolved fence, never a retry.
    """
    reserved = False
    try:
        if (int(time.time()) if now is None else now()) >= dispatch.expires_at:
            raise DispatchRejected()
        agent, request, prepared = build_customer_agent(dispatch)
        scope = dispatch.scope
        existing = store.reserve(scope.jobId, dispatch.fingerprint)
        if existing is not None:
            if (type(existing) is not dict or existing.get("customerDispatchSha256") != dispatch.fingerprint or existing.get("jobId") != scope.jobId
                or existing.get("workspaceId") != scope.workspaceId or existing.get("bookId") != scope.bookId
                or existing.get("provider") != scope.provider or existing.get("agentType") != scope.agentType
                or existing.get("model") not in scope.policy.responseModels or type(existing.get("usage")) is not dict
                or existing.get("status") != "succeeded" or existing["usage"].get("estimatedCostUsd", 0) is not None
                or _contains_credential(existing, dispatch.credential)):
                raise ReceiptConflict("Customer receipt identity is unconfirmed; do not regenerate.")
            json_bytes(existing)
            return existing
        reserved = True
        # Storage latency must not extend a short-lived authorization.
        if (int(time.time()) if now is None else now()) >= dispatch.expires_at:
            raise ProviderOutcomeUnknown("Customer dispatch expired after reservation; requires review.")
        agent.provider = CustomerProvider(scope.provider, api_key=dispatch.credential, policy=scope.policy.policy(),
            expected_request_sha256=scope.expectedRequestSha256, _test_transport=_test_transport)
        result = agent.run(request, job_id=scope.jobId, prepared_request=prepared).to_dict()
        if result.get("status") != "succeeded" or _contains_credential(result, dispatch.credential):
            raise ProviderOutcomeUnknown("Customer result requires reconciliation; do not retry.")
        result.update(workspaceId=scope.workspaceId, bookId=scope.bookId, agentType=scope.agentType,
                      customerDispatchSha256=dispatch.fingerprint)
        # Bounds and serialization are checked before saving or returning.
        json_bytes(result)
        store.save(scope.jobId, dispatch.fingerprint, result)
        return result
    except (ReceiptConflict, ReceiptUnavailable, ProviderOutcomeUnknown, DispatchRejected):
        raise
    except Exception:
        if reserved:
            raise ProviderOutcomeUnknown("Customer outcome requires reconciliation; do not retry.") from None
        raise DispatchRejected() from None
    finally:
        dispatch.clear()
