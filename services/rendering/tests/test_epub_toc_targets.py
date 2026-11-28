"""Offline, bounded TOC target checks; these do not replace EPUBCheck."""
import io
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from epub_toc_targets import _MAX_XML, inspect_toc_targets
from rules.core_v1 import check_toc_targets

XHTML = "http://www.w3.org/1999/xhtml"
OPS = "http://www.idpf.org/2007/ops"
OPF = "http://www.idpf.org/2007/opf"


def archive(hrefs, *, items=None, spine=None, files=None, nav_extra="", package_extra=""):
    items = items or '<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>'
    spine = spine or '<itemref idref="chapter"/>'
    files = files if files is not None else {"OEBPS/chapter.xhtml": f'<html xmlns="{XHTML}"><body><p id="one">Text</p></body></html>'}
    nav = f'<html xmlns="{XHTML}" xmlns:epub="{OPS}" {nav_extra}><head/><body><nav epub:type="toc"><ol>' + "".join(
        f'<li><a href="{href}">Section</a></li>' for href in hrefs) + '</ol></nav></body></html>'
    opf = f'<package xmlns="{OPF}" {package_extra}><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>{items}</manifest><spine>{spine}</spine></package>'
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", compression=zipfile.ZIP_DEFLATED) as out:
        out.writestr("OEBPS/nav.xhtml", nav)
        out.writestr("OEBPS/content.opf", opf)
        for path, contents in files.items():
            out.writestr(path, contents)
    return data.getvalue()


def codes(data):
    return [finding.code for finding in check_toc_targets({"artifact": data})]


def test_local_spine_and_unicode_fragment_resolve_without_network():
    items = '<item id="chapter" href="%E7%AB%A0.xhtml" media-type="application/xhtml+xml"/>'
    files = {"OEBPS/章.xhtml": f'<html xmlns="{XHTML}"><body><p id="一">Text</p></body></html>'}
    assert codes(archive(["%E7%AB%A0.xhtml#%E4%B8%80"], items=items, files=files)) == []
    assert codes(archive(["chapter.xhtml", "chapter.xhtml#one"])) == []


def test_parent_relative_path_within_container_is_supported():
    items = '<item id="chapter" href="../text/ch.xhtml" media-type="application/xhtml+xml"/>'
    files = {"text/ch.xhtml": f'<html xmlns="{XHTML}"><body id="page">Text</body></html>'}
    assert codes(archive(["../text/ch.xhtml#page"], items=items, files=files)) == []


@pytest.mark.parametrize("href,code", [
    ("missing.xhtml", "NAV_TARGET_MISSING"),
    ("chapter.xhtml#missing", "NAV_TARGET_FRAGMENT"),
    ("https://example.invalid/ch.xhtml", "NAV_TARGET_UNSUPPORTED"),
    ("//example.invalid/ch.xhtml", "NAV_TARGET_UNSUPPORTED"),
    ("javascript:alert(1)", "NAV_TARGET_URL"),
    ("../../outside.xhtml", "NAV_TARGET_URL"),
    ("%2e%2e/%2e%2e/outside.xhtml", "NAV_TARGET_URL"),
    ("bad%xx.xhtml", "NAV_TARGET_URL"),
    ("chapter%2fx.xhtml", "NAV_TARGET_UNSUPPORTED"),
    ("chapter.xhtml?x=1", "NAV_TARGET_UNSUPPORTED"),
    (" chapter.xhtml", "NAV_TARGET_UNSUPPORTED"),
    ("chapter.xhtml#epubcfi(/6/2)", "NAV_TARGET_UNSUPPORTED"),
])
def test_missing_unsafe_or_unsupported_toc_targets_are_reported(href, code):
    assert codes(archive([href])) == [code]


def test_manifest_item_not_in_spine_or_fallback_is_not_a_top_level_target():
    items = '<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="extra" href="extra.xhtml" media-type="application/xhtml+xml"/>'
    files = {"OEBPS/chapter.xhtml": f'<html xmlns="{XHTML}"/>', "OEBPS/extra.xhtml": f'<html xmlns="{XHTML}"/>'}
    assert codes(archive(["extra.xhtml"], items=items, files=files)) == ["NAV_TARGET_MISSING"]


def test_fragment_only_link_requires_navigation_document_to_be_in_spine():
    assert codes(archive(["#section"], nav_extra='id="section"')) == ["NAV_TARGET_MISSING"]
    assert codes(archive(["#section"], nav_extra='id="section"', spine='<itemref idref="nav"/>')) == []


def test_svg_spine_and_foreign_fallback_targets_are_supported():
    items = '<item id="foreign" href="page.jpg" media-type="image/jpeg" fallback="svg"/><item id="svg" href="page.svg" media-type="image/svg+xml"/>'
    files = {"OEBPS/page.jpg": b"synthetic", "OEBPS/page.svg": '<svg xmlns="http://www.w3.org/2000/svg"><g id="panel"/></svg>'}
    assert codes(archive(["page.jpg", "page.svg#panel"], items=items, spine='<itemref idref="foreign"/>', files=files)) == []
    assert codes(archive(["page.jpg#unsupported"], items=items, spine='<itemref idref="foreign"/>', files=files)) == ["NAV_TARGET_UNSUPPORTED"]


def test_missing_duplicate_and_xml_id_fragments_are_checked():
    good = {"OEBPS/chapter.xhtml": f'<html xmlns="{XHTML}"><body><p xml:id="one">Text</p></body></html>'}
    assert codes(archive(["chapter.xhtml#one"], files=good)) == []
    bad = {"OEBPS/chapter.xhtml": f'<html xmlns="{XHTML}"><body><p id="one"/><p id="one"/></body></html>'}
    assert codes(archive(["chapter.xhtml#one"], files=bad)) == ["NAV_TARGET_FRAGMENT"]


def test_whole_document_link_rejects_malformed_xhtml():
    files = {"OEBPS/chapter.xhtml": f'<html xmlns="{XHTML}"><body><p>Unclosed</body></html>'}
    assert codes(archive(["chapter.xhtml"], files=files)) == ["NAV_TARGET_XML"]


def test_alternate_url_base_and_entity_doctype_fail_closed_without_fetching():
    assert codes(archive(["chapter.xhtml"], nav_extra='xml:base="https://example.invalid/"')) == ["NAV_TARGET_UNSUPPORTED"]
    assert codes(archive(["chapter.xhtml"], package_extra='xml:base="sub/"')) == ["NAV_TARGET_UNSUPPORTED"]
    files = {"OEBPS/chapter.xhtml": '<!DOCTYPE html SYSTEM "https://example.invalid/not-fetched"><html xmlns="http://www.w3.org/1999/xhtml"/>'}
    assert codes(archive(["chapter.xhtml#one"], files=files)) == ["NAV_TARGET_UNSUPPORTED"]


def test_navigation_target_xml_size_is_bounded(monkeypatch):
    # Use an explicit small fixture limit; no multi-megabyte allocations required.
    import epub_toc_targets
    monkeypatch.setattr(epub_toc_targets, "_MAX_XML", 100)
    assert codes(archive(["chapter.xhtml#one"])) == ["NAV_TARGET_LIMIT"]
