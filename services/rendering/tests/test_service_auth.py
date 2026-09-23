"""Every expensive rendering endpoint must fail closed before processing."""
import importlib.util
from pathlib import Path
import sys

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("bookworm_render_auth", ROOT / "main.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ROUTES = ("/render", "/preflight", "/audio/assemble", "/images/inspect-cover")


@pytest.mark.parametrize("token", [None, "", "   "])
def test_rendering_missing_config_blocks_every_processing_route(monkeypatch, token):
    monkeypatch.delenv("RENDERING_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("SERVICE_AUTH_TOKEN", raising=False)
    if token is not None:
        monkeypatch.setenv("RENDERING_SERVICE_TOKEN", token)
    with TestClient(module.app) as client:
        for route in ROUTES:
            response = client.post(route, json={}, headers={"x-service-token": "guessed"})
            assert response.status_code == 503, response.text
            assert response.json() == {"detail": "Rendering service authentication is not configured."}
        assert client.get("/health").json() == {"status": "ok"}


def test_rendering_requires_token_before_payload_validation(monkeypatch):
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "render-auth-fixture")
    with TestClient(module.app) as client:
        for route in ROUTES:
            for headers in ({}, {"x-service-token": "wrong"}):
                denied = client.post(route, json={}, headers=headers)
                assert denied.status_code == 401
                assert "render-auth-fixture" not in denied.text
            # Passing auth reaches endpoint-specific schema validation.
            assert client.post(route, json={}, headers={"x-service-token": "render-auth-fixture"}).status_code == 422


def test_rendering_shared_fallback_and_dedicated_precedence(monkeypatch):
    monkeypatch.delenv("RENDERING_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("SERVICE_AUTH_TOKEN", "shared-fixture")
    module.require_service_token("shared-fixture")
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "dedicated-fixture")
    for token in (None, "", "shared-fixture", "wrong-é"):
        with pytest.raises(HTTPException) as caught:
            module.require_service_token(token)
        assert caught.value.status_code == 401
    module.require_service_token("dedicated-fixture")
