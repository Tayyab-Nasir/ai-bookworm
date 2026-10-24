"""Unregistered, non-billable request preparation. Never resolves a credential.

The API caller must authenticate the author and supply canonical saved source.
This private route cannot create jobs, authorize spending or contact providers.
"""
import asyncio
import hashlib
import hmac

from fastapi import APIRouter, HTTPException, Request
from pydantic import Field
from starlette.concurrency import run_in_threadpool

from customer_dispatch import AgentRequest, PreparationScope, StrictModel, prepare_customer_agent
from customer_protocol import strict_json


class Preparation(StrictModel):
    scope: PreparationScope
    requestJson: str = Field(min_length=2, max_length=400000)


def prepare_customer_input(raw: bytes) -> dict:
    value = Preparation.model_validate(strict_json(raw))
    if len(value.requestJson.encode("utf-8")) > 400000:
        raise ValueError()
    request = AgentRequest.model_validate(strict_json(value.requestJson))
    agent, _, _, wire = prepare_customer_agent(value.scope, request)
    return {"provider": value.scope.provider, "agentType": value.scope.agentType,
            "model": value.scope.policy.model, "maxOutputTokens": agent.max_output_tokens,
            "sourceSha256": hashlib.sha256(value.requestJson.encode("utf-8")).hexdigest(),
            "requestSha256": wire.sha256, "contextOmitted": getattr(agent, "context_omitted", 0)}


def customer_preparation_router(*, service_token: str | None) -> APIRouter:
    router = APIRouter()

    @router.post("/v1/internal/customer-text/prepare", include_in_schema=False)
    async def prepare(request: Request):
        if (not service_token or not service_token.isascii() or not service_token.isprintable()
                or " " in service_token or not 16 <= len(service_token) <= 4096):
            raise HTTPException(503, "Customer preparation is not activated.")
        token = request.headers.get("x-service-token", "")
        if not token.isascii() or not hmac.compare_digest(token, service_token):
            raise HTTPException(401, "Invalid service authentication.")
        if (request.url.query or request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json"
                or request.headers.get("content-encoding", "identity") != "identity"):
            raise HTTPException(400, "Invalid source preparation envelope.")
        length = request.headers.get("content-length")
        if length is not None and (not length.isascii() or not length.isdecimal() or len(length) > 10 or int(length) > 1_048_576):
            raise HTTPException(413, "Source preparation exceeds its limit.")
        data = bytearray()
        try:
            async with asyncio.timeout(15):
                async for chunk in request.stream():
                    if len(data) + len(chunk) > 1_048_576:
                        raise HTTPException(413, "Source preparation exceeds its limit.")
                    data.extend(chunk)
            return await run_in_threadpool(prepare_customer_input, bytes(data))
        except HTTPException:
            raise
        except Exception:
            # No framework validation values or manuscript text in error bodies.
            raise HTTPException(422, "Saved AI context could not be prepared. No generation was started.") from None
        finally:
            data[:] = b"\0" * len(data)

    return router
