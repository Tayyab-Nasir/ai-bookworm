"""Unregistered internal router factory. No environment flag can activate it.

Requires a future database authorizer as an explicit dependency, in addition to
service auth and a dedicated MAC. Main/default managed-AI endpoints are unchanged.
Do not expose through a public proxy, request-body logging or error-body tracing.
"""
from __future__ import annotations

import hmac
import time
import asyncio
from collections.abc import Callable

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from customer_dispatch import (MAX_BYTES, CustomerTextResultStore, DispatchRejected, ReceiptConflict,
    ReceiptUnavailable, execute_dispatch, verify_dispatch)
from gateway import ProviderOutcomeUnknown


def customer_dispatch_router(*, service_token: str | None, signing_keys: dict[str, bytes],
                             authorize_scope: Callable | None = None, store_factory=CustomerTextResultStore,
                             _clock=lambda: int(time.time()), _test_transport=None) -> APIRouter:
    router = APIRouter()
    # Immutable key map copy: rotation requires rebuilding the configured router.
    keys = dict(signing_keys)

    @router.post("/v1/internal/customer-text/dispatch", status_code=201, include_in_schema=False)
    async def dispatch(request: Request):
        if (not service_token or not service_token.isascii() or not 16 <= len(service_token) <= 4096
            or not keys or authorize_scope is None):
            raise HTTPException(503, "Customer dispatch is not activated.")
        token = request.headers.get("x-service-token", "")
        if not token.isascii() or not hmac.compare_digest(token, service_token):
            raise HTTPException(401, "Invalid service authentication.")
        # No Pydantic request-body error (which can echo submitted secrets).
        if (request.url.query or request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json"
            or request.headers.get("content-encoding", "identity") != "identity"):
            raise HTTPException(400, "Invalid customer dispatch envelope.")
        length = request.headers.get("content-length")
        if length is not None and (not length.isascii() or not length.isdecimal() or len(length) > 10 or int(length) > MAX_BYTES):
            raise HTTPException(413, "Customer dispatch envelope exceeds its limit.")
        data = bytearray()
        verified = None
        try:
            async with asyncio.timeout(15):
                async for chunk in request.stream():
                    if len(data) + len(chunk) > MAX_BYTES:
                        raise HTTPException(413, "Customer dispatch envelope exceeds its limit.")
                    data.extend(chunk)
            verified = verify_dispatch(bytes(data), keys, now=_clock())
            # Must recheck persisted membership, payer consent, job state, lease,
            # owner and exact credential revision; signature alone is insufficient.
            if await run_in_threadpool(authorize_scope, verified.scope.model_dump()) is not True:
                raise HTTPException(403, "Customer job authorization is unavailable.")
            store = await run_in_threadpool(store_factory)
            return await run_in_threadpool(execute_dispatch, verified, store, now=_clock, _test_transport=_test_transport)
        except HTTPException:
            raise
        except DispatchRejected:
            raise HTTPException(422, "Customer dispatch is invalid or expired. No generation was started.") from None
        except ReceiptConflict:
            raise HTTPException(409, "Customer dispatch already has an unresolved or different receipt. Do not retry.") from None
        except (ReceiptUnavailable, ProviderOutcomeUnknown):
            raise HTTPException(503, "Customer dispatch outcome is unconfirmed. Recover before any new generation.") from None
        except Exception:
            raise HTTPException(503, "Customer dispatch is unavailable. Do not retry automatically.") from None
        finally:
            data[:] = b"\0" * len(data)
            if verified is not None:
                verified.clear()

    return router
