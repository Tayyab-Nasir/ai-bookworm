"""Text-only PDF import reports that artwork is not preserved."""
import base64
import importlib.util
import io
import sys
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE))
from parsers.pdf_parser import parse_pdf


def pdf_with_text_and_artwork():
    image = io.BytesIO()
    Image.new("RGB", (8, 8), "purple").save(image, format="PNG")
    image.seek(0)
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=(612, 792))
    pdf.drawString(50, 700, "This manuscript page has ample text as well as an illustration.")
    pdf.drawImage(ImageReader(image), 50, 500, width=120, height=120)
    pdf.save()
    return output.getvalue()


def test_text_rich_pdf_explicitly_warns_that_artwork_is_not_imported():
    book, report = parse_pdf(pdf_with_text_and_artwork())
    assert any("ample text" in item.get("text", "") for item in book["chapters"][0]["nodes"])
    assert report["confidence"] == "medium"  # Text density does not prove artwork survived.
    assert any("images, graphics, annotations and original layout are not imported" in warning
               and "add missing artwork separately" in warning for warning in report["warnings"])
    assert report["imageCount"] == 0
    assert not any(item["type"] == "image" for item in book["chapters"][0]["nodes"])


def test_authenticated_import_includes_artwork_warning_and_no_false_asset(monkeypatch):
    spec = importlib.util.spec_from_file_location("pdf_artwork_warning_http", SERVICE / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("DOCUMENT_SERVICE_TOKEN", "synthetic-pdf-warning-token")
    with TestClient(module.app) as client:
        response = client.post("/parse", headers={"x-service-token": "synthetic-pdf-warning-token"}, json={
            "assetId": "synthetic", "format": "pdf", "contentBase64": base64.b64encode(pdf_with_text_and_artwork()).decode()})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["embeddedAssets"] == []
    assert any("images, graphics, annotations and original layout are not imported" in warning
               for warning in body["report"]["warnings"])
