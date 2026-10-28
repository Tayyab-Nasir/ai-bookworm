"""Explicit private app factory; not registered, launched, or configured by env.

Transport isolation, authentication at the network edge, safe server logging,
operator secrets and database ACLs remain deployment responsibilities.
"""
from __future__ import annotations

import re
import time
from collections.abc import Callable

import httpx
from fastapi import FastAPI

from customer_database import CustomerAiDatabase
from customer_service import customer_service_router


def create_customer_private_app(*, database_url: str, service_role_key: str,
                                service_token: str, signing_keys: dict[str, bytes],
                                mode: str = "production", allow_loopback_http: bool = False,
                                _test_database_transport: httpx.MockTransport | None = None,
                                _test_provider_transport: httpx.MockTransport | None = None,
                                _test_clock: Callable[[], int] | None = None) -> FastAPI:
    """Construct only from trusted operator input. No startup I/O or provider use."""
    try:
        if (mode not in ("production", "development", "test") or type(allow_loopback_http) is not bool
                or (allow_loopback_http and mode not in ("development", "test"))
                or type(service_token) is not str or not service_token.isascii()
                or not service_token.isprintable() or any(c.isspace() for c in service_token)
                or not 16 <= len(service_token) <= 4096
                or type(signing_keys) is not dict or not 1 <= len(signing_keys) <= 8):
            raise ValueError()
        for key_id, key in signing_keys.items():
            if (type(key_id) is not str or re.fullmatch(r"[A-Za-z0-9_-]{1,64}", key_id) is None
                    or type(key) is not bytes or len(key) != 32):
                raise ValueError()
        if (_test_database_transport is not None or _test_provider_transport is not None or _test_clock is not None):
            if (mode != "test"
                    or (_test_database_transport is not None and not isinstance(_test_database_transport, httpx.MockTransport))
                    or (_test_provider_transport is not None and not isinstance(_test_provider_transport, httpx.MockTransport))
                    or (_test_clock is not None and not callable(_test_clock))):
                raise ValueError()
        database = CustomerAiDatabase(database_url, service_role_key, allow_loopback_http=allow_loopback_http,
                                      _test_transport=_test_database_transport)
        app = FastAPI(title="bookworm-private-customer-ai", docs_url=None, redoc_url=None, openapi_url=None)
        app.include_router(customer_service_router(service_token=service_token, signing_keys=dict(signing_keys),
            database=database, _clock=_test_clock or (lambda: int(time.time())), _test_provider_transport=_test_provider_transport))
        return app
    except Exception:
        # Configuration may contain credentials; never return or log input/errors.
        raise ValueError("Private customer AI service configuration is invalid.") from None
