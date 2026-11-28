import base64
import hashlib
import importlib.util
from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image


def test_cover_inspection_decodes_pixels_and_binds_receipt_to_source(monkeypatch):
    spec = importlib.util.spec_from_file_location("cover_inspection_fixture", Path(__file__).resolve().parents[1] / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "fixture-only")
    headers = {"x-service-token": "fixture-only"}

    def image_bytes(fmt="PNG", size=(1024, 1024)):
        output = BytesIO()
        Image.new("RGB", size, "navy").save(output, format=fmt)
        return output.getvalue()

    def body(data, mime="image/png"):
        return {"imageBase64": base64.b64encode(data).decode(), "mimeType": mime}

    with TestClient(module.app) as client:
        png = image_bytes()
        assert client.post("/images/inspect-cover", json=body(png)).status_code == 401
        for fmt, mime in [("PNG", "image/png"), ("JPEG", "image/jpeg")]:
            data = image_bytes(fmt)
            response = client.post("/images/inspect-cover", headers=headers, json=body(data, mime))
            assert response.status_code == 200
            assert response.json() == {"mimeType": mime, "width": 1024, "height": 1024, "sha256": hashlib.sha256(data).hexdigest()}
            assert response.headers["cache-control"] == "no-store"
        for data, mime in [(png[:24], "image/png"), (png[:-30], "image/png"),
                           (png, "image/jpeg"), (image_bytes(size=(7201, 1024)), "image/png")]:
            response = client.post("/images/inspect-cover", headers=headers, json=body(data, mime))
            assert response.status_code == 422
        animated = BytesIO()
        Image.new("RGB", (1024, 1024), "red").save(animated, format="PNG", save_all=True,
            append_images=[Image.new("RGB", (1024, 1024), "blue")], duration=100)
        assert client.post("/images/inspect-cover", headers=headers, json=body(animated.getvalue())).status_code == 422
        assert client.post("/images/inspect-cover", headers=headers, json={"imageBase64": "bad!", "mimeType": "image/png"}).status_code == 422
        module._image_inspection_slot.acquire()
        try:
            assert client.post("/images/inspect-cover", headers=headers, json=body(png)).status_code == 503
        finally:
            module._image_inspection_slot.release()
        assert client.post("/images/inspect-cover", headers=headers, json=body(png)).status_code == 200
