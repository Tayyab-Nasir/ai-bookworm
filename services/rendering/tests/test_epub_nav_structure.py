"""Navigation preflight checks XML structure, not raw token fragments."""
import io
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nav_validation import MAX_NAV_BYTES, MAX_NAV_DEPTH
from rules.core_v1 import check_nav

XHTML = "http://www.w3.org/1999/xhtml"
OPS = "http://www.idpf.org/2007/ops"


def finding(nav: bytes):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("OEBPS/nav.xhtml", nav)
    return [item.code for item in check_nav({"artifact": output.getvalue()})]


def document(body: str):
    return f'<html xmlns="{XHTML}" xmlns:e="{OPS}"><body>{body}</body></html>'.encode()


def test_navigation_accepts_namespace_alias_whitespace_and_single_quotes():
    assert finding(document("<nav e:type='landmarks toc'><h1>Contents</h1><ol><li><a href='ch.xhtml'>Chapter</a></li></ol></nav>")) == []
    assert finding(document("<nav e:type='toc'><ol><li><span>Part one</span><ol><li><a href='ch.xhtml'><img alt='Chapter one'/></a></li></ol></li></ol></nav>")) == []
    assert finding(document("<nav e:type='toc'><ol><li><a href='ch.xhtml' title='Chapter one'><img src='x.png'/></a></li></ol></nav>")) == []


@pytest.mark.parametrize("body", [
    '<!-- epub:type="toc" -->',
    '<div e:type="toc"><ol><li>Not a nav</li></ol></div>',
    '<nav e:type="toc"><ol/></nav>',
    '<nav e:type="toc"><ol><li>Missing link</li></ol></nav>',
    '<nav e:type="toc"><ol><li><span>Leaf heading</span></li></ol></nav>',
    '<nav e:type="toc"><ol><li><a href="ch.xhtml"> </a></li></ol></nav>',
    '<nav e:type="toc"><ol><li><a href="ch.xhtml" title="Not visible"></a></li></ol></nav>',
    '<nav e:type="toc"><ol><li><a href="ch.xhtml"><em title="Not visible"/></a></li></ol></nav>',
    '<nav e:type="toc"><ol><li><a>Missing href</a></li></ol></nav>',
    '<nav e:type="toc"><ol><div>Not a list item</div><li><a href="ch.xhtml">Chapter</a></li></ol></nav>',
    '<nav e:type="toc"><div><ol><li>Nested incorrectly</li></ol></div></nav>',
    '<nav e:type="toc"><ol><li>One</li></ol></nav><nav e:type="toc"><ol><li>Two</li></ol></nav>',
])
def test_navigation_rejects_false_or_invalid_table_of_contents(body):
    assert finding(document(body)) == ["NO_TOC"]


@pytest.mark.parametrize("data", [
    b'<html><body><nav epub:type="toc"',
    b'<!DOCTYPE html [<!ENTITY leak SYSTEM "file:///not-read">]><html xmlns="http://www.w3.org/1999/xhtml"><body>&leak;</body></html>',
    b'<!DOCTYPE html SYSTEM "https://example.invalid/not-fetched"><html xmlns="http://www.w3.org/1999/xhtml"/>',
    b'<html xmlns="urn:not-xhtml"><body/></html>',
])
def test_navigation_rejects_malformed_xml_and_external_or_internal_dtd(data):
    assert finding(data) == ["NAV_XML"]


def test_navigation_fails_closed_at_size_and_nesting_limits():
    assert finding(b"x" * (MAX_NAV_BYTES + 1)) == ["NAV_LIMIT"]
    nested = document("<div>" * MAX_NAV_DEPTH + "</div>" * MAX_NAV_DEPTH)
    assert finding(nested) == ["NAV_LIMIT"]
