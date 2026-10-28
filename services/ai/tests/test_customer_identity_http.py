import base64
import hashlib
import hmac
import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from customer_private_app import create_customer_private_app
from test_customer_database import DB_KEY, ROOT

TOKEN = "synthetic-private-service-token"
URL = "/v1/internal/customer-text/identity"
NONCE = base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip("=")


@pytest.fixture
def client():
    def forbidden(_): raise AssertionError("Identity probe must not access database or provider")
    transport = httpx.MockTransport(forbidden)
    app = create_customer_private_app(database_url=ROOT, service_role_key=DB_KEY, service_token=TOKEN,
        signing_keys={"old": b"o" * 32, "new": b"n" * 32}, mode="test",
        _test_database_transport=transport, _test_provider_transport=transport)
    with TestClient(app) as value:
        yield value


@pytest.mark.parametrize("kid,key", [("old", b"o" * 32), ("new", b"n" * 32)])
def test_challenge_proves_selected_rotating_key_without_database_or_provider(client, kid, key):
    response = client.post(URL, json={"keyId": kid, "nonce": NONCE}, headers={"x-service-token": TOKEN})
    expected = hmac.new(key, f"bookworm-customer-service-identity-v1\n{kid}\n{NONCE}".encode(), hashlib.sha256).hexdigest()
    assert response.status_code == 200 and response.json() == {"keyId": kid, "nonce": NONCE, "proof": expected}
    assert response.headers["cache-control"] == "no-store"
    assert TOKEN not in response.text and DB_KEY not in response.text


def test_authentication_validation_and_static_errors(client):
    assert client.post(URL, json={"keyId": "old", "nonce": NONCE}).status_code == 401
    assert client.post(URL, json={"keyId": "old", "nonce": NONCE}, headers={"x-service-token": "wrong-synthetic-token"}).status_code == 401
    headers = {"x-service-token": TOKEN, "content-type": "application/json"}
    for value in [{"keyId": "missing", "nonce": NONCE}, {"keyId": "old", "nonce": "bad"},
                  {"keyId": "old", "nonce": NONCE, "secret": "do-not-echo"}]:
        response = client.post(URL, content=json.dumps(value), headers=headers)
        assert response.status_code == 422 and "do-not-echo" not in response.text
    assert client.post(URL, content=b'{"keyId":"old","keyId":"new","nonce":"x"}', headers=headers).status_code == 422
    assert client.post(URL + "?x=1", json={"keyId": "old", "nonce": NONCE}, headers=headers).status_code == 400
    assert client.post(URL, content=b"x" * 2049, headers=headers).status_code == 413
