"""HTTP trust boundary: parser cannot expose arbitrary files on its host."""
import base64
import importlib.util
from pathlib import Path
import sys

import pytest
from fastapi.testclient import TestClient

SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE))
spec = importlib.util.spec_from_file_location("bookworm_document_security", SERVICE / "main.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
AUTH = {"x-service-token": "fixture-document-token"}
BODY = {"assetId": "test-source", "format": "txt", "contentBase64": base64.b64encode(b"Chapter 1\n\nA private manuscript.").decode()}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("DOCUMENT_SERVICE_TOKEN", AUTH["x-service-token"])
    monkeypatch.delenv("SERVICE_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("DOCUMENT_IMPORT_ROOT", raising=False)
    with TestClient(module.app) as instance:
        yield instance


def test_parser_requires_configured_token_and_never_exposes_it(client, monkeypatch):
    assert client.get("/health").status_code == 200
    for headers in [{}, {"x-service-token": "wrong"}]:
        response = client.post("/parse", json=BODY, headers=headers)
        assert response.status_code == 401
        assert AUTH["x-service-token"] not in response.text
    monkeypatch.delenv("DOCUMENT_SERVICE_TOKEN")
    assert client.post("/parse", json=BODY, headers=AUTH).status_code == 503


def test_authenticated_bytes_import_and_bad_base64(client):
    response = client.post("/parse", json=BODY, headers=AUTH)
    assert response.status_code == 200
    assert response.json()["bookModel"]["chapters"][0]["nodes"][-1]["text"] == "A private manuscript."
    assert client.post("/parse", json={**BODY, "contentBase64": "not-base64"}, headers=AUTH).status_code == 422


@pytest.mark.parametrize("path", ["../secret.txt", "..\\secret.txt", "/etc/passwd", "C:\\secret.txt", "C:secret.txt", "\\\\host\\share\\secret", "a/../../secret.txt", "a\x00b"])
def test_absolute_and_traversal_paths_are_rejected(client, path):
    assert client.post("/parse", json={"assetId": "x", "format": "txt", "storagePath": path}, headers=AUTH).status_code == 422


def test_filesystem_import_is_opt_in_and_confined(client, monkeypatch, tmp_path):
    request = {"assetId": "x", "format": "txt", "storagePath": "source.txt"}
    assert client.post("/parse", json=request, headers=AUTH).status_code == 422
    root = tmp_path / "imports"
    root.mkdir()
    (root / "source.txt").write_text("Only the configured import folder.", encoding="utf8")
    monkeypatch.setenv("DOCUMENT_IMPORT_ROOT", str(root))
    result = client.post("/parse", json=request, headers=AUTH)
    assert result.status_code == 200
    assert result.json()["bookModel"]["chapters"][0]["nodes"][0]["text"] == "Only the configured import folder."
    outside = tmp_path / "private.txt"
    outside.write_text("MUST NOT RETURN", encoding="utf8")
    try:
        (root / "link.txt").symlink_to(outside)
    except OSError:
        # Windows may forbid symlink creation. Exercise the resolved-path check
        # without requiring host privileges or weakening the guard.
        original = module.Path.resolve
        monkeypatch.setattr(module.Path, "resolve", lambda p: outside if p.name == "link.txt" else original(p))
    response = client.post("/parse", json={**request, "storagePath": "link.txt"}, headers=AUTH)
    assert response.status_code == 422
    assert "MUST NOT RETURN" not in response.text
