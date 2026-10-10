"""Adapter tests: channel rules wired, export package deterministic, submit not supported."""
import json
import base64
import copy
import importlib.util
import sys
import zipfile
import zlib
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "publishing"))
sys.path.insert(0, str(ROOT / "rendering"))

from adapters import NotSupportedError, get_adapter  # noqa: E402
from editions import parse_edition  # noqa: E402
from epub_renderer import render_epub  # noqa: E402

_MAIN_SPEC = importlib.util.spec_from_file_location("bookworm_publishing_main", ROOT / "publishing" / "main.py")
assert _MAIN_SPEC and _MAIN_SPEC.loader
_PUBLISHING_MAIN = importlib.util.module_from_spec(_MAIN_SPEC)
_MAIN_SPEC.loader.exec_module(_PUBLISHING_MAIN)
PackageRequest = _PUBLISHING_MAIN.PackageRequest
build_package = _PUBLISHING_MAIN.build_package
require_service_token = _PUBLISHING_MAIN.require_service_token

FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "books"
VALID = json.loads((FIXTURES / "valid_book.json").read_text())
EBOOK = {"kind": "ebook"}


def _ctx(artifact=True):
    blob = None
    if artifact:
        blob, _ = render_epub(VALID, parse_edition(EBOOK))
    return {"book": VALID, "edition": EBOOK, "artifact": blob, "channel": "kdp",
            "image_bytes": {}}


def test_all_channels_registered():
    for ch in ("kdp", "apple", "barnesnoble", "lulu", "googleplay"):
        assert get_adapter(ch).channel() == ch
    with pytest.raises(KeyError):
        get_adapter("smashwords")


def test_kdp_validate_uses_kdp_rules():
    result = get_adapter("kdp").validate(_ctx())
    assert result["ruleVersion"] == "core-1.0.8+kdp-1.4.0"
    ids = {f["rule_id"] for f in result["findings"]}
    assert not result["findings"] or all(
        rid.startswith(("CORE-", "KDP-")) for rid in ids)
    assert result["errors"] == 0  # valid fixture has all KDP-required metadata


def test_kdp_validate_flags_missing_description():
    book = json.loads(json.dumps(VALID))
    del book["metadata"]["description"]
    ctx = _ctx()
    ctx["book"] = book
    result = get_adapter("kdp").validate(ctx)
    assert result["errors"] >= 1
    assert any(f["rule_id"] == "KDP-META-001" for f in result["findings"])


def test_google_play_requires_embedded_front_cover_and_builds_single_title_handoff(monkeypatch):
    from PIL import Image
    from epubcheck_runner import EpubCheckResult
    import rules.google_play_v1 as google_rules
    monkeypatch.setattr(google_rules, "run_epubcheck", lambda _epub: EpubCheckResult("valid"))
    adapter = get_adapter("googleplay")
    assert adapter.capabilities().formats == ("epub",)
    assert adapter.capabilities().can_submit is False
    missing = adapter.validate({**_ctx(), "channel": "googleplay"})
    assert any(item["code"] == "GOOGLE-EPUB-COVER" for item in missing["findings"])

    cover_id = "google-test-cover"
    edition = {"kind": "ebook", "cover": {"asset_id": cover_id}}
    cover = BytesIO()
    Image.new("RGB", (800, 1200), "#43536a").save(cover, "PNG")
    epub, _ = render_epub(VALID, parse_edition(edition), cover.getvalue())
    ctx = {"book": VALID, "edition": edition, "artifact": epub, "channel": "googleplay",
           "cover_bytes": cover.getvalue()}
    result = adapter.validate(ctx)
    assert result["errors"] == 0, result["findings"]
    assert result["ruleVersion"] == "core-1.0.8+google-play-1.1.0"
    exported = adapter.build_package(ctx, {"book.epub": epub})[0]
    assert exported.path == "googleplay-export.zip"
    with zipfile.ZipFile(BytesIO(exported.data)) as archive:
        assert archive.read("book.epub") == epub
        assert b"Partner Center Content tab" in archive.read("README.txt")
        assert json.loads(archive.read("manifest.json"))["channel"] == "googleplay"

    too_small = BytesIO()
    Image.new("RGB", (320, 480), "#43536a").save(too_small, "PNG")
    small_epub, _ = render_epub(VALID, parse_edition(edition), too_small.getvalue())
    small = adapter.validate({**ctx, "artifact": small_epub})
    assert any(item["code"] == "GOOGLE-EPUB-COVER" for item in small["findings"])
    print_only = adapter.validate({**ctx, "edition": {"kind": "print"}})
    assert any(item["code"] == "GOOGLE-EPUB-ONLY" for item in print_only["findings"])


def test_google_play_fails_closed_when_epubcheck_is_unavailable(monkeypatch):
    import rules.google_play_v1 as google_rules
    from epubcheck_runner import EpubCheckResult
    monkeypatch.setattr(google_rules, "run_epubcheck", lambda _epub: EpubCheckResult("unavailable"))
    result = get_adapter("googleplay").validate({**_ctx(), "channel": "googleplay"})
    assert any(item["code"] == "GOOGLE-EPUBCHECK-UNAVAILABLE" for item in result["findings"])


def test_build_package_deterministic_export_zip():
    adapter = get_adapter("kdp")
    blob, _ = render_epub(VALID, parse_edition(EBOOK))
    p1 = adapter.build_package(_ctx(), {"book.epub": blob})
    p2 = adapter.build_package(_ctx(), {"book.epub": blob})
    assert p1[0].sha256 == p2[0].sha256
    zf = zipfile.ZipFile(BytesIO(p1[0].data))
    manifest = json.loads(zf.read("manifest.json"))
    assert manifest["channel"] == "kdp"
    assert manifest["files"]["book.epub"]


def test_submit_and_status_not_supported():
    adapter = get_adapter("lulu")
    with pytest.raises(NotSupportedError):
        adapter.submit({})
    with pytest.raises(NotSupportedError):
        adapter.get_status("job-1")
    caps = adapter.capabilities()
    assert caps.can_submit is False and caps.can_check_status is False


def test_export_preserves_located_preflight_warnings_and_binds_report_checksum(monkeypatch):
    import hashlib
    adapter = get_adapter("kdp")
    ctx = _ctx()
    report = {"channel": "kdp", "ruleVersion": "fixture-rule-1", "errors": 0, "warnings": 1,
              "findings": [{"code": "FIXTURE-WARNING", "message": "Review café artwork",
                            "location": "chapters/1/nodes/2", "severity": "warning",
                            "category": "images", "rule_id": "fixture.image", "rule_version": "fixture-rule-1"}]}
    monkeypatch.setattr(adapter, "validate", lambda _: report)
    first = adapter.build_package(ctx, {"book.epub": ctx["artifact"]})[0]
    assert first.data == adapter.build_package(ctx, {"book.epub": ctx["artifact"]})[0].data
    with zipfile.ZipFile(BytesIO(first.data)) as archive:
        saved = archive.read("preflight.json")
        assert json.loads(saved) == {"schemaVersion": "1.0", **report}
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["files"]["preflight.json"] == hashlib.sha256(saved).hexdigest()
        assert manifest["warnings"] == 1
        assert b"review all warnings" in archive.read("README.txt")


def test_package_metadata_is_exact_allowlisted_unicode_and_checksum_bound():
    import hashlib
    ctx = _ctx()
    book = copy.deepcopy(VALID)
    book["metadata"].update(title="Le voyage — 帰郷", description="First line\nSecond line: café",
                            keywords=["cozy fantasy", "帰郷"], subtitle="A saved subtitle",
                            privateToken="DO-NOT-EXPORT", internalNotes={"secret": "DO-NOT-EXPORT"})
    book["bookBible"] = {"entities": [{"description": "DO-NOT-EXPORT"}]}
    ctx["book"] = book
    adapter = get_adapter("kdp")
    artifacts = {"book.epub": ctx["artifact"]}
    first = adapter.build_package(ctx, artifacts)[0]
    assert first.data == adapter.build_package(ctx, artifacts)[0].data
    assert list(artifacts) == ["book.epub"], "caller artifacts mutated"
    with zipfile.ZipFile(BytesIO(first.data)) as archive:
        listing = json.loads(archive.read("metadata.json"))
        assert listing["schemaVersion"] == "1.0"
        assert listing["metadata"] == {key: value for key, value in book["metadata"].items()
                                       if key not in {"privateToken", "internalNotes"}}
        assert b"DO-NOT-EXPORT" not in archive.read("metadata.json")
        assert b"not a retailer import schema" in archive.read("README.txt")
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["packageVersion"] == "2.0"
        assert set(manifest["files"]) == set(archive.namelist()) - {"manifest.json"}
        for name, checksum in manifest["files"].items():
            assert hashlib.sha256(archive.read(name)).hexdigest() == checksum


@pytest.mark.parametrize("name", ["manifest.json", "metadata.json", "preflight.json", "README.txt"])
def test_package_rejects_reserved_artifact_names(name):
    ctx = _ctx()
    with pytest.raises(ValueError, match="reserved"):
        get_adapter("kdp").build_package(ctx, {"book.epub": ctx["artifact"], name: b"spoofed"})


@pytest.mark.parametrize("field,value", [("description", {"secret": "hidden"}), ("keywords", [{"secret": "hidden"}])])
def test_metadata_projection_rejects_nested_values(field, value):
    from adapters import publishing_metadata
    book = copy.deepcopy(VALID)
    book["metadata"][field] = value
    with pytest.raises(ValueError, match="must be"):
        publishing_metadata(book)


def test_export_preserves_publication_date_and_date_only_changes_package_identity(monkeypatch):
    import hashlib
    adapter = get_adapter("kdp")
    ctx = _ctx(artifact=False)
    ctx["book"] = copy.deepcopy(VALID)
    ctx["book"]["metadata"].update(publicationDate="2024-02-29", privateNotes="DO-NOT-EXPORT")
    monkeypatch.setattr(adapter, "validate", lambda _: {"channel": "kdp", "ruleVersion": "fixture-rule",
        "errors": 0, "warnings": 0, "findings": []})
    artifacts = {"book.epub": render_epub(ctx["book"], parse_edition(EBOOK))[0]}
    first = adapter.build_package(ctx, artifacts)[0]
    assert adapter.build_package(ctx, artifacts)[0].data == first.data
    with zipfile.ZipFile(BytesIO(first.data)) as archive:
        listing_bytes = archive.read("metadata.json")
        assert json.loads(listing_bytes)["metadata"]["publicationDate"] == "2024-02-29"
        assert b"DO-NOT-EXPORT" not in listing_bytes
        assert json.loads(archive.read("manifest.json"))["files"]["metadata.json"] == hashlib.sha256(listing_bytes).hexdigest()
        assert archive.read("book.epub") == artifacts["book.epub"]
    ctx["book"]["metadata"]["publicationDate"] = "2026-11-01"
    artifacts["book.epub"] = render_epub(ctx["book"], parse_edition(EBOOK))[0]
    second = adapter.build_package(ctx, artifacts)[0]
    assert first.sha256 != second.sha256


@pytest.mark.parametrize("value", ["2026-02-30", "1900-02-29", "2026-1-01", "0000-01-01", "2026-01-01T00:00:00Z", "", 20260101])
def test_metadata_projection_rejects_invalid_publication_dates(value):
    from adapters import publishing_metadata
    book = copy.deepcopy(VALID)
    book["metadata"]["publicationDate"] = value
    with pytest.raises(ValueError, match="publicationDate"):
        publishing_metadata(book)


def test_metadata_projection_preserves_optional_and_null_publication_date():
    from adapters import publishing_metadata
    book = copy.deepcopy(VALID)
    assert "publicationDate" not in publishing_metadata(book)["metadata"]
    book["metadata"]["publicationDate"] = None
    assert "publicationDate" not in publishing_metadata(book)["metadata"]


def test_package_endpoint_uses_the_exact_saved_artifact_deterministically():
    blob, _ = render_epub(VALID, parse_edition(EBOOK))
    request = PackageRequest(channel="kdp", editionConfig=EBOOK, bookModel=VALID,
                             artifactsBase64={"book.epub": base64.b64encode(blob).decode()})
    first = build_package(request)
    second = build_package(request)
    assert first["ruleVersion"] == "core-1.0.8+kdp-1.4.0"
    assert first["packages"][0]["sha256"] == second["packages"][0]["sha256"]
    package = base64.b64decode(first["packages"][0]["dataBase64"])
    with zipfile.ZipFile(BytesIO(package)) as archive:
        assert archive.read("book.epub") == blob


@pytest.fixture
def publication_date_publishing_client(monkeypatch):
    from fastapi.testclient import TestClient
    monkeypatch.setenv("PUBLISHING_SERVICE_TOKEN", "publication-date-fixture")
    with TestClient(_PUBLISHING_MAIN.app, raise_server_exceptions=False) as client:
        yield client


@pytest.mark.parametrize("value", ["0000-01-01", "2026-02-30"])
@pytest.mark.parametrize("source", ["base", "override"])
@pytest.mark.parametrize("route", ["validate", "package"])
def test_publishing_http_rejects_malformed_effective_publication_dates(publication_date_publishing_client, route, source, value):
    book = copy.deepcopy(VALID)
    config = copy.deepcopy(EBOOK)
    book["metadata"]["publicationDate"] = value if source == "base" else "2024-02-29"
    if source == "override":
        config["metadata_overrides"] = {"publicationDate": value}
    payload = {"channel": "kdp", "bookModel": book, "editionConfig": config}
    if route == "package":
        saved, _ = render_epub(VALID, parse_edition(EBOOK))
        payload["artifactsBase64"] = {"book.epub": base64.b64encode(saved).decode()}
    response = publication_date_publishing_client.post(f"/v1/publishing/{route}",
        headers={"x-service-token": "publication-date-fixture"}, json=payload)
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": "publicationDate must be a valid YYYY-MM-DD calendar date."}


@pytest.mark.parametrize("case", ["absent", "null", "base", "override", "override-masks-base"])
@pytest.mark.parametrize("route", ["validate", "package"])
def test_publishing_http_preserves_valid_effective_publication_dates(publication_date_publishing_client, route, case):
    book = copy.deepcopy(VALID)
    config = copy.deepcopy(EBOOK)
    if case != "absent":
        book["metadata"]["publicationDate"] = None if case == "null" else (
            "0000-01-01" if case == "override-masks-base" else "2024-02-29")
    if case.startswith("override"):
        config["metadata_overrides"] = {"publicationDate": "2026-11-01"}
    payload = {"channel": "kdp", "bookModel": book, "editionConfig": config}
    saved, _ = render_epub(book, parse_edition(config))
    if route == "package":
        payload["artifactsBase64"] = {"book.epub": base64.b64encode(saved).decode()}
    original = copy.deepcopy(payload)
    response = publication_date_publishing_client.post(f"/v1/publishing/{route}",
        headers={"x-service-token": "publication-date-fixture"}, json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["errors"] == 0
    assert payload == original
    if route == "package":
        with zipfile.ZipFile(BytesIO(base64.b64decode(response.json()["packages"][0]["dataBase64"]))) as package:
            assert package.read("book.epub") == saved
            listing = json.loads(package.read("metadata.json"))["metadata"]
            with zipfile.ZipFile(BytesIO(package.read("book.epub"))) as epub:
                opf = ET.fromstring(epub.read("OEBPS/content.opf"))
            date = opf.find("{http://www.idpf.org/2007/opf}metadata/{http://purl.org/dc/elements/1.1/}date")
            if case in ("absent", "null"):
                assert "publicationDate" not in listing and date is None
            else:
                expected = "2026-11-01" if case.startswith("override") else "2024-02-29"
                assert listing["publicationDate"] == expected and date.text == expected
    if case in ("absent", "null"):
        baseline_payload = {"channel": "kdp", "bookModel": VALID, "editionConfig": EBOOK}
        if route == "package":
            legacy, _ = render_epub(VALID, parse_edition(EBOOK))
            assert legacy == saved
            baseline_payload["artifactsBase64"] = {"book.epub": base64.b64encode(legacy).decode()}
        baseline = publication_date_publishing_client.post(f"/v1/publishing/{route}",
            headers={"x-service-token": "publication-date-fixture"}, json=baseline_payload)
        assert baseline.status_code == 200, baseline.text
        assert response.json() == baseline.json()


@pytest.mark.parametrize("flow", ["reflowable", "fixed"])
@pytest.mark.parametrize("saved_date", [None, "2024-02-29"])
def test_effective_publication_metadata_matches_real_epub_and_package(flow, saved_date):
    import hashlib
    book = copy.deepcopy(VALID)
    book["metadata"].update(publicationDate=saved_date, privateNotes="DO-NOT-EXPORT")
    config = {"kind": "ebook", "flow": flow, "metadata_overrides": {
        "publicationDate": "2026-11-01", "title": "Edition & listing title",
        "author": "Edition Author", "description": "Saved edition description.", "language": "fr",
        "privateNotes": "DO-NOT-EXPORT"}}
    original = copy.deepcopy((book, config))
    blob, render_sha = render_epub(book, parse_edition(config))
    request = PackageRequest(channel="kdp", editionConfig=config, bookModel=book,
                             artifactsBase64={"book.epub": base64.b64encode(blob).decode()})
    first = build_package(request)
    assert build_package(request) == first
    assert render_epub(book, parse_edition(config)) == (blob, render_sha)
    ns = {"o": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
    with zipfile.ZipFile(BytesIO(base64.b64decode(first["packages"][0]["dataBase64"]))) as archive:
        assert archive.read("book.epub") == blob
        listing_bytes = archive.read("metadata.json")
        listing = json.loads(listing_bytes)["metadata"]
        with zipfile.ZipFile(BytesIO(archive.read("book.epub"))) as epub:
            opf = ET.fromstring(epub.read("OEBPS/content.opf"))
            for field, element in (("publicationDate", "date"), ("title", "title"),
                                   ("author", "creator"), ("description", "description"), ("language", "language")):
                assert listing[field] == config["metadata_overrides"][field]
                assert opf.find(f"o:metadata/dc:{element}", ns).text == listing[field]
        assert b"DO-NOT-EXPORT" not in listing_bytes
        assert json.loads(archive.read("manifest.json"))["files"]["metadata.json"] == hashlib.sha256(listing_bytes).hexdigest()
    assert (book, config) == original, "effective metadata mutated saved source or edition"
    config["metadata_overrides"]["publicationDate"] = "2027-01-01"
    revised, revised_sha = render_epub(book, parse_edition(config))
    second = build_package(PackageRequest(channel="kdp", editionConfig=config, bookModel=book,
                           artifactsBase64={"book.epub": base64.b64encode(revised).decode()}))
    assert revised_sha != render_sha
    assert second["packages"][0]["sha256"] != first["packages"][0]["sha256"]


def test_effective_null_saved_date_clearing_preserves_legacy_render_and_package_identity():
    book = copy.deepcopy(VALID)
    blob, render_sha = render_epub(book, parse_edition(EBOOK))
    request = lambda: PackageRequest(channel="kdp", editionConfig=EBOOK, bookModel=book,
                      artifactsBase64={"book.epub": base64.b64encode(blob).decode()})
    legacy = build_package(request())
    book["metadata"]["publicationDate"] = "2024-02-29"
    dated, dated_sha = render_epub(book, parse_edition(EBOOK))
    assert dated_sha != render_sha
    dated_package = build_package(PackageRequest(channel="kdp", editionConfig=EBOOK, bookModel=book,
                                 artifactsBase64={"book.epub": base64.b64encode(dated).decode()}))
    assert dated_package["packages"][0]["sha256"] != legacy["packages"][0]["sha256"]
    book["metadata"]["publicationDate"] = None
    assert render_epub(book, parse_edition(EBOOK)) == (blob, render_sha)
    assert build_package(request()) == legacy


@pytest.mark.parametrize("value", ["0000-01-01", "2026-02-30", "2026-1-01", ""])
def test_effective_publication_metadata_rejects_malformed_supported_override(value):
    from adapters import publishing_metadata
    config = {"kind": "ebook", "metadata_overrides": {"publicationDate": value}}
    with pytest.raises(ValueError, match="publicationDate"):
        render_epub(VALID, parse_edition(config))
    with pytest.raises(ValueError, match="publicationDate"):
        publishing_metadata(VALID, config)


@pytest.mark.parametrize("flow", ["reflowable", "fixed"])
@pytest.mark.parametrize("change", ["date-added", "date-replaced", "date-cleared", "language"])
def test_effective_publication_metadata_rejects_old_saved_epub_before_packaging(flow, change):
    from fastapi import HTTPException
    book = copy.deepcopy(VALID)
    config = {"kind": "ebook", "flow": flow}
    if change in ("date-replaced", "date-cleared"):
        book["metadata"]["publicationDate"] = "2024-02-29"
    old_artifact, _ = render_epub(book, parse_edition(config))
    if change == "date-cleared":
        book["metadata"]["publicationDate"] = None
    else:
        config["metadata_overrides"] = ({"language": "fr"} if change == "language"
                                        else {"publicationDate": "2026-11-01"})
    with pytest.raises(HTTPException) as caught:
        build_package(PackageRequest(channel="kdp", editionConfig=config, bookModel=book,
                      artifactsBase64={"book.epub": base64.b64encode(old_artifact).decode()}))
    assert caught.value.status_code == 422
    assert "Render again" in caught.value.detail


@pytest.mark.parametrize("malformation", ["oversize", "doctype", "non-utf8", "broken-xml",
                                          "duplicate-opf", "duplicate-date", "duplicate-language", "missing-metadata"])
def test_effective_publication_metadata_saved_opf_inspection_is_bounded_and_unambiguous(malformation, monkeypatch):
    blob, _ = render_epub(VALID, parse_edition(EBOOK))
    with zipfile.ZipFile(BytesIO(blob)) as archive:
        entries = [(info, archive.read(info)) for info in archive.infolist()]
    original = next(data for info, data in entries if info.filename == "OEBPS/content.opf")
    replacement = {
        "oversize": b"x" * 1_000_001,
        "doctype": original.replace(b"<package ", b'<!DOCTYPE package [<!ENTITY x "denied">]><package ', 1),
        "non-utf8": b"\xff",
        "broken-xml": b"<package>",
        "duplicate-date": original.replace(b"</metadata>", b"<dc:date>2024-02-29</dc:date><dc:date>2026-11-01</dc:date></metadata>"),
        "duplicate-language": original.replace(b"</metadata>", b"<dc:language>en</dc:language></metadata>"),
        "missing-metadata": b'<package xmlns="http://www.idpf.org/2007/opf" />',
    }.get(malformation, original)
    output = BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for info, data in entries:
            archive.writestr(info, replacement if info.filename == "OEBPS/content.opf" else data)
        if malformation == "duplicate-opf":
            with pytest.warns(UserWarning, match="Duplicate name"):
                archive.writestr("OEBPS/content.opf", replacement)
    corrupted = output.getvalue()
    adapter = get_adapter("kdp")
    monkeypatch.setattr(adapter, "validate", lambda _: {"channel": "kdp", "ruleVersion": "fixture-rule",
        "errors": 0, "warnings": 0, "findings": []})
    with pytest.raises(ValueError, match="Render again"):
        adapter.build_package({"book": VALID, "edition": EBOOK, "artifact": corrupted}, {"book.epub": corrupted})


@pytest.mark.parametrize("failure", ["invalid-deflate", "eof"])
def test_saved_opf_compressed_read_failures_are_safe_package_rejections(failure, monkeypatch):
    from fastapi import HTTPException
    blob, _ = render_epub(VALID, parse_edition(EBOOK))
    if failure == "invalid-deflate":
        with zipfile.ZipFile(BytesIO(blob)) as archive:
            info = archive.getinfo("OEBPS/content.opf")
        assert info.compress_type == zipfile.ZIP_DEFLATED
        header = info.header_offset
        data_offset = header + 30 + int.from_bytes(blob[header + 26:header + 28], "little") + int.from_bytes(
            blob[header + 28:header + 30], "little")
        corrupted = bytearray(blob)
        # BTYPE=11 is an invalid DEFLATE block; leave the other ZIP entries intact.
        corrupted[data_offset] = (corrupted[data_offset] & ~6) | 6
        blob = bytes(corrupted)
        with zipfile.ZipFile(BytesIO(blob)) as archive:
            with pytest.raises(zlib.error):
                archive.read("OEBPS/content.opf")
    else:
        read = zipfile.ZipExtFile.read

        def truncated_opf_read(stream, *args, **kwargs):
            if stream.name == "OEBPS/content.opf":
                raise EOFError("truncated OPF compressed stream")
            return read(stream, *args, **kwargs)

        monkeypatch.setattr(zipfile.ZipExtFile, "read", truncated_opf_read)
    # Exercise the real preflight and HTTP boundary, not a mocked validation result.
    with pytest.raises(HTTPException) as caught:
        build_package(PackageRequest(channel="kdp", editionConfig=EBOOK, bookModel=VALID,
                      artifactsBase64={"book.epub": base64.b64encode(blob).decode()}))
    assert caught.value.status_code == 422
    assert "Render again" in caught.value.detail


@pytest.mark.parametrize("encoding", ["x-bookworm-unknown", "ISO-8859-1"])
def test_saved_opf_encoding_declaration_must_match_validated_utf8(encoding):
    from fastapi import HTTPException
    blob, _ = render_epub(VALID, parse_edition(EBOOK))
    output = BytesIO()
    with zipfile.ZipFile(BytesIO(blob)) as source, zipfile.ZipFile(output, "w") as target:
        for info in source.infolist():
            data = source.read(info)
            if info.filename == "OEBPS/content.opf":
                assert b'encoding="UTF-8"' in data
                data = data.replace(b'encoding="UTF-8"', f'encoding="{encoding}"'.encode(), 1)
                data.decode("utf-8")  # These are UTF-8 bytes with a conflicting declaration.
            target.writestr(info, data)
    with pytest.raises(HTTPException) as caught:
        build_package(PackageRequest(channel="kdp", editionConfig=EBOOK, bookModel=VALID,
                      artifactsBase64={"book.epub": base64.b64encode(output.getvalue()).decode()}))
    assert caught.value.status_code == 422
    assert "Render again" in caught.value.detail


@pytest.mark.parametrize("field", ["date", "language"])
@pytest.mark.parametrize("content", ["child", "tail"])
def test_saved_opf_matching_prefix_with_nested_or_trailing_content_is_rejected(field, content):
    from fastapi import HTTPException
    book = copy.deepcopy(VALID)
    book["metadata"]["publicationDate"] = "2024-02-29"
    blob, _ = render_epub(book, parse_edition(EBOOK))
    output = BytesIO()
    closing = f"</dc:{field}>".encode()
    with zipfile.ZipFile(BytesIO(blob)) as source, zipfile.ZipFile(output, "w") as target:
        for info in source.infolist():
            data = source.read(info)
            if info.filename == "OEBPS/content.opf":
                assert closing in data
                addition = b"<nested>unexpected</nested>" + closing if content == "child" else closing + b"unexpected"
                data = data.replace(closing, addition, 1)
            target.writestr(info, data)
    # Real preflight must still lead to a safe HTTP rejection for these XML bytes.
    with pytest.raises(HTTPException) as caught:
        build_package(PackageRequest(channel="kdp", editionConfig=EBOOK, bookModel=book,
                      artifactsBase64={"book.epub": base64.b64encode(output.getvalue()).decode()}))
    assert caught.value.status_code == 422
    assert "Render again" in caught.value.detail


def test_saved_opf_plain_leaf_metadata_allows_whitespace_tail_without_rewriting_bytes():
    book = copy.deepcopy(VALID)
    book["metadata"]["publicationDate"] = "2024-02-29"
    blob, _ = render_epub(book, parse_edition(EBOOK))
    output = BytesIO()
    with zipfile.ZipFile(BytesIO(blob)) as source, zipfile.ZipFile(output, "w") as target:
        for info in source.infolist():
            data = source.read(info)
            if info.filename == "OEBPS/content.opf":
                for field in ("date", "language"):
                    closing = f"</dc:{field}>".encode()
                    data = data.replace(closing, closing + b" \n  ", 1)
            target.writestr(info, data)
    saved = output.getvalue()
    result = build_package(PackageRequest(channel="kdp", editionConfig=EBOOK, bookModel=book,
                          artifactsBase64={"book.epub": base64.b64encode(saved).decode()}))
    with zipfile.ZipFile(BytesIO(base64.b64decode(result["packages"][0]["dataBase64"]))) as package:
        assert package.read("book.epub") == saved


def test_package_endpoint_rejects_wrong_channel_format_and_untrusted_names():
    pdf = b"%PDF-1.4\nrendered"
    with pytest.raises(Exception, match="does not accept pdf"):
        build_package(PackageRequest(channel="apple", editionConfig={"kind": "print"},
                                     bookModel=VALID,
                                     artifactsBase64={"book.pdf": base64.b64encode(pdf).decode()}))
    blob, _ = render_epub(VALID, parse_edition(EBOOK))
    with pytest.raises(Exception, match="artifacts must contain"):
        build_package(PackageRequest(channel="kdp", editionConfig=EBOOK, bookModel=VALID,
                                     artifactsBase64={"../book.epub": base64.b64encode(blob).decode()}))


def test_internal_package_endpoint_checks_its_service_token(monkeypatch):
    monkeypatch.setenv("PUBLISHING_SERVICE_TOKEN", "publishing-secret")
    with pytest.raises(Exception, match="invalid service token"):
        require_service_token("wrong")
    require_service_token("publishing-secret")


@pytest.mark.parametrize("configured", [None, "", "   "])
def test_private_publishing_routes_fail_closed_without_configuration(monkeypatch, configured):
    from fastapi.testclient import TestClient
    monkeypatch.delenv("SERVICE_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("PUBLISHING_SERVICE_TOKEN", raising=False)
    if configured is not None:
        monkeypatch.setenv("PUBLISHING_SERVICE_TOKEN", configured)
    with TestClient(_PUBLISHING_MAIN.app) as client:
        for route in ("validate", "package", "jobs"):
            result = client.post(f"/v1/publishing/{route}", headers={"x-service-token": "guessed"}, json={})
            assert result.status_code == 503, result.text
            assert result.json() == {"detail": "Publishing service authentication is not configured."}
        assert client.get("/health").status_code == 200
        assert client.get("/v1/publishing/channels").status_code == 200


def test_publishing_token_fallback_and_dedicated_precedence(monkeypatch):
    from fastapi import HTTPException
    monkeypatch.delenv("PUBLISHING_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("SERVICE_AUTH_TOKEN", "shared-fixture")
    require_service_token("shared-fixture")
    monkeypatch.setenv("PUBLISHING_SERVICE_TOKEN", "dedicated-fixture")
    for token in (None, "", "wrong", "shared-fixture", "non-ascii-é"):
        with pytest.raises(HTTPException) as caught:
            require_service_token(token)
        assert caught.value.status_code == 401
    require_service_token("dedicated-fixture")


def test_retired_local_job_never_renders_reads_or_writes_a_job(monkeypatch):
    from fastapi.testclient import TestClient
    monkeypatch.setenv("PUBLISHING_SERVICE_TOKEN", "retirement-fixture")
    def forbidden(*args, **kwargs):
        pytest.fail("retired route attempted rendering or local-file work")
    monkeypatch.setattr(_PUBLISHING_MAIN, "render_epub", forbidden)
    monkeypatch.setattr(_PUBLISHING_MAIN, "build_package", forbidden)
    monkeypatch.setattr(Path, "read_text", forbidden)
    monkeypatch.setattr(Path, "write_text", forbidden)
    assert not hasattr(_PUBLISHING_MAIN, "_JOBS_DIR")
    with TestClient(_PUBLISHING_MAIN.app) as client:
        url = "/v1/publishing/jobs"
        assert client.post(url, json={}).status_code == 401
        for payload in ({}, {"idempotencyKey": "../../old", "bookModel": VALID},
                        {"idempotencyKey": "previously-succeeded"}):
            response = client.post(url, headers={"x-service-token": "retirement-fixture"}, json=payload)
            assert response.status_code == 410, response.text
            assert "durable publishing queue" in response.json()["detail"]
            assert "dataBase64" not in response.text


def test_print_package_contains_exact_full_cover_pdf_and_rejects_mismatched_geometry():
    from PIL import Image
    from pypdf import PdfWriter
    from wrap_cover import render_wrap_cover
    config = {"kind": "print", "cover": {"asset_id": "77777777-7777-4777-8777-777777777777"},
              "wrap_cover": {"enabled": True, "profile": "kdp-cream", "back_text": "Back cover copy"}}
    writer = PdfWriter()
    for _ in range(100):
        writer.add_blank_page(432, 648)
    output = BytesIO()
    writer.write(output)
    interior = output.getvalue()
    image = BytesIO()
    Image.new("RGB", (1800, 2700), "#204050").save(image, "PNG")
    cover, _ = render_wrap_cover(image.getvalue(), interior, parse_edition(config))
    artifacts = {"book.pdf": base64.b64encode(interior).decode(), "cover.pdf": base64.b64encode(cover).decode()}
    request = PackageRequest(channel="kdp", editionConfig=config, bookModel=VALID, artifactsBase64=artifacts)
    result = build_package(request)
    assert build_package(request) == result
    with zipfile.ZipFile(BytesIO(base64.b64decode(result["packages"][0]["dataBase64"]))) as archive:
        assert archive.read("book.pdf") == interior
        assert archive.read("cover.pdf") == cover
        assert set(json.loads(archive.read("manifest.json"))["files"]) == {"book.pdf", "cover.pdf", "metadata.json", "preflight.json", "README.txt"}
    config["wrap_cover"]["profile"] = "kdp-white"
    with pytest.raises(Exception, match="no longer pass"):
        build_package(PackageRequest(channel="kdp", editionConfig=config, bookModel=VALID, artifactsBase64=artifacts))
    with pytest.raises(Exception, match="no longer pass"):
        build_package(PackageRequest(channel="kdp", editionConfig=config, bookModel=VALID,
                                     artifactsBase64={"book.pdf": artifacts["book.pdf"]}))


def test_odd_book_renders_preflights_and_packages_without_manual_blank_page(monkeypatch):
    from fastapi.testclient import TestClient
    from PIL import Image
    from pypdf import PdfReader

    spec = importlib.util.spec_from_file_location("bookworm_odd_render", ROOT / "rendering" / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "odd-book-fixture")
    book = copy.deepcopy(VALID)
    book["chapters"] = []
    for index in range(24):
        chapter = copy.deepcopy(VALID["chapters"][0])
        chapter.update(id=f"chapter-{index}", order=index, title=f"Chapter {index + 1}")
        book["chapters"].append(chapter)
    config = {"kind": "print", "cover": {"asset_id": "77777777-7777-4777-8777-777777777777"},
              "wrap_cover": {"enabled": True, "profile": "kdp-cream"}}
    artwork = BytesIO()
    Image.new("RGB", (1800, 2700), "#204050").save(artwork, "PNG")
    payload = {"bookModel": book, "editionConfig": config,
               "coverBase64": base64.b64encode(artwork.getvalue()).decode()}
    with TestClient(module.app) as client:
        headers = {"x-service-token": "odd-book-fixture"}
        response = client.post("/render", headers=headers, json=payload)
        assert response.status_code == 200, response.text
        rendered = response.json()
        assert rendered["coverRendererVersion"] == "paperback-cover-1.1.0"
        interior = base64.b64decode(rendered["artifactBase64"])
        cover = base64.b64decode(rendered["coverArtifactBase64"])
        assert len(PdfReader(BytesIO(interior)).pages) == 25
        assert float(PdfReader(BytesIO(cover)).pages[0].mediabox.width) == pytest.approx((12.25 + 26 * 0.0025) * 72)
        response = client.post("/preflight", headers=headers, json={**payload, "channel": "kdp"})
        assert response.status_code == 200, response.text
        check = response.json()
        assert check["errors"] == 0, check
        rounding = next(f for f in check["findings"] if f["code"] == "KDP-PRINT-ROUNDED-COUNT")
        assert rounding["severity"] == "info"
        package = build_package(PackageRequest(channel="kdp", editionConfig=config, bookModel=book,
            artifactsBase64={"book.pdf": rendered["artifactBase64"], "cover.pdf": rendered["coverArtifactBase64"]}))
        with zipfile.ZipFile(BytesIO(base64.b64decode(package["packages"][0]["dataBase64"]))) as archive:
            assert archive.read("book.pdf") == interior
            assert archive.read("cover.pdf") == cover
