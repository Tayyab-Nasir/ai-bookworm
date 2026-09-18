import base64
import hashlib
import importlib.util
from pathlib import Path

from fastapi.testclient import TestClient


def test_audio_endpoint_requires_service_auth_and_returns_private_verified_bytes(monkeypatch):
    spec = importlib.util.spec_from_file_location("audio_endpoint_fixture", Path(__file__).resolve().parents[1] / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "fixture-only")
    output = b"ID3endpoint-fixture"
    def assemble(parts):
        assert parts == [b"ID3input"]
        return output, hashlib.sha256(output).hexdigest()
    monkeypatch.setattr(module, "assemble_audio", assemble)
    body = {"segmentsBase64": [base64.b64encode(b"ID3input").decode()]}
    with TestClient(module.app) as client:
        assert client.post("/audio/assemble", json=body).status_code == 401
        headers = {"x-service-token": "fixture-only"}
        response = client.post("/audio/assemble", headers=headers, json=body)
        assert response.status_code == 200 and response.content == output
        assert response.headers["content-type"] == "audio/mpeg"
        assert response.headers["x-artifact-sha256"] == hashlib.sha256(output).hexdigest()
        assert response.headers["cache-control"] == "no-store"
        assert client.post("/audio/assemble", headers=headers, json={"segmentsBase64": ["bad!"]}).status_code == 422
        def unavailable(_parts):
            raise RuntimeError("private runtime detail")
        monkeypatch.setattr(module, "assemble_audio", unavailable)
        response = client.post("/audio/assemble", headers=headers, json=body)
        assert response.status_code == 503 and "private runtime detail" not in response.text
