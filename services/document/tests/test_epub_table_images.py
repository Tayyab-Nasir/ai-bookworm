"""Images in EPUB tables survive import with an explicit placement warning."""
import base64
import importlib.util
import io
import json
from pathlib import Path
import sys
import zipfile

import pytest
from fastapi.testclient import TestClient

SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE))
from parsers import ParseError
from parsers import epub_parser

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")


def archive(content):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as z:
        z.writestr("META-INF/container.xml", '<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>')
        z.writestr("OPS/content.opf", '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>')
        z.writestr("OPS/chapter.xhtml", f"<html><body>{content}</body></html>")
        z.writestr("OPS/picture.png", PNG)
    return output.getvalue()


def sample():
    return archive('<p>Before</p><table><tr><td>Cell <img src="picture.png" alt="Harbor"/> text</td>'
                   '<td><table><tr><td>Nested<img src="picture.png" alt="Again"/></td></tr></table></td>'
                   '<td><img src="https://example.invalid/external.png" alt="Unavailable artwork"/></td>'
                   '</tr></table><p>After</p>')


def test_epub_table_keeps_local_nested_and_missing_artwork_in_order():
    assets = []
    book, report = epub_parser.parse_epub(sample(), embedded_assets=assets)
    nodes = book["chapters"][0]["nodes"]
    assert [node["type"] for node in nodes] == ["paragraph", "table", "image", "image", "caption", "paragraph"]
    assert nodes[1]["rows"][0] == ["Cell\ntext", "Nested", ""]
    assert [nodes[2]["altText"], nodes[3]["altText"]] == ["Harbor", "Again"]
    assert nodes[2]["assetId"] == nodes[3]["assetId"] == assets[0]["id"]
    assert base64.b64decode(assets[0]["contentBase64"]) == PNG
    assert nodes[4]["text"] == "Unavailable artwork"
    assert "https://" not in json.dumps(book)
    assert any("table images were moved after the table" in warning for warning in report["warnings"])
    assert any("external, missing or unsupported" in warning for warning in report["warnings"])


def test_authenticated_epub_import_exposes_image_nodes_and_separate_asset(monkeypatch):
    spec = importlib.util.spec_from_file_location("epub_table_image_http", SERVICE / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("DOCUMENT_SERVICE_TOKEN", "fixture-table-token")
    with TestClient(module.app) as client:
        response = client.post("/parse", headers={"x-service-token": "fixture-table-token"}, json={
            "assetId": "fixture", "format": "epub", "contentBase64": base64.b64encode(sample()).decode()})
    assert response.status_code == 200, response.text
    payload = response.json()
    nodes = payload["bookModel"]["chapters"][0]["nodes"]
    assert nodes[2]["assetId"] == nodes[3]["assetId"] == payload["embeddedAssets"][0]["id"]
    assert "contentBase64" not in json.dumps(payload["bookModel"])
    assert any("table images were moved after the table" in warning for warning in payload["report"]["warnings"])


def test_imported_table_artwork_survives_epub_and_print_rendering():
    sys.path.insert(0, str(SERVICE.parent / "rendering"))
    from editions import EbookEdition, PrintEdition
    from epub_renderer import render_epub
    from pdf_renderer import render_pdf
    from pypdf import PdfReader

    assets = []
    book, _ = epub_parser.parse_epub(sample(), embedded_assets=assets)
    images = {item["id"]: base64.b64decode(item["contentBase64"]) for item in assets}
    epub, _ = render_epub(book, EbookEdition(), image_bytes=images)
    with zipfile.ZipFile(io.BytesIO(epub)) as result:
        markup = result.read("OEBPS/ch0000.xhtml").decode()
        assert markup.index("</table>") < markup.index("Harbor") < markup.index("Again") < markup.index("After")
        assert result.read(f"OEBPS/images/{assets[0]['id']}.png") == PNG
    pdf, _ = render_pdf(book, PrintEdition(), image_bytes=images)
    assert sum(len(page.images) for page in PdfReader(io.BytesIO(pdf)).pages) >= 2


def test_table_image_occurrence_limit_fails_before_collecting_bytes(monkeypatch):
    monkeypatch.setattr(epub_parser, "MAX_TABLE_IMAGE_OCCURRENCES", 1)
    assets = []
    with pytest.raises(ParseError, match="too many image occurrences"):
        epub_parser.parse_epub(archive('<table><tr><td><img src="picture.png"/><img src="picture.png"/></td></tr></table>'), embedded_assets=assets)
    assert assets == []
