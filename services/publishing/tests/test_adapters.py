"""Adapter tests: channel rules wired, export package deterministic, submit not supported."""
import json
import base64
import copy
import importlib.util
import sys
import zipfile
from io import BytesIO
from pathlib import Path

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


@pytest.mark.parametrize("name", ["manifest.json", "metadata.json", "README.txt"])
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
        assert set(json.loads(archive.read("manifest.json"))["files"]) == {"book.pdf", "cover.pdf", "metadata.json", "README.txt"}
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
