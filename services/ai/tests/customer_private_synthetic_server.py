"""Test-only synthetic loopback server; never loads real credentials or providers."""
import asyncio
import json
import os
import socket
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
import uvicorn
from customer_private_app import create_customer_private_app
from test_customer_database import DB_KEY, ROOT, DatabaseFixture
from test_customer_dispatch import NOW, SIGNING_KEY, transport


def forbidden(*_args, **_kwargs):
    raise AssertionError("Real network forbidden")


httpx.HTTPTransport.handle_request = forbidden
TOKEN = "synthetic-private-service-token"


async def main():
    if len(sys.argv) != 1:
        raise ValueError("Synthetic server accepts no arguments")
    if any(key in os.environ for key in ("OPENAI_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY")):
        raise ValueError("Synthetic server rejects inherited provider credentials")
    db, calls, gate = DatabaseFixture(), [], threading.Event()
    gate.set()
    delegate = transport("openai", calls)
    def provider(request):
        print(json.dumps({"event": "provider-started"}), flush=True)
        if not gate.wait(8):
            raise RuntimeError("Synthetic provider gate timeout")
        return delegate.handle_request(request)
    app = create_customer_private_app(database_url=ROOT, service_role_key=DB_KEY, service_token=TOKEN,
        signing_keys={"synthetic": SIGNING_KEY}, mode="test", _test_database_transport=httpx.MockTransport(db.send),
        _test_provider_transport=httpx.MockTransport(provider), _test_clock=lambda: NOW)
    owned = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    owned.bind(("127.0.0.1", 0)); owned.listen(128)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, access_log=False,
                                          log_config=None, lifespan="off", timeout_graceful_shutdown=10))
    serving = asyncio.create_task(server.serve(sockets=[owned]))
    for _ in range(500):
        if server.started or serving.done(): break
        await asyncio.sleep(0.01)
    if not server.started: raise RuntimeError("Synthetic service did not start")
    print(json.dumps({"event": "started", "host": "127.0.0.1", "port": owned.getsockname()[1]}), flush=True)

    async def control():
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                server.should_exit = True
                return
            command = line.strip()
            if command == "block":
                gate.clear()
                print(json.dumps({"event": "blocked"}), flush=True)
            elif command == "release": gate.set()
            elif command == "stop": server.should_exit = True
            else: raise ValueError("Invalid synthetic control")
    controller = asyncio.create_task(control())
    await serving
    # Parent closes stdin after stop, allowing the blocking reader to terminate.
    await controller
    print(json.dumps({"event": "stopped", "providerCalls": len(calls), "receiptCount": len(db.rows)}), flush=True)
    owned.close()


try:
    asyncio.run(main())
except Exception:
    print(json.dumps({"event": "synthetic-server-failed"}), flush=True)
    raise SystemExit(1) from None
