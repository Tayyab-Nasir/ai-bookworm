"""PDF extraction quality is checked page-by-page without claiming OCR."""
import base64
import importlib.util
import io
import sys
from pathlib import Path

from fastapi.testclient import TestClient
from pypdf import PdfWriter
from reportlab.pdfgen import canvas

SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE))
from parsers import pdf_parser


def mixed_pdf():
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=(612, 792))
    pdf.drawString(50, 700, "This first page has enough extracted manuscript text for the threshold.")
    pdf.showPage()
    pdf.showPage()  # May be a deliberately blank page or an image-only scan.
    pdf.drawString(50, 700, "This third page also has enough extracted manuscript text for the threshold.")
    pdf.showPage()
    pdf.save()
    return output.getvalue()


def test_sparse_page_is_reported_even_when_document_average_is_high():
    book, report = pdf_parser.parse_pdf(mixed_pdf(), title="Synthetic")
    assert report["confidence"] == "low"
    assert any("sparse or blank extracted text: 2." in warning and "OCR was not performed" in warning for warning in report["warnings"])
    assert sum(node["type"] == "pageBreak" for node in book["chapters"][0]["nodes"]) == 2


def test_many_sparse_pages_are_summarized_without_a_large_report():
    writer = PdfWriter()
    for _ in range(25):
        writer.add_blank_page(width=72, height=72)
    raw = io.BytesIO()
    writer.write(raw)
    _, report = pdf_parser.parse_pdf(raw.getvalue())
    sparse = next(warning for warning in report["warnings"] if "sparse or blank" in warning)
    assert "1, 2, 3" in sparse and "20, and 5 more" in sparse
    assert len(sparse) < 300


def test_valid_supplementary_unicode_is_not_misclassified_as_garbled(monkeypatch):
    class Page:
        def extract_text(self):
            return "A valid story 😀 " * 10
    class Reader:
        def __init__(self, _data):
            self.pages = [Page()]
    monkeypatch.setattr(pdf_parser, "PdfReader", Reader)
    _, report = pdf_parser.parse_pdf(b"synthetic")
    assert report["confidence"] == "medium"
    assert not any("garbled" in warning for warning in report["warnings"])


def test_replacement_characters_still_trigger_garbled_warning(monkeypatch):
    class Page:
        def extract_text(self):
            return "Readable text " * 5 + "\ufffd\ufffd"
    class Reader:
        def __init__(self, _data):
            self.pages = [Page()]
    monkeypatch.setattr(pdf_parser, "PdfReader", Reader)
    _, report = pdf_parser.parse_pdf(b"synthetic")
    assert report["confidence"] == "low"
    assert any("garbled" in warning for warning in report["warnings"])


def test_authenticated_pdf_import_returns_page_quality_warning(monkeypatch):
    spec = importlib.util.spec_from_file_location("pdf_quality_http", SERVICE / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("DOCUMENT_SERVICE_TOKEN", "fixture-pdf-quality-token")
    with TestClient(module.app) as client:
        response = client.post("/parse", headers={"x-service-token": "fixture-pdf-quality-token"}, json={
            "assetId": "synthetic", "format": "pdf", "contentBase64": base64.b64encode(mixed_pdf()).decode()})
    assert response.status_code == 200, response.text
    assert response.json()["report"]["confidence"] == "low"
    assert any("sparse or blank extracted text: 2." in warning for warning in response.json()["report"]["warnings"])
