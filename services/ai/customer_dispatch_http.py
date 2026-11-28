"""Unregistered internal router factory. No environment flag can activate it.

Requires a database authorizer and receipt store as explicit dependencies, plus
service auth and a dedicated MAC. Main/default managed-AI endpoints are unchanged.
Do not expose through a public proxy, request-body logging or error-body tracing.
"""
from __future__ import annotations

import hmac
import time
import asyncio
import threading
from collections.abc import Callable

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from customer_dispatch import (MAX_BYTES, DispatchRejected, ReceiptConflict,
    ReceiptUnavailable, execute_dispatch, verify_dispatch)
from gateway import ProviderOutcomeUnknown


class _DispatchOwnership:
    """Exactly one side owns credential cleanup across task cancellation.

    A worker claims before touching the dispatch. If the awaiting handler is
    cancelled before that claim, it clears the pending dispatch and a worker
    arriving later cannot execute it. After claim only the worker clears it.
    """
    def __init__(self, dispatch):
        self._lock = threading.Lock()
        self._pending = dispatch

    def abandon_pending(self):
        with self._lock:
            dispatch, self._pending = self._pending, None
        if dispatch is not None:
            dispatch.clear()

    def execute(self, store, **kwargs):
        with self._lock:
            dispatch, self._pending = self._pending, None
        if dispatch is None:
            raise DispatchRejected()
        try:
            return execute_dispatch(dispatch, store, **kwargs)
        finally:
            # execute_dispatch already clears on every path. Preserve cleanup
            # even if it failed before reaching its own finally block.
            if dispatch.credential is not None:
                dispatch.clear()


def customer_dispatch_router(*, service_token: str | None, signing_keys: dict[str, bytes],
                             authorize_scope: Callable | None = None, store_factory: Callable | None = None,
                             _clock=lambda: int(time.time()), _test_transport=None) -> APIRouter:
    router = APIRouter()
    # Immutable key map copy: rotation requires rebuilding the configured router.
    keys = dict(signing_keys)

    @router.post("/v1/internal/customer-text/dispatch", status_code=201, include_in_schema=False)
    async def dispatch(request: Request):
        if (not service_token or not service_token.isascii() or not service_token.isprintable()
            or " " in service_token or not 16 <= len(service_token) <= 4096
            or not keys or not callable(authorize_scope) or not callable(store_factory)):
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
        ownership = None
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
            ownership = _DispatchOwnership(verified)
            verified = None  # The ownership capsule now controls cleanup.
            return await run_in_threadpool(ownership.execute, store, now=_clock,
                reauthorize_scope=authorize_scope, _test_transport=_test_transport)
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
            if ownership is not None:
                ownership.abandon_pending()
            if verified is not None:
                verified.clear()

    return router
