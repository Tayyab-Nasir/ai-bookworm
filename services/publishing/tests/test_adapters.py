"""Adapter tests: channel rules wired, export package deterministic, submit not supported."""
import json
import base64
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
    for ch in ("kdp", "apple", "barnesnoble", "lulu"):
        assert get_adapter(ch).channel() == ch
    with pytest.raises(KeyError):
        get_adapter("smashwords")


def test_kdp_validate_uses_kdp_rules():
    result = get_adapter("kdp").validate(_ctx())
    assert result["ruleVersion"] == "core-1.0.5+kdp-1.3.0"
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


def test_package_endpoint_uses_the_exact_saved_artifact_deterministically():
    blob, _ = render_epub(VALID, parse_edition(EBOOK))
    request = PackageRequest(channel="kdp", editionConfig=EBOOK, bookModel=VALID,
                             artifactsBase64={"book.epub": base64.b64encode(blob).decode()})
    first = build_package(request)
    second = build_package(request)
    assert first["ruleVersion"] == "core-1.0.5+kdp-1.3.0"
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
        assert set(json.loads(archive.read("manifest.json"))["files"]) == {"book.pdf", "cover.pdf"}
    config["wrap_cover"]["profile"] = "kdp-white"
    with pytest.raises(Exception, match="no longer pass"):
        build_package(PackageRequest(channel="kdp", editionConfig=config, bookModel=VALID, artifactsBase64=artifacts))
    with pytest.raises(Exception, match="no longer pass"):
        build_package(PackageRequest(channel="kdp", editionConfig=config, bookModel=VALID,
                                     artifactsBase64={"book.pdf": artifacts["book.pdf"]}))
