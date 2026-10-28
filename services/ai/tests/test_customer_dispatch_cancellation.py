"""Synthetic ASGI cancellation; no provider or database network calls."""
import asyncio
import copy
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import customer_dispatch_http as router_module
from customer_dispatch import DispatchRejected, VerifiedDispatch
from test_customer_dispatch import NOW, SIGNING_KEY, fixture, sign
from test_customer_provider import KEY, response_for
from test_customer_provider_agents import EDIT

TOKEN = "synthetic-customer-service-token"


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch):
    def reject(*_args, **_kwargs):
        raise AssertionError("Network transport is forbidden in this test")
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", reject)


def app_and_body(monkeypatch, store, authorize, transport):
    scope, request = fixture()
    body = sign(scope, request)
    captured, clear_count = [], []
    verify = router_module.verify_dispatch
    clear = VerifiedDispatch.clear
    def capture(*args, **kwargs):
        value = verify(*args, **kwargs)
        captured.append(value)
        return value
    def counted_clear(value):
        clear_count.append(value)
        return clear(value)
    monkeypatch.setattr(router_module, "verify_dispatch", capture)
    monkeypatch.setattr(VerifiedDispatch, "clear", counted_clear)
    app = FastAPI()
    app.include_router(router_module.customer_dispatch_router(
        service_token=TOKEN, signing_keys={"synthetic": SIGNING_KEY},
        authorize_scope=authorize, store_factory=lambda: store,
        _clock=lambda: NOW, _test_transport=transport))
    return app, body, captured, clear_count


async def request(client, body):
    return await client.post("/v1/internal/customer-text/dispatch", content=body,
        headers={"content-type": "application/json", "x-service-token": TOKEN})


async def cancelled(task):
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def wait_thread(event):
    assert await asyncio.to_thread(event.wait, 3), "synthetic worker did not reach barrier"


@pytest.mark.parametrize("phase", ["reserve", "reauthorize", "provider", "save"])
def test_real_asgi_task_cancellation_after_claim_keeps_worker_credential_until_receipt(monkeypatch, caplog, phase):
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    calls = {"reserve": 0, "authorize": 0, "provider": 0, "save": 0}
    saved, outcomes = [], []
    def barrier(at):
        if phase == at:
            entered.set()
            assert release.wait(3), "test did not release worker"
    class Store:
        def reserve(self, *_args):
            calls["reserve"] += 1
            barrier("reserve")
            return None
        def save(self, _job, _fingerprint, result):
            calls["save"] += 1
            barrier("save")
            saved.append(copy.deepcopy(result))
    def authorize(_scope):
        calls["authorize"] += 1
        if calls["authorize"] == 2:
            barrier("reauthorize")
        return True
    def send(_request):
        calls["provider"] += 1
        barrier("provider")
        return httpx.Response(200, json=response_for("openai", "propose_edit", copy.deepcopy(EDIT)))
    real_execute = router_module.execute_dispatch
    def observe(*args, **kwargs):
        try:
            result = real_execute(*args, **kwargs)
            outcomes.append(result["status"])
            return result
        except Exception as error:
            outcomes.append(type(error).__name__)
            raise
        finally:
            finished.set()
    monkeypatch.setattr(router_module, "execute_dispatch", observe)
    app, body, captured, clears = app_and_body(monkeypatch, Store(), authorize, httpx.MockTransport(send))
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            task = asyncio.create_task(request(client, body))
            try:
                await wait_thread(entered)
                await cancelled(task)
                assert captured[0].credential == KEY
            finally:
                release.set()
            await wait_thread(finished)
    asyncio.run(scenario())
    assert calls == {"reserve": 1, "authorize": 2, "provider": 1, "save": 1}
    assert outcomes == ["succeeded"] and len(saved) == 1
    assert captured[0].credential is None and clears == [captured[0]]
    assert KEY not in json.dumps(saved) and KEY not in caplog.text


@pytest.mark.parametrize("submission", ["cancelled-before-claim", "submission-failure"])
def test_unclaimed_dispatch_is_cleared_and_never_executed(monkeypatch, submission):
    real_threadpool = router_module.run_in_threadpool
    submitted, release = asyncio.Event(), asyncio.Event()
    pending = []
    calls = []
    class Store:
        def reserve(self, *_args): calls.append("reserve")
        def save(self, *_args): calls.append("save")
    def transport(_request):
        calls.append("provider")
        raise AssertionError("unclaimed dispatch reached provider")
    async def controlled(func, *args, **kwargs):
        if isinstance(getattr(func, "__self__", None), router_module._DispatchOwnership):
            pending.append((func, args, kwargs))
            submitted.set()
            if submission == "submission-failure":
                raise RuntimeError("synthetic scheduler failure")
            await release.wait()
        return await real_threadpool(func, *args, **kwargs)
    monkeypatch.setattr(router_module, "run_in_threadpool", controlled)
    app, body, captured, clears = app_and_body(monkeypatch, Store(), lambda _: True, httpx.MockTransport(transport))
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            task = asyncio.create_task(request(client, body))
            await asyncio.wait_for(submitted.wait(), 3)
            if submission == "cancelled-before-claim":
                await cancelled(task)
            else:
                response = await task
                assert response.status_code == 503
                assert KEY not in response.text
            assert captured[0].credential is None and clears == [captured[0]]
            # Even if a queued executor callback runs late, it cannot claim.
            func, args, kwargs = pending[0]
            with pytest.raises(DispatchRejected):
                await asyncio.to_thread(func, *args, **kwargs)
            release.set()
    asyncio.run(scenario())
    assert not calls and clears == [captured[0]]


def test_competing_worker_claim_and_handler_abandon_have_one_owner(monkeypatch):
    class Dispatch:
        credential = "synthetic"
        def __init__(self): self.clears = 0
        def clear(self): self.clears += 1; self.credential = None
    for _ in range(100):
        dispatch = Dispatch()
        capsule = router_module._DispatchOwnership(dispatch)
        gate = threading.Barrier(2)
        calls = []
        def execute(value, *_args, **_kwargs):
            assert value.credential == "synthetic"
            calls.append("execute")
            value.clear()
        monkeypatch.setattr(router_module, "execute_dispatch", execute)
        def worker():
            gate.wait()
            try: capsule.execute(object())
            except DispatchRejected: pass
        def abandon():
            gate.wait()
            capsule.abandon_pending()
        with ThreadPoolExecutor(max_workers=2) as pool:
            a, b = pool.submit(worker), pool.submit(abandon)
            a.result(timeout=3); b.result(timeout=3)
        assert len(calls) <= 1 and dispatch.clears == 1 and dispatch.credential is None


def test_cancel_during_initial_authorization_clears_unclaimed_credential(monkeypatch):
    entered, release, done = threading.Event(), threading.Event(), threading.Event()
    calls = []
    def authorize(_scope):
        entered.set()
        try:
            assert release.wait(3)
            return True
        finally:
            done.set()
    class Store:
        def reserve(self, *_args): calls.append("reserve")
    app, body, captured, clears = app_and_body(monkeypatch, Store(), authorize, httpx.MockTransport(lambda _: None))
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            task = asyncio.create_task(request(client, body))
            try:
                await wait_thread(entered)
                await cancelled(task)
                assert captured[0].credential is None and clears == [captured[0]]
            finally:
                release.set()
            await wait_thread(done)
    asyncio.run(scenario())
    assert not calls and clears == [captured[0]]


@pytest.mark.parametrize("case", ["authorization-denied", "store-unavailable", "provider-unknown"])
def test_failure_paths_clear_once_without_exposing_key_or_retry(monkeypatch, caplog, case):
    calls = []
    class Store:
        def reserve(self, *_args): calls.append("reserve"); return None
        def save(self, *_args): calls.append("save")
    def send(_request):
        calls.append("provider")
        return httpx.Response(503, text=KEY)
    store = Store()
    app, body, captured, clears = app_and_body(monkeypatch, store,
        lambda _: case != "authorization-denied", httpx.MockTransport(send))
    if case == "store-unavailable":
        real = router_module.run_in_threadpool
        async def fail_store(func, *args, **kwargs):
            if getattr(func, "__name__", "") == "<lambda>" and not args:
                raise RuntimeError(KEY)
            return await real(func, *args, **kwargs)
        monkeypatch.setattr(router_module, "run_in_threadpool", fail_store)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await request(client, body)
            assert response.status_code == (403 if case == "authorization-denied" else 503)
            assert KEY not in response.text
    asyncio.run(scenario())
    assert clears == [captured[0]] and captured[0].credential is None
    assert calls == (["reserve", "provider"] if case == "provider-unknown" else [])
    assert KEY not in caplog.text
