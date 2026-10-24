"""Explicit composition only; NOT registered by main.py or environment flags.

Network isolation, verified DB ACLs, fee policy, retention and public/queue
integration remain operator/release gates. Signing a request is not permission
to charge: every dispatch must also pass current database authorization.
"""
import time

from fastapi import APIRouter

from customer_database import CustomerAiDatabase
from customer_dispatch_http import customer_dispatch_router
from customer_prepare_http import customer_preparation_router
from result_store import ReceiptUnavailable


def customer_service_router(*, service_token: str | None, signing_keys: dict[str, bytes],
                            database: CustomerAiDatabase, _clock=lambda: int(time.time()),
                            _test_provider_transport=None) -> APIRouter:
    if not isinstance(database, CustomerAiDatabase):
        raise ReceiptUnavailable("Explicit customer database adapter is required.")
    router = APIRouter()
    router.include_router(customer_preparation_router(service_token=service_token))
    router.include_router(customer_dispatch_router(service_token=service_token, signing_keys=signing_keys,
        authorize_scope=database.authorize_scope, store_factory=lambda: database,
        _clock=_clock, _test_transport=_test_provider_transport))
    return router
