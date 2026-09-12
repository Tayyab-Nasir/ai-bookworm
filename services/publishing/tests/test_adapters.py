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
    assert result["ruleVersion"] == "core-1.0.2+kdp-1.1.0"
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
    assert first["ruleVersion"] == "core-1.0.2+kdp-1.1.0"
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
