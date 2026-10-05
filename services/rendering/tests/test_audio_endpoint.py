import base64
import hashlib
import importlib.util
import json
from pathlib import Path

from fastapi.testclient import TestClient


def test_audio_endpoint_requires_service_auth_and_returns_private_verified_bytes(monkeypatch):
    spec = importlib.util.spec_from_file_location("audio_endpoint_fixture", Path(__file__).resolve().parents[1] / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "fixture-only")
    output = b"ID3endpoint-fixture"
    quality = {"schemaVersion": 1, "reviewRequired": True, "acxNarrationPolicy": "explicit_authorization_required_for_ai_voice"}
    def assemble(parts):
        assert parts == [b"ID3input"]
        return output, hashlib.sha256(output).hexdigest(), quality
    monkeypatch.setattr(module, "assemble_audio_with_quality", assemble)
    body = {"segmentsBase64": [base64.b64encode(b"ID3input").decode()]}
    with TestClient(module.app) as client:
        assert client.post("/audio/assemble", json=body).status_code == 401
        headers = {"x-service-token": "fixture-only"}
        response = client.post("/audio/assemble", headers=headers, json=body)
        assert response.status_code == 200 and response.content == output
        assert response.headers["content-type"] == "audio/mpeg"
        assert response.headers["x-artifact-sha256"] == hashlib.sha256(output).hexdigest()
        assert response.headers["x-bookworm-audio-qc"] == '{"schemaVersion":1,"reviewRequired":true,"acxNarrationPolicy":"explicit_authorization_required_for_ai_voice"}'
        assert response.headers["cache-control"] == "no-store"
        assert client.post("/audio/assemble", headers=headers, json={"segmentsBase64": ["bad!"]}).status_code == 422
        def unavailable(_parts):
            raise RuntimeError("private runtime detail")
        monkeypatch.setattr(module, "assemble_audio_with_quality", unavailable)
        response = client.post("/audio/assemble", headers=headers, json=body)
        assert response.status_code == 503 and "private runtime detail" not in response.text


def test_narration_encoder_endpoint_binds_private_pcm_and_hides_runtime_errors(monkeypatch):
    spec = importlib.util.spec_from_file_location("narration_encoding_fixture", Path(__file__).resolve().parents[1] / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "fixture-only")
    pcm = bytes(48000)
    sha = hashlib.sha256(pcm).hexdigest()
    output = b"ID3private-encoding-fixture"
    profile = {"encodingVersion": "narration-mp3-1.0.0", "pcmSha256": sha,
        "sampleRateHz": 44100, "channels": 1, "bitRateKbps": 192, "bitRateMode": "cbr", "durationSeconds": 1}
    calls = []
    def encode(data):
        calls.append(data)
        return output, hashlib.sha256(output).hexdigest(), profile
    monkeypatch.setattr(module, "encode_narration_pcm", encode)
    body = {"pcmBase64": base64.b64encode(pcm).decode(), "pcmSha256": sha,
        "sampleRateHz": 24000, "channels": 1, "bitDepth": 16}
    with TestClient(module.app) as client:
        assert client.post("/audio/encode-narration", json=body).status_code == 401
        headers = {"x-service-token": "fixture-only"}
        for changes in ({"pcmSha256": "0" * 64}, {"pcmBase64": "bad!"}, {"sampleRateHz": 48000}, {"extra": 1}):
            assert client.post("/audio/encode-narration", headers=headers, json=body | changes).status_code == 422
        assert calls == []
        response = client.post("/audio/encode-narration", headers=headers, json=body)
        assert response.status_code == 200 and response.content == output and calls == [pcm]
        assert response.headers["content-type"] == "audio/mpeg"
        assert response.headers["x-artifact-sha256"] == hashlib.sha256(output).hexdigest()
        assert response.headers["cache-control"] == "no-store"
        assert json.loads(response.headers["x-bookworm-narration-encoding"]) == profile
        def unavailable(_data):
            raise RuntimeError("private runtime detail")
        monkeypatch.setattr(module, "encode_narration_pcm", unavailable)
        response = client.post("/audio/encode-narration", headers=headers, json=body)
        assert response.status_code == 503 and "private runtime detail" not in response.text
