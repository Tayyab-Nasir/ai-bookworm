"""Renderer + preflight tests: determinism, EPUB structure, broken fixture findings."""
import base64
import io
import json
import copy
import sys
import zipfile
from xml.etree import ElementTree as ET
from pathlib import Path

import pytest
from PIL import Image

RENDERING = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RENDERING))

from editions import EbookEdition, PrintEdition, parse_edition  # noqa: E402
from cover_renderer import compose_front_cover  # noqa: E402
from epub_renderer import render_epub  # noqa: E402
from pdf_renderer import render_pdf  # noqa: E402
from preflight import run_preflight  # noqa: E402
from rules import load_ruleset  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "books"
VALID = json.loads((FIXTURES / "valid_book.json").read_text())
BROKEN = json.loads((FIXTURES / "broken_book.json").read_text())

EBOOK = {"kind": "ebook"}
PRINT = {"kind": "print", "trim_size": "6x9"}


@pytest.mark.parametrize("image_format", ["JPEG", "GIF", "WEBP"])
def test_importable_raster_formats_are_normalized_to_real_pngs_in_export(image_format, monkeypatch):
    import base64
    import importlib.util
    from fastapi.testclient import TestClient
    spec = importlib.util.spec_from_file_location("bookworm_render_imported_images", RENDERING / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "fixture-render-token")
    source = io.BytesIO()
    Image.new("RGB", (16, 12), "#275b91").save(source, image_format)
    asset_id = "77777777-7777-4777-8777-777777777777"
    book = copy.deepcopy(VALID)
    book["assets"] = [{"id": asset_id, "role": "illustration", "altText": "Blue panel"}]
    book["chapters"][0]["nodes"].append({"id": "imported-image", "type": "image", "assetId": asset_id, "altText": "Blue panel"})
    with TestClient(module.app) as client:
        response = client.post("/render", headers={"x-service-token": "fixture-render-token"}, json={
            "bookModel": book, "editionConfig": EBOOK,
            "assetImagesBase64": {asset_id: base64.b64encode(source.getvalue()).decode()}})
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(response.json()["artifactBase64"]))) as z:
        normalized = z.read(f"OEBPS/images/{asset_id}.png")
        assert normalized.startswith(b"\x89PNG\r\n\x1a\n")
        with Image.open(io.BytesIO(normalized)) as image:
            assert image.format == "PNG" and image.size == (16, 12)
        assert f'images/{asset_id}.png' in z.read("OEBPS/ch0000.xhtml").decode()


def test_render_service_returns_rtl_preflight_findings_before_attempting_print_output(monkeypatch):
    import importlib.util
    from fastapi.testclient import TestClient
    spec = importlib.util.spec_from_file_location("bookworm_render_rtl_preflight", RENDERING / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "fixture-render-token")
    book = copy.deepcopy(VALID)
    book["metadata"].update({"language": "ar", "title": "عنوان", "author": "كاتب"})
    with TestClient(module.app) as client:
        preflight = client.post("/preflight", headers={"x-service-token": "fixture-render-token"}, json={
            "bookModel": book, "editionConfig": PRINT,
        })
        render = client.post("/render", headers={"x-service-token": "fixture-render-token"}, json={
            "bookModel": book, "editionConfig": PRINT,
        })
        ebook = client.post("/render", headers={"x-service-token": "fixture-render-token"}, json={
            "bookModel": book, "editionConfig": EBOOK,
        })
    assert preflight.status_code == 200, preflight.text
    assert "RTL_PRINT_FONT_UNSUPPORTED" in {item["code"] for item in preflight.json()["findings"]}
    assert render.status_code == 422
    assert "RTL print PDF" in render.json()["detail"]
    assert ebook.status_code == 200, ebook.text
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(ebook.json()["artifactBase64"]))) as archive:
        assert 'dir="rtl"' in archive.read("OEBPS/ch0000.xhtml").decode()


def test_tables_paginate_and_canonical_edits_never_hide_behind_stale_rows():
    from manuscript import table_rows
    from pypdf import PdfReader
    book = copy.deepcopy(VALID)
    rows = [[f"Row {i}", "Detail " * 12] for i in range(140)]
    table = {"id": "table-1", "type": "table", "rows": rows,
             "text": "\n".join("\t".join(r) for r in rows)}
    book["chapters"] = [{"id": "chapter", "order": 0, "title": "Tables", "nodes": [table]}]
    pdf, sha = render_pdf(book, PrintEdition())
    reader = PdfReader(io.BytesIO(pdf))
    text = "\n".join(p.extract_text() for p in reader.pages)
    assert len(reader.pages) > 3
    assert "Row 0" in text and "Row 139" in text
    assert render_pdf(book, PrintEdition())[1] == sha
    table["text"] = "Author corrected the table."
    assert table_rows(table) == []
    assert table_rows({"rows": [{"unexpected": True}]}) == []
    pdf, _ = render_pdf(book, PrintEdition())
    assert "Author corrected the table." in "".join(p.extract_text() for p in PdfReader(io.BytesIO(pdf)).pages)
    epub, _ = render_epub(book, EbookEdition())
    with zipfile.ZipFile(io.BytesIO(epub)) as z:
        content = z.read("OEBPS/ch0000.xhtml").decode()
        assert "Author corrected the table." in content and "Row 139" not in content


def _ctx(book, edition_cfg, artifact=None):
    return {"book": book, "edition": edition_cfg, "artifact": artifact,
            "channel": None, "image_bytes": {}, "cover_bytes": None}


# ---- editions ----------------------------------------------------------------

def test_parse_edition_dispatch_and_trim_validation():
    assert isinstance(parse_edition(EBOOK), EbookEdition)
    assert isinstance(parse_edition(PRINT), PrintEdition)
    with pytest.raises(ValueError):
        parse_edition({"kind": "scroll"})
    with pytest.raises(Exception):
        parse_edition({"kind": "print", "trim_size": "9x13"})


# ---- EPUB determinism + structure ---------------------------------------------

def test_epub_deterministic_sha256():
    ed = parse_edition(EBOOK)
    _, sha1 = render_epub(VALID, ed)
    _, sha2 = render_epub(VALID, ed)
    assert sha1 == sha2


def test_epub_structure():
    blob, _ = render_epub(VALID, parse_edition(EBOOK))
    zf = zipfile.ZipFile(io.BytesIO(blob))
    infos = zf.infolist()
    assert infos[0].filename == "mimetype"
    assert infos[0].compress_type == zipfile.ZIP_STORED
    assert zf.read("mimetype") == b"application/epub+zip"
    names = set(zf.namelist())
    assert "META-INF/container.xml" in names
    assert "OEBPS/content.opf" in names
    assert "OEBPS/nav.xhtml" in names
    assert b'epub:type="toc"' in zf.read("OEBPS/nav.xhtml")
    opf = zf.read("OEBPS/content.opf")
    assert b"<dc:title>The Fixture</dc:title>" in opf
    assert b"properties=\"nav\"" in opf


def test_rtl_epub_declares_direction_and_keeps_the_output_deterministic():
    book = copy.deepcopy(VALID)
    book["metadata"].update({"language": "ar", "title": "رحلة القمر", "author": "مؤلف"})
    book["chapters"][0]["nodes"] = [{"id": "rtl-1", "type": "paragraph", "text": "هذه فقرة عربية."}]
    edition = parse_edition(EBOOK)
    blob, sha = render_epub(book, edition)
    assert sha == render_epub(book, edition)[1]
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        chapter = archive.read("OEBPS/ch0000.xhtml").decode()
        nav = archive.read("OEBPS/nav.xhtml").decode()
        css = archive.read("OEBPS/style.css").decode()
    assert 'lang="ar" dir="rtl"' in chapter
    assert 'lang="ar" dir="rtl"' in nav
    assert 'html[dir="rtl"] body' in css


def _artwork() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (600, 900), "#264653").save(buf, "PNG")
    return buf.getvalue()


def test_cover_typography_qr_and_epub_manifest_are_deterministic():
    config = {
        "kind": "ebook",
        "cover": {
            "asset_id": "11111111-1111-1111-1111-111111111111",
            "qr_code": {"enabled": True, "url": "https://author.example/the-fixture", "label": "Learn more"},
        },
    }
    edition = parse_edition(config)
    cover1, sha1 = compose_front_cover(_artwork(), VALID, edition)
    cover2, sha2 = compose_front_cover(_artwork(), VALID, edition)
    assert sha1 == sha2 and cover1 == cover2
    assert Image.open(io.BytesIO(cover1)).size == (1600, 2400)
    blob, _ = render_epub(VALID, edition, cover1)
    zf = zipfile.ZipFile(io.BytesIO(blob))
    opf = zf.read("OEBPS/content.opf")
    assert b'properties="cover-image"' in opf
    assert b'<meta name="cover" content="cover-image"/>' in opf
    assert "OEBPS/cover.xhtml" in zf.namelist()
    assert "OEBPS/images/11111111-1111-1111-1111-111111111111.png" in zf.namelist()


def test_cover_qr_rejects_non_https_and_missing_artwork():
    with pytest.raises(Exception):
        parse_edition({"kind": "ebook", "cover": {"asset_id": "cover", "qr_code": {"enabled": True, "url": "http://unsafe.example"}}})
    with pytest.raises(Exception):
        parse_edition({"kind": "ebook", "cover": {"qr_code": {"enabled": True, "url": "https://safe.example"}}})


def test_rtl_print_and_cover_refuse_base_fonts_that_cannot_shape_the_script():
    book = copy.deepcopy(VALID)
    book["metadata"].update({"language": "ar", "title": "عنوان", "author": "كاتب"})
    with pytest.raises(ValueError, match="RTL print PDF"):
        render_pdf(book, parse_edition(PRINT))
    edition = parse_edition({"kind": "ebook", "cover": {"asset_id": "11111111-1111-1111-1111-111111111111"}})
    with pytest.raises(ValueError, match="RTL cover text"):
        compose_front_cover(_artwork(), book, edition)


# ---- PDF determinism -------------------------------------------------------------

def test_pdf_deterministic_sha256():
    ed = parse_edition(PRINT)
    b1, sha1 = render_pdf(VALID, ed)
    b2, sha2 = render_pdf(VALID, ed)
    assert sha1 == sha2
    assert b1.startswith(b"%PDF-")
    assert b"D:20000101000000" in b1  # reportlab invariant pins creation/mod date


def test_illustrations_are_embedded_in_epub_and_print_pdf():
    asset_id = "22222222-2222-2222-2222-222222222222"
    book = copy.deepcopy(VALID)
    book["assets"] = [{"id": asset_id, "role": "illustration", "altText": "Moonlit bridge"}]
    book["chapters"][0]["nodes"].append({"id": "image-1", "type": "image", "assetId": asset_id, "altText": "Moonlit bridge"})
    image_map = {asset_id: _artwork()}
    epub, _ = render_epub(book, parse_edition(EBOOK), image_bytes=image_map)
    zf = zipfile.ZipFile(io.BytesIO(epub))
    assert f"OEBPS/images/{asset_id}.png" in zf.namelist()
    assert f'id="image-{asset_id}"'.encode() in zf.read("OEBPS/content.opf")
    pdf, _ = render_pdf(book, parse_edition(PRINT), image_bytes=image_map)
    assert pdf.startswith(b"%PDF-") and len(pdf) > 1_000


# ---- preflight ----------------------------------------------------------------

def test_valid_book_passes_core():
    ed = parse_edition(EBOOK)
    blob, _ = render_epub(VALID, ed)
    findings = run_preflight(_ctx(VALID, EBOOK, blob), load_ruleset())
    errors = [f for f in findings if f.severity == "error"]
    assert errors == []
    assert all(f.rule_version == "core-1.0.2" for f in findings) or not findings


def test_broken_book_findings_with_location_and_rule_version():
    ed = parse_edition(EBOOK)
    blob, _ = render_epub(BROKEN, ed)
    findings = run_preflight(_ctx(BROKEN, EBOOK, blob), load_ruleset())
    errors = {f.code: f for f in findings if f.severity == "error"}
    assert "NO_TITLE" in errors
    assert "BAD_LANGUAGE" in errors
    assert "CHAPTER_NO_TITLE" in errors
    assert "IMAGE_REF_MISSING" in errors
    assert "NO_ALT_TEXT" in errors
    for f in findings:
        assert f.rule_version == "core-1.0.2"
        assert f.rule_id
    assert errors["NO_TITLE"].location == "book.metadata.title"
    assert "chapter" in errors["IMAGE_REF_MISSING"].location


def test_findings_deterministic_order():
    ed = parse_edition(EBOOK)
    blob, _ = render_epub(BROKEN, ed)
    f1 = [f.to_dict() for f in run_preflight(_ctx(BROKEN, EBOOK, blob), load_ruleset())]
    f2 = [f.to_dict() for f in run_preflight(_ctx(BROKEN, EBOOK, blob), load_ruleset())]
    assert f1 == f2
    keys = [(f["rule_id"], f["code"], f["location"]) for f in f1]
    assert keys == sorted(keys)


def test_rtl_preflight_blocks_only_unsupported_print_and_cover_text_paths():
    book = copy.deepcopy(VALID)
    book["metadata"].update({"language": "ar", "title": "عنوان", "author": "كاتب"})
    print_codes = {finding.code for finding in run_preflight(_ctx(book, PRINT), load_ruleset())}
    assert "RTL_PRINT_FONT_UNSUPPORTED" in print_codes
    assert "RTL_COVER_FONT_UNSUPPORTED" not in print_codes
    ebook_codes = {finding.code for finding in run_preflight(_ctx(book, EBOOK), load_ruleset())}
    assert "RTL_PRINT_FONT_UNSUPPORTED" not in ebook_codes
    assert "RTL_COVER_FONT_UNSUPPORTED" not in ebook_codes
    ebook_cover = {"kind": "ebook", "cover": {"asset_id": "11111111-1111-1111-1111-111111111111"}}
    cover_codes = {finding.code for finding in run_preflight(_ctx(book, ebook_cover), load_ruleset())}
    assert "RTL_COVER_FONT_UNSUPPORTED" in cover_codes


def test_kdp_ruleset_layers_channel_rules():
    ruleset = load_ruleset("kdp")
    assert ruleset.version == "core-1.0.2+kdp-1.1.0"
    assert any(r.id.startswith("KDP-") for r in ruleset.rules)
    with pytest.raises(KeyError):
        load_ruleset("nook-2009")


def _formatted_book():
    book = copy.deepcopy(VALID)
    book["metadata"]["title"] = 'A "quoted" & illustrated book'
    book["chapters"][0]["nodes"] = [
        {"id": "p1", "type": "paragraph", "text": "Bold & safe\nItalic <words> and code", "attributes": {"richText": [
            None, {"type": "text", "text": "Bold & safe", "marks": [{"type": "bold"}, {"type": "link", "attrs": {"href": "javascript:bad"}}]},
            {"type": "hardBreak"}, {"type": "text", "text": "Italic <words>", "marks": [{"type": "italic"}]},
            {"type": "text", "text": " and "}, {"type": "text", "text": "code", "marks": [{"type": "code"}]}]}},
        {"id": "p2", "type": "paragraph", "text": "Accepted edit", "attributes": {"richText": [{"type": "text", "text": "STALE DRAFT", "marks": [{"type": "bold"}]}]}},
        {"id": "l1", "type": "listItem", "text": "Parent", "attributes": {"listStyle": "ordered"}},
        {"id": "l2", "type": "listItem", "text": "Nested child", "attributes": {"listStyle": "bullet", "listDepth": 1}},
        {"id": "l3", "type": "listItem", "text": "Next parent", "attributes": {"listStyle": "ordered"}},
        {"id": "i1", "type": "image", "assetId": "22222222-2222-2222-2222-222222222222", "altText": 'A "bridge" & river', "caption": 'Arrival <at dusk>', "attributes": {"widthPercent": 50}},
    ]
    return book


def test_epub_exports_safe_rich_text_nested_lists_caption_and_width():
    book = _formatted_book()
    blob, sha = render_epub(book, parse_edition(EBOOK), image_bytes={"22222222-2222-2222-2222-222222222222": _artwork()})
    assert sha == render_epub(book, parse_edition(EBOOK), image_bytes={"22222222-2222-2222-2222-222222222222": _artwork()})[1]
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        for name in archive.namelist():
            if name.endswith((".xhtml", ".opf")):
                ET.fromstring(archive.read(name))
        chapter = archive.read("OEBPS/ch0000.xhtml").decode()
    tree = ET.fromstring(chapter)
    ns = {"h": "http://www.w3.org/1999/xhtml"}
    assert tree.find(".//h:strong", ns).text == "Bold & safe"
    assert tree.find(".//h:em", ns).text == "Italic <words>"
    assert tree.find(".//h:code", ns).text == "code"
    assert tree.find(".//h:br", ns) is not None
    assert tree.find(".//h:ol/h:li/h:ul/h:li", ns).text == "Nested child"
    illustration = tree.find(".//h:figure/h:img", ns)
    assert illustration.attrib["alt"] == 'A "bridge" & river'
    assert illustration.attrib["style"] == "width:50%"
    assert tree.find(".//h:figcaption", ns).text == "Arrival <at dusk>"
    assert "Accepted edit" in chapter and "STALE DRAFT" not in chapter and "javascript:" not in chapter


def test_epub_without_embedded_images_has_no_broken_image_reference():
    blob, _ = render_epub(_formatted_book(), parse_edition(EBOOK))
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        chapter = archive.read("OEBPS/ch0000.xhtml").decode()
    assert "<img" not in chapter and "Arrival &lt;at dusk&gt;" in chapter


def test_pdf_preserves_formatted_text_lists_and_image_caption_with_mirrored_gutter():
    from pypdf import PdfReader
    book = _formatted_book()
    edition = parse_edition({**PRINT, "margins": {"inner": 1, "outer": 0.5}})
    blob, sha = render_pdf(book, edition, {"22222222-2222-2222-2222-222222222222": _artwork()})
    assert sha == render_pdf(book, edition, {"22222222-2222-2222-2222-222222222222": _artwork()})[1]
    reader = PdfReader(io.BytesIO(blob))
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert "Bold & safe" in text and "Italic <words>" in text and "Accepted edit" in text
    assert "STALE DRAFT" not in text and "Arrival <at dusk>" in text
    assert text.index("Parent") < text.index("Nested child") < text.index("Next parent")
    fonts = {font.get_object()["/BaseFont"] for page in reader.pages for font in page["/Resources"]["/Font"].get_object().values()}
    assert {"/Times-Bold", "/Times-Italic", "/Courier"} <= fonts
    positions = []
    for page in reader.pages[:2]:
        coords = []
        page.extract_text(visitor_text=lambda value, cm, tm, font, size: coords.append(cm[4] + tm[4]) if value.strip() and size > 9 else None)
        positions.append(coords[0])
    assert positions == [72, 36]  # odd recto: inner gutter left; even verso: outer left


def test_decorative_images_have_empty_alt_without_false_preflight_error():
    book = _formatted_book()
    node = book["chapters"][0]["nodes"][-1]
    node["attributes"]["decorative"] = True
    node["altText"] = ""
    blob, _ = render_epub(book, parse_edition(EBOOK), image_bytes={node["assetId"]: _artwork()})
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        tree = ET.fromstring(archive.read("OEBPS/ch0000.xhtml"))
    assert tree.find(".//{http://www.w3.org/1999/xhtml}img").attrib["alt"] == ""
    findings = run_preflight(_ctx(book, EBOOK, blob), load_ruleset())
    assert not any(f.code == "NO_ALT_TEXT" for f in findings)


def test_verified_channel_rules_report_actionable_readiness_findings():
    print_book = copy.deepcopy(VALID)
    print_book["metadata"]["isbn13"] = None
    kdp = run_preflight(_ctx(print_book, PRINT), load_ruleset("kdp"))
    isbn = next(f for f in kdp if f.code == "KDP-PRINT-ISBN")
    assert isbn.severity == "warning" and "free KDP ISBN" in isbn.message

    lulu = run_preflight(_ctx(print_book, PRINT), load_ruleset("lulu"))
    assert any(f.code == "LULU-BLEED" and f.severity == "error" for f in lulu)
    ready_lulu = run_preflight(_ctx(print_book, {**PRINT, "bleed_in": 0.125}), load_ruleset("lulu"))
    assert not any(f.code == "LULU-BLEED" for f in ready_lulu)


def test_print_preflight_does_not_apply_epub_zip_rules():
    edition = parse_edition({**PRINT, "bleed_in": 0.125})
    artifact, _ = render_pdf(VALID, edition)
    ctx = _ctx(VALID, {**PRINT, "bleed_in": 0.125})
    ctx["artifact"] = None
    ctx["package_bytes"] = artifact
    findings = run_preflight(ctx, load_ruleset("lulu"))
    assert not any(f.code == "BAD_ZIP" for f in findings)


def test_apple_rules_check_description_categories_and_composed_cover_dimensions():
    book = copy.deepcopy(VALID)
    book["metadata"].update({"description": "Too short", "categories": []})
    small = io.BytesIO()
    Image.new("RGB", (1200, 1800), "#264653").save(small, "PNG")
    ctx = _ctx(book, EBOOK)
    ctx["cover_bytes"] = small.getvalue()
    apple = run_preflight(ctx, load_ruleset("apple"))
    codes = {finding.code for finding in apple}
    assert {"APPLE-META-MISSING", "APPLE-DESCRIPTION-LENGTH", "APPLE-COVER-SIZE"} <= codes

    book["metadata"].update({"description": "A richly detailed description that is safely longer than fifty characters.", "categories": ["FIC009000"]})
    large = io.BytesIO()
    Image.new("RGB", (1600, 2400), "#264653").save(large, "PNG")
    ctx = _ctx(book, EBOOK)
    ctx["cover_bytes"] = large.getvalue()
    apple = run_preflight(ctx, load_ruleset("apple"))
    assert not any(f.code in {"APPLE-META-MISSING", "APPLE-DESCRIPTION-LENGTH", "APPLE-COVER-SIZE", "APPLE-COVER-FORMAT"} for f in apple)
