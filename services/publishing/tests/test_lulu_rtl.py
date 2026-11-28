"""A saved Arabic PDF, its paired upload cover and the Lulu printer copy."""
import base64
import hashlib
import importlib.util
from io import BytesIO
import json
from pathlib import Path
import sys
from uuid import UUID
import zipfile

from fastapi.testclient import TestClient
from pypdf import PdfReader
import pypdfium2 as pdfium
import pytest
from reportlab.pdfgen.canvas import Canvas

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services/rendering"))
sys.path.insert(0, str(ROOT / "services/publishing"))


def app(role):
    spec = importlib.util.spec_from_file_location("bookworm_lulu_rtl_" + role, ROOT / f"services/{role}/main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.app


def sample(reading_pages):
    book = json.loads((ROOT / "tests/fixtures/books/valid_book.json").read_text(encoding="utf-8"))
    book["metadata"].update(title="مرافئ النور", author="ليلى منصور", language="ar", isbn13=None)
    book["chapters"] = [{"id": str(UUID(int=index)), "order": index, "title": f"الفصل {index}", "nodes": [
        {"id": "p", "type": "paragraph", "text": f"عند المرفأ. Reading page {index + 1:03d}."},
    ]} for index in range(1, reading_pages)]
    book["assets"] = []
    target = reading_pages + (reading_pages % 2)
    spine = 0.25  # A synthetic template, independent of particular stock options.
    config = {"kind": "print", "text_direction": "rtl", "bleed_in": 0.125, "bleed_edges": "all",
              "margins": {"inner": 0.9, "outer": 0.5},
              "typography": {"body_font": "BookwormAmiri", "heading_font": "BookwormAmiri-Bold"},
              "cover": {"asset_id": str(UUID(int=888))},
              "wrap_cover": {"enabled": True, "profile": "custom", "spine_width_in": spine,
                             "source_pdf_version": 3, "lulu_rtl": True, "expected_page_count": target}}
    cover = BytesIO()
    width = (12.25 + spine) * 72
    canvas = Canvas(cover, pagesize=(width, 666), invariant=1)
    canvas.setFillColorRGB(0.07, 0.26, 0.36)
    canvas.rect(0, 0, width / 2, 666, fill=1, stroke=0)
    canvas.setFillColorRGB(0.61, 0.23, 0.18)
    canvas.rect(width / 2, 0, width / 2, 666, fill=1, stroke=0)
    canvas.save()
    return {"bookModel": book, "editionConfig": config, "coverBase64": base64.b64encode(cover.getvalue()).decode()}, cover.getvalue()


def raster_hash(document, index):
    page = document[index]
    bitmap = page.render(scale=0.45)
    try:
        return hashlib.sha256(bitmap.to_pil().tobytes()).hexdigest()
    finally:
        bitmap.close()
        page.close()


@pytest.mark.parametrize("reading_pages", [32, 33])
def test_lulu_rtl_package_reverses_saved_pages_without_moving_print_content(monkeypatch, reading_pages):
    token = "synthetic-lulu-rtl-acceptance"
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", token)
    monkeypatch.setenv("PUBLISHING_SERVICE_TOKEN", token)
    headers = {"x-service-token": token}
    request, original_cover = sample(reading_pages)
    with TestClient(app("rendering")) as renderer:
        response = renderer.post("/render", headers=headers, json=request)
        assert response.status_code == 200, response.text
        rendered = response.json()
        assert rendered["rendererVersion"] == "pdf-1.21.0-amiri"
        assert base64.b64decode(rendered["coverArtifactBase64"]) == original_cover
        numeric_confirmation = {**request["editionConfig"], "wrap_cover": {
            **request["editionConfig"]["wrap_cover"], "lulu_rtl": 1,
        }}
        assert renderer.post("/render", headers=headers, json={**request, "editionConfig": numeric_confirmation}).status_code == 422
        wrong_count = {**request["editionConfig"], "wrap_cover": {
            **request["editionConfig"]["wrap_cover"], "expected_page_count": 35,
        }}
        rejected = renderer.post("/preflight", headers=headers, json={**request, "editionConfig": wrong_count, "channel": "lulu"})
        assert rejected.status_code == 200 and rejected.json()["errors"] > 0
        assert any("must match the" in issue["message"] and "upload" in issue["message"] for issue in rejected.json()["findings"])
    pdf = base64.b64decode(rendered["artifactBase64"])
    package = {"bookModel": request["bookModel"], "editionConfig": request["editionConfig"], "channel": "lulu",
               "artifactsBase64": {"book.pdf": rendered["artifactBase64"], "cover.pdf": rendered["coverArtifactBase64"]}}
    with TestClient(app("publishing")) as publisher:
        checked = publisher.post("/v1/publishing/validate", headers=headers, json=package)
        assert checked.status_code == 200 and checked.json()["errors"] == 0, checked.text
        assert any(item["code"] == "LULU-RTL-UPLOAD" for item in checked.json()["findings"])
        alternate = publisher.post("/v1/publishing/validate", headers=headers, json={**package, "channel": "barnesnoble"})
        assert alternate.status_code == 200
        assert any(item["code"] == "PRINT_WRAP_PROFILE" for item in alternate.json()["findings"])
        first = publisher.post("/v1/publishing/package", headers=headers, json=package)
        assert first.status_code == 200, first.text
        assert publisher.post("/v1/publishing/package", headers=headers, json=package).json() == first.json()
    blob = base64.b64decode(first.json()["packages"][0]["dataBase64"])
    with zipfile.ZipFile(BytesIO(blob)) as archive:
        upload = archive.read("book.pdf")
        assert archive.read("cover.pdf") == original_cover
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["files"]["book.pdf"] == hashlib.sha256(upload).hexdigest()
        assert manifest["luluRightToLeft"] == {"sourcePdfSha256": hashlib.sha256(pdf).hexdigest(),
            "sourcePageCount": reading_pages, "uploadPageCount": reading_pages + (reading_pages % 2),
            "leadingBlankPage": bool(reading_pages % 2), "coverFrontPanel": "left"}
    original, target = PdfReader(BytesIO(pdf)), PdfReader(BytesIO(upload))
    assert len(original.pages) == reading_pages
    assert len(target.pages) % 2 == 0
    assert "Reading page" not in target.pages[-1].extract_text()
    assert target.metadata.title == original.metadata.title
    if reading_pages % 2:
        assert target.pages[0].get_contents() is None
        assert tuple(target.pages[0].mediabox) == tuple(original.pages[-1].mediabox)
    with pdfium.PdfDocument(pdf) as reading, pdfium.PdfDocument(upload) as printing:
        for index in range(reading_pages):
            assert raster_hash(reading, index) == raster_hash(printing, len(printing) - 1 - index)
