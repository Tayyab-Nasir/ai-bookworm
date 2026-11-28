"""Actual saved-PDF rasterization, bounds, private HTTP and inert-engine checks."""
import base64
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import importlib.util
import sys
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import pdf_preview


def pdf_bytes():
    buffer = BytesIO()
    document = canvas.Canvas(buffer, pagesize=(432, 648), invariant=1)
    for line in ("Harbor proof first page", "Silver compass second page"):
        document.setFont("Helvetica", 16)
        document.drawString(45, 540, line)
        document.showPage()
    document.save()
    return buffer.getvalue()


@pytest.mark.parametrize("width", [720, 1080, 1440])
def test_exact_pdf_page_becomes_verified_inert_pixels_and_bounded_text(width):
    content = pdf_bytes()
    result = pdf_preview.preview_pdf_page(content, 2, width)
    assert result == pdf_preview.preview_pdf_page(content, 2, width)
    assert result["formatVersion"] == "pdf-proof-1.0.0"
    assert result["sourceSha256"] == sha256(content).hexdigest()
    assert result["sourceSizeBytes"] == len(content)
    assert result["pageNumber"] == 2 and result["pageCount"] == 2
    assert result["pageWidthPoints"] == 432 and result["pageHeightPoints"] == 648
    assert "Silver compass second page" in result["text"]
    assert "first page" not in result["text"] and result["textTruncated"] is False
    raster = result["image"]
    png = base64.b64decode(raster["base64"], validate=True)
    assert len(png) == raster["sizeBytes"] <= pdf_preview.MAX_PNG_BYTES
    assert sha256(png).hexdigest() == raster["sha256"]
    with Image.open(BytesIO(png)) as image:
        assert image.format == "PNG" and image.mode == "RGB"
        assert image.size == (width, width * 3 // 2)
        # Validate actual visible pixels, not only a PNG header or an image URL.
        assert image.convert("L").getextrema()[0] < 100
        assert raster["width"] * raster["height"] <= pdf_preview.MAX_PIXELS


@pytest.mark.parametrize("page,width", [(0, 1080), (3, 1080), (True, 1080), (1, 721), (1, True), (1, 99999)])
def test_invalid_page_or_resolution_never_substitutes_another_page(page, width):
    with pytest.raises(ValueError):
        pdf_preview.preview_pdf_page(pdf_bytes(), page, width)


@pytest.mark.parametrize("content", [b"", b"not PDF", b"%PDF-1.7\ngarbage", b" <html>active</html>"])
def test_missing_corrupt_and_non_pdf_bytes_are_rejected(content):
    with pytest.raises(ValueError):
        pdf_preview.preview_pdf_page(content, 1)


def test_byte_and_png_limits_fail_closed_and_release_native_slot(monkeypatch):
    content = pdf_bytes()
    with monkeypatch.context() as patch:
        patch.setattr(pdf_preview, "MAX_PDF_BYTES", len(content) - 1)
        with pytest.raises(ValueError):
            pdf_preview.preview_pdf_page(content, 1)
    with monkeypatch.context() as patch:
        patch.setattr(pdf_preview, "MAX_PNG_BYTES", 20)
        with pytest.raises(ValueError, match="byte limit"):
            pdf_preview.preview_pdf_page(content, 1)
    assert pdf_preview.preview_pdf_page(content, 1)["pageNumber"] == 1


def test_inert_engine_build_and_no_parallel_pdfium_calls(monkeypatch):
    assert not {"V8", "XFA"}.intersection(pdf_preview.pdfium.PDFIUM_INFO.flags)
    for flags in (["V8"], ["XFA"], None):
        with monkeypatch.context() as patch:
            patch.setattr(pdf_preview.pdfium, "PDFIUM_INFO", SimpleNamespace(flags=flags))
            with pytest.raises(RuntimeError, match="non-scriptable"):
                pdf_preview.preview_pdf_page(pdf_bytes(), 1)
    assert pdf_preview._slot.acquire(blocking=False)
    try:
        with pytest.raises(RuntimeError, match="busy"):
            pdf_preview.preview_pdf_page(pdf_bytes(), 1)
    finally:
        pdf_preview._slot.release()


def test_native_handles_close_on_geometry_failure(monkeypatch):
    closed = []

    class Page:
        def get_size(self): return (float("nan"), 648)
        def close(self): closed.append("page")

    class Document:
        def __init__(self, _content): pass
        def __len__(self): return 1
        def __getitem__(self, _index): return Page()
        def close(self): closed.append("document")

    monkeypatch.setattr(pdf_preview.pdfium, "PdfDocument", Document)
    with pytest.raises(ValueError, match="geometry"):
        pdf_preview.preview_pdf_page(pdf_bytes(), 1)
    assert closed == ["page", "document"]


@pytest.fixture
def private_service(monkeypatch):
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "synthetic-pdf-proof-service-token")
    spec = importlib.util.spec_from_file_location("pdf_proof_http_main", ROOT / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with TestClient(module.app) as client:
        yield client, module


def headers(content):
    return {"x-service-token": "synthetic-pdf-proof-service-token", "content-type": "application/pdf",
            "x-content-sha256": sha256(content).hexdigest()}


def test_authenticated_binary_transport_preserves_source_and_emits_no_cache(private_service):
    client, _module = private_service
    content = pdf_bytes()
    response = client.post("/pdf/preview?page=2&width=720", content=content, headers=headers(content))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["sourceSha256"] == sha256(content).hexdigest()
    assert response.json()["image"]["width"] == 720
    assert "Silver compass second page" in response.json()["text"]


def test_http_auth_integrity_type_and_request_size_fail_closed(private_service, monkeypatch):
    client, module = private_service
    content = pdf_bytes()
    cases = [({**headers(content), "x-service-token": "incorrect"}, 401),
             ({**headers(content), "x-content-sha256": "0" * 64}, 422),
             ({**headers(content), "content-type": "text/html"}, 415),
             ({**headers(content), "content-encoding": "gzip"}, 415),
             ({**headers(content), "content-length": str(module.MAX_PDF_BYTES + 1)}, 413),
             ({**headers(content), "content-length": "1" * 20}, 422)]
    for request_headers, status in cases:
        response = client.post("/pdf/preview?page=1", content=content, headers=request_headers)
        assert response.status_code == status, response.text
    monkeypatch.setattr(module, "MAX_PDF_BYTES", 20)
    assert client.post("/pdf/preview?page=1", content=content, headers=headers(content)).status_code == 413


def test_http_rejects_busy_requests_before_reading_their_pdf(private_service, monkeypatch):
    client, module = private_service
    calls = []
    monkeypatch.setattr(module, "preview_pdf_page", lambda *_args: calls.append(True))
    assert module._pdf_request_slot.acquire(blocking=False)
    try:
        response = client.post("/pdf/preview?page=1", content=pdf_bytes(), headers=headers(pdf_bytes()))
        assert response.status_code == 503 and calls == []
    finally:
        module._pdf_request_slot.release()
