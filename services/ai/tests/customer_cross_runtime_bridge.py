"""Synthetic subprocess bridge for the TypeScript private-runtime test only."""
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi.testclient import TestClient
from customer_private_app import create_customer_private_app
from test_customer_database import DB_KEY, ROOT, DatabaseFixture
from test_customer_dispatch import NOW, SIGNING_KEY, fixture, transport


def forbidden(*_args, **_kwargs):
    raise AssertionError("Real network forbidden")


httpx.HTTPTransport.handle_request = forbidden
command = json.load(sys.stdin)
if command["action"] == "fixture":
    print(json.dumps(fixture(), ensure_ascii=False))
elif command["action"] == "dispatch":
    db, calls = DatabaseFixture(), []
    app = create_customer_private_app(database_url=ROOT, service_role_key=DB_KEY,
        deployment_id="deploy", service_id="service",
        service_token="synthetic-private-service-token", signing_keys={"synthetic": SIGNING_KEY}, mode="test",
        _test_database_transport=httpx.MockTransport(db.send), _test_provider_transport=transport("openai", calls),
        _test_clock=lambda: NOW)
    wire = base64.b64decode(command["body"], validate=True)
    with TestClient(app, headers={"x-service-token": "synthetic-private-service-token", "content-type": "application/json"}) as client:
        first = client.post("/v1/internal/customer-text/dispatch", content=wire)
        replay = client.post("/v1/internal/customer-text/dispatch", content=wire)
        assert first.status_code == replay.status_code == 201
        assert first.json() == replay.json() and len(calls) == 1
        assert len(db.rows) == 1
        print(json.dumps({"status": first.status_code, "result": first.json(), "providerCalls": len(calls),
                          "receiptCount": len(db.rows)}))
else:
    raise ValueError("Invalid synthetic bridge action")
