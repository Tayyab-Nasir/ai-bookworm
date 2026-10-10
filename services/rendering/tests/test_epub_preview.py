"""Hermetic saved-artifact reader tests; generators are fixtures, not the reader."""
import base64
import copy
import hashlib
import importlib
import io
import json
import shutil
import struct
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from editions import EbookEdition
from epub_renderer import render_epub

BOOK = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/books/valid_book.json").read_text())
ART_ID = "33333333-3333-4333-8333-333333333333"
NS = {"o": "http://www.idpf.org/2007/opf", "x": "http://www.w3.org/1999/xhtml"}


@pytest.fixture
def reader():
    module = Path(__file__).resolve().parents[1] / "epub_preview.py"
    assert module.is_file(), "saved-EPUB reader implementation is missing"
    return importlib.import_module("epub_preview")


@pytest.fixture(scope="module")
def art():
    stream = io.BytesIO()
    Image.new("RGB", (120, 180), "#234567").save(stream, "PNG")
    return stream.getvalue()


@pytest.fixture(scope="module")
def reflow(art):
    book = copy.deepcopy(BOOK)
    book["chapters"][0]["nodes"][1]["text"] = "Saved & exact <words> — not a reconstruction."
    return render_epub(book, EbookEdition(include_title_page=True, navigation="toc+landmarks",
                                         cover={"asset_id": ART_ID}), cover_bytes=art, image_bytes={ART_ID: art})[0]


@pytest.fixture(scope="module")
def fixed(art):
    assert shutil.which("pdftoppm"), "real fixed-layout acceptance requires installed local Poppler"
    return render_epub(BOOK, EbookEdition(flow="fixed", navigation="toc+landmarks",
                                         cover={"asset_id": ART_ID}), cover_bytes=art, image_bytes={ART_ID: art})[0]


def entries(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return [(item.filename, archive.read(item)) for item in archive.infolist()]


def repack(data, replacements=None, additions=(), remove=()):
    replacements = replacements or {}
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, value in entries(data):
            if name in remove:
                continue
            value = replacements.get(name, value)
            archive.writestr(name, value, compress_type=zipfile.ZIP_STORED if name == "mimetype" else zipfile.ZIP_DEFLATED)
        for name, value in additions:
            archive.writestr(name, value, compress_type=zipfile.ZIP_DEFLATED)
    return output.getvalue()


def spine_path(data, index=0):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        opf = ET.fromstring(archive.read("OEBPS/content.opf"))
        manifest = {item.attrib["id"]: item.attrib["href"] for item in opf.findall("o:manifest/o:item", NS)}
        return "OEBPS/" + manifest[opf.findall("o:spine/o:itemref", NS)[index].attrib["idref"]]


def replace_document(data, body, *, index=0, head="", root_attrs='dir="ltr"'):
    content = (f'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html>'
               f'<html xmlns="http://www.w3.org/1999/xhtml" {root_attrs}>'
               f'<head><title>Saved chapter</title>{head}</head><body>{body}</body></html>').encode()
    return repack(data, {spine_path(data, index): content})


def test_saved_reflowable_artifact_identity_content_cover_and_resources(reader, reflow, art):
    response = reader.preview_epub(reflow)
    assert response["formatVersion"] == "epub-reader-1.0.0"
    assert response["sourceSha256"] == hashlib.sha256(reflow).hexdigest()
    assert response["sourceSizeBytes"] == len(reflow)
    assert response["layout"] == "reflowable"
    assert all(item["layout"] == "reflowable" for item in response["spine"])
    assert response["document"]["index"] == 0
    assert response["document"]["resources"][0] == {
        "index": 0, "mimeType": "image/png", "sha256": hashlib.sha256(art).hexdigest(),
        "sizeBytes": len(art), "width": 120, "height": 180,
    }
    assert 'data-reader-resource="0"' in response["document"]["html"]
    assert "src=" not in response["document"]["html"]
    beginning = next(item["index"] for item in response["spine"] if item["title"] == "Beginning")
    document = reader.preview_epub(reflow, beginning)["document"]
    assert "Saved &amp; exact &lt;words&gt; — not a reconstruction." in document["html"]
    assert document["direction"] == "ltr"
    resource = reader.preview_epub(reflow, resource_index=0)
    assert resource["sourceSha256"] == response["sourceSha256"]
    assert base64.b64decode(resource["resource"]["base64"], validate=True) == art
    assert {key: value for key, value in resource["resource"].items() if key != "base64"} == response["document"]["resources"][0]
    assert reader.preview_epub(reflow) == response


def test_real_fixed_pages_and_nav_per_item_reflow_override(reader, fixed):
    first = reader.preview_epub(fixed)
    assert first["layout"] == "pre-paginated"
    assert first["document"]["layout"] == "pre-paginated"
    assert first["document"]["width"] == first["document"]["resources"][0]["width"]
    assert first["document"]["height"] == first["document"]["resources"][0]["height"]
    nav = next(item for item in first["spine"] if item["layout"] == "reflowable")
    nav_response = reader.preview_epub(fixed, nav["index"])
    assert nav_response["document"]["layout"] == "reflowable"
    assert "width" not in nav_response["document"]
    assert "Beginning" in nav_response["document"]["html"]
    assert "href=" not in nav_response["document"]["html"]
    assert "links-disabled" in nav_response["warnings"]
    resource = reader.preview_epub(fixed, resource_index=0)["resource"]
    with zipfile.ZipFile(io.BytesIO(fixed)) as archive:
        assert base64.b64decode(resource["base64"]) == archive.read("OEBPS/images/page0000.png")


def test_reader_never_calls_generators_or_uses_disk_network(reader, reflow, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("reader attempted an external operation or regeneration")
    import builtins
    import socket
    import subprocess
    monkeypatch.setattr(builtins, "open", forbidden)
    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(subprocess, "run", forbidden)
    monkeypatch.setattr(sys.modules["epub_renderer"], "render_epub", forbidden)
    assert reader.preview_epub(reflow)["sourceSha256"] == hashlib.sha256(reflow).hexdigest()


def test_saved_markup_is_allowlisted_escaped_inert_and_direction_preserved(reader, reflow):
    data = replace_document(reflow, '<p onclick="evil()">Exact &amp; saved <em>emphasis</em></p>'
                            '<script>alert(1)</script><iframe src="https://attacker.example"/>'
                            '<form><input name="password"/></form><svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'
                            '<a href="javascript:alert(1)">Visible link label</a>'
                            '<img src="images/' + ART_ID + '.png" alt="&quot;safe&quot;" style="width:70%"/>'
                            '<table><tr><th scope="col">Head</th><td colspan="2">Cell</td></tr></table>',
                            head='<style>body{background:url(https://attacker.example)}</style>', root_attrs='dir="rtl" lang="ar"')
    result = reader.preview_epub(data)
    html = result["document"]["html"]
    assert "Exact &amp; saved <em>emphasis</em>" in html
    assert 'alt="&quot;safe&quot;"' in html
    assert 'data-reader-width-percent="70"' in html
    assert '<th scope="col">' in html and '<td colspan="2">' in html
    assert result["document"]["direction"] == "rtl"
    for forbidden in ["onclick", "script", "iframe", "form", "input", "<svg", "href=", "src=", "style=", "attacker.example", "url("]:
        assert forbidden not in html
    assert "active-content-removed" in result["warnings"]
    assert "unsupported-styles-ignored" in result["warnings"]


@pytest.mark.parametrize("name", ["../escape", "/absolute", "C:/drive", "OEBPS\\bad", "OEBPS/./bad", "OEBPS/../bad", "OEBPS/control\x01"])
def test_archive_paths_are_rejected(reader, reflow, name):
    data = repack(reflow, additions=[(name.replace("\\", "/"), b"bad")])
    if "\\" in name:
        # ZipInfo on Windows normalizes os.sep; patch both physical headers.
        data = data.replace(name.replace("\\", "/").encode(), name.encode())
    with pytest.raises(ValueError):
        reader.preview_epub(data)


def test_duplicate_and_case_unicode_collisions_are_rejected(reader, reflow):
    for additions in [[("OEBPS/content.opf", b"duplicate")], [("OEBPS/CONTENT.OPF", b"case")],
                      [("OEBPS/caf\u00e9", b"a"), ("OEBPS/cafe\u0301", b"b")]]:
        with pytest.raises(ValueError):
            reader.preview_epub(repack(reflow, additions=additions))


def test_zip_symlink_encryption_and_unsupported_compression_rejected(reader, reflow):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        for name, value in entries(reflow):
            archive.writestr(name, value, compress_type=zipfile.ZIP_STORED if name == "mimetype" else zipfile.ZIP_DEFLATED)
        item = zipfile.ZipInfo("OEBPS/link")
        item.create_system = 3
        item.external_attr = (0o120777 << 16)
        archive.writestr(item, b"/etc/passwd")
    with pytest.raises(ValueError):
        reader.preview_epub(stream.getvalue())
    # Synthetic central/local encryption flags, without any password or real encryption.
    encrypted = bytearray(reflow)
    local = encrypted.find(b"PK\x03\x04")
    central = encrypted.find(b"PK\x01\x02")
    struct.pack_into("<H", encrypted, local + 6, struct.unpack_from("<H", encrypted, local + 6)[0] | 1)
    struct.pack_into("<H", encrypted, central + 8, struct.unpack_from("<H", encrypted, central + 8)[0] | 1)
    with pytest.raises(ValueError):
        reader.preview_epub(bytes(encrypted))
    bzip = io.BytesIO()
    with zipfile.ZipFile(bzip, "w") as archive:
        for name, value in entries(reflow):
            archive.writestr(name, value, compress_type=zipfile.ZIP_STORED if name == "mimetype" else zipfile.ZIP_BZIP2)
    with pytest.raises(ValueError):
        reader.preview_epub(bzip.getvalue())


@pytest.mark.parametrize("xml", [
    b'<!DOCTYPE html [<!ENTITY x "boom">]><html xmlns="http://www.w3.org/1999/xhtml"><body>&x;</body></html>',
    b'<!DOCTYPE html SYSTEM "file:///etc/passwd"><html xmlns="http://www.w3.org/1999/xhtml"><body/></html>',
    b'<?xml version="1.0" encoding="ISO-8859-1"?><html xmlns="http://www.w3.org/1999/xhtml"><body/></html>',
    b'<html xmlns="http://www.w3.org/1999/xhtml"><?xml-stylesheet href="https://evil"?><body/></html>',
    b'<html xmlns="http://www.w3.org/1999/xhtml"><body>&unknown;</body></html>',
])
def test_xml_entities_dtd_processing_instructions_and_non_utf8_rejected(reader, reflow, xml):
    with pytest.raises(ValueError):
        reader.preview_epub(repack(reflow, {spine_path(reflow): xml}))


@pytest.mark.parametrize("src", ["https://attacker.example/image.png", "//attacker.example/image.png", "data:image/png;base64,AAAA",
                                  "../images/x.png", "%2e%2e/images/x.png", "images%2fimage.png", "images\\image.png", "images/x.png?token=1"])
def test_external_encoded_and_undeclared_resource_paths_rejected(reader, reflow, src):
    with pytest.raises(ValueError):
        reader.preview_epub(replace_document(reflow, f'<img src="{src}"/>'))


def test_invalid_raster_signature_mime_truncation_dimensions_and_frames_rejected(reader, reflow, art, monkeypatch):
    path = "OEBPS/images/" + ART_ID + ".png"
    invalids = [b"not a raster", art[:-12]]
    jpeg = io.BytesIO()
    Image.new("RGB", (8, 8)).save(jpeg, "JPEG")
    invalids.append(jpeg.getvalue())
    animated = io.BytesIO()
    Image.new("RGB", (8, 8)).save(animated, "PNG", save_all=True, append_images=[Image.new("RGB", (8, 8), "red")], duration=10)
    invalids.append(animated.getvalue())
    for value in invalids:
        with pytest.raises(ValueError):
            reader.preview_epub(repack(reflow, {path: value}), resource_index=0)
    monkeypatch.setattr(reader, "MAX_IMAGE_PIXELS", 100)
    with pytest.raises(ValueError):
        reader.preview_epub(reflow, resource_index=0)


def test_crc_and_false_declared_uncompressed_size_are_rejected(reader, reflow):
    corrupt = bytearray(reflow)
    with zipfile.ZipFile(io.BytesIO(reflow)) as archive:
        image = archive.getinfo("OEBPS/images/" + ART_ID + ".png")
        offset = image.header_offset
        start = offset + 30 + struct.unpack_from("<H", corrupt, offset + 26)[0] + struct.unpack_from("<H", corrupt, offset + 28)[0]
        corrupt[start + image.compress_size // 2] ^= 0x20
    with pytest.raises(ValueError):
        reader.preview_epub(bytes(corrupt))
    false_size = bytearray(reflow)
    position = 0
    while (position := false_size.find(b"PK\x01\x02", position)) >= 0:
        name_len = struct.unpack_from("<H", false_size, position + 28)[0]
        if false_size[position + 46:position + 46 + name_len].decode() == image.filename:
            struct.pack_into("<I", false_size, position + 24, 1)
            struct.pack_into("<I", false_size, image.header_offset + 22, 1)
            break
        position += 4
    with pytest.raises(ValueError):
        reader.preview_epub(bytes(false_size))


def test_hard_source_zip_xml_node_depth_and_resource_limits(reader, reflow, monkeypatch):
    limits = [("MAX_SOURCE_BYTES", len(reflow) - 1), ("MAX_ZIP_ENTRIES", 2),
              ("MAX_EXPANDED_BYTES", 100), ("MAX_METADATA_BYTES", 30),
              ("MAX_XHTML_BYTES", 100), ("MAX_NODES", 2), ("MAX_IMAGE_BYTES", 10),
              ("MAX_HTML_BYTES", 5), ("MAX_SPINE_ITEMS", 1)]
    for name, value in limits:
        with monkeypatch.context() as scoped:
            scoped.setattr(reader, name, value)
            with pytest.raises(ValueError):
                reader.preview_epub(reflow)
    deep = replace_document(reflow, "<div>" * 70 + "saved" + "</div>" * 70)
    with pytest.raises(ValueError):
        reader.preview_epub(deep)


def test_css_is_never_returned_and_oversize_css_rejected(reader, reflow, monkeypatch):
    data = repack(reflow, {"OEBPS/style.css": b'@import "https://evil";body{position:fixed;url(file:///secret)}'})
    result = reader.preview_epub(data)
    assert "unsupported-styles-ignored" in result["warnings"]
    assert "evil" not in result["document"]["html"]
    monkeypatch.setattr(reader, "MAX_CSS_BYTES", 10)
    with pytest.raises(ValueError):
        reader.preview_epub(reflow)


def test_manifest_container_and_spine_ambiguity_rejected(reader, reflow):
    with zipfile.ZipFile(io.BytesIO(reflow)) as archive:
        opf = archive.read("OEBPS/content.opf")
        container = archive.read("META-INF/container.xml")
    changed = [
        repack(reflow, {"OEBPS/content.opf": opf.replace(b"</manifest>", b'<item id="nav" href="other.xhtml" media-type="application/xhtml+xml"/></manifest>')}),
        repack(reflow, {"OEBPS/content.opf": opf.replace(b"</spine>", b'<itemref idref="absent"/></spine>')}),
        repack(reflow, {"OEBPS/content.opf": opf.replace(b"</spine>", b'<itemref idref="nav" properties="rendition:layout-reflowable rendition:layout-pre-paginated"/></spine>')}),
        repack(reflow, {"META-INF/container.xml": container.replace(b"</rootfiles>", b'<rootfile full-path="OEBPS/other.opf" media-type="application/oebps-package+xml"/></rootfiles>')}),
        repack(reflow, {"mimetype": b"text/html"}),
    ]
    for data in changed:
        with pytest.raises(ValueError):
            reader.preview_epub(data)


def test_fixed_viewport_must_be_bounded_and_match_saved_raster(reader, fixed):
    with zipfile.ZipFile(io.BytesIO(fixed)) as archive:
        path = spine_path(fixed)
        document = archive.read(path)
    for changed in [document.replace(b"width=", b"width=999999"), document.replace(b'<meta name="viewport"', b'<meta name="not-viewport"')]:
        with pytest.raises(ValueError):
            reader.preview_epub(repack(fixed, {path: changed}))


@pytest.mark.parametrize("spine,resource", [(True, None), (-1, None), (9999, None), (0, True), (0, -1), (0, 9999), (0.0, None)])
def test_indices_fail_closed(reader, reflow, spine, resource):
    with pytest.raises(ValueError):
        reader.preview_epub(reflow, spine, resource)


@pytest.mark.parametrize("data", [b"", b"not zip", "not bytes", bytearray(b"PK")])
def test_invalid_source_type_and_zip_rejected(reader, data):
    with pytest.raises(ValueError):
        reader.preview_epub(data)


def test_jpeg_and_multiple_resource_indices_are_bound_to_manifest_order(reader, art):
    cover_id = "44444444-4444-4444-8444-444444444444"
    data = render_epub(BOOK, EbookEdition(cover={"asset_id": cover_id}), cover_bytes=art,
                       image_bytes={ART_ID: art})[0]
    cover = reader.preview_epub(data)["document"]["resources"]
    assert [resource["index"] for resource in cover] == [0]
    end_index = next(item["index"] for item in reader.preview_epub(data)["spine"] if item["title"] == "End")
    assert [resource["index"] for resource in reader.preview_epub(data, end_index)["document"]["resources"]] == [1]
    jpeg = io.BytesIO()
    Image.new("RGB", (12, 18), "blue").save(jpeg, "JPEG")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        opf = archive.read("OEBPS/content.opf").replace(b'media-type="image/png"', b'media-type="image/jpeg"')
    changed = repack(data, {"OEBPS/content.opf": opf, "OEBPS/images/" + cover_id + ".png": jpeg.getvalue(),
                            "OEBPS/images/" + ART_ID + ".png": jpeg.getvalue()})
    resource = reader.preview_epub(changed, resource_index=1)["resource"]
    assert resource["mimeType"] == "image/jpeg"
    assert (resource["width"], resource["height"]) == (12, 18)
    assert base64.b64decode(resource["base64"]) == jpeg.getvalue()


def test_response_size_and_mixed_fixed_page_fail_closed(reader, reflow, fixed, monkeypatch):
    monkeypatch.setattr(reader, "MAX_RESPONSE_BYTES", 100)
    with pytest.raises(ValueError):
        reader.preview_epub(reflow)
    monkeypatch.undo()
    with zipfile.ZipFile(io.BytesIO(fixed)) as archive:
        path = spine_path(fixed)
        changed = archive.read(path).replace(b"</body>", b"<p>Unsupported fixed-page overlay</p></body>")
    with pytest.raises(ValueError):
        reader.preview_epub(repack(fixed, {path: changed}))


def test_doctype_is_allowed_only_as_exact_harmless_prologue(reader, reflow):
    harmless = replace_document(reflow, "<p>Exact saved content.</p>")
    assert "Exact saved content." in reader.preview_epub(harmless)["document"]["html"]
    with zipfile.ZipFile(io.BytesIO(harmless)) as archive:
        path = spine_path(harmless)
        document = archive.read(path).replace(b"<!DOCTYPE html>", b"")
    for changed in [document.replace(b"<body>", b"<body><![CDATA[<!DOCTYPE html>]]>"),
                    document.replace(b"<body>", b"<body><!DOCTYPE html>")]:
        with pytest.raises(ValueError):
            reader.preview_epub(repack(harmless, {path: changed}))


def test_active_head_metadata_and_root_handlers_are_stripped_with_warning(reader, reflow):
    data = replace_document(reflow, "<p>Saved text.</p>",
                            head='<meta http-equiv="refresh" content="0;url=https://evil.example"/>',
                            root_attrs='dir="ltr" onload="evil()"')
    result = reader.preview_epub(data)
    assert "active-content-removed" in result["warnings"]
    assert "evil" not in result["document"]["html"]


@pytest.mark.parametrize("suffix", ["?", "#", "?q=", "#fragment"])
def test_even_empty_resource_query_or_fragment_is_rejected(reader, reflow, suffix):
    with pytest.raises(ValueError):
        reader.preview_epub(replace_document(reflow, f'<img src="images/{ART_ID}.png{suffix}"/>'))


def test_raw_nul_and_nonempty_directory_entries_rejected(reader, reflow):
    nul = repack(reflow, additions=[("OEBPS/evilXname", b"bad")]).replace(b"OEBPS/evilXname", b"OEBPS/evil\x00name")
    for data in [nul, repack(reflow, additions=[("OEBPS/extra/", b"not a directory")])]:
        with pytest.raises(ValueError):
            reader.preview_epub(data)
