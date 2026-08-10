"""Renderer + preflight tests: determinism, EPUB structure, broken fixture findings."""
import io
import json
import sys
import zipfile
from pathlib import Path

import pytest

RENDERING = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RENDERING))

from editions import EbookEdition, PrintEdition, parse_edition  # noqa: E402
from epub_renderer import render_epub  # noqa: E402
from pdf_renderer import render_pdf  # noqa: E402
from preflight import run_preflight  # noqa: E402
from rules import load_ruleset  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "books"
VALID = json.loads((FIXTURES / "valid_book.json").read_text())
BROKEN = json.loads((FIXTURES / "broken_book.json").read_text())

EBOOK = {"kind": "ebook"}
PRINT = {"kind": "print", "trim_size": "6x9"}


def _ctx(book, edition_cfg, artifact=None):
    return {"book": book, "edition": edition_cfg, "artifact": artifact,
            "channel": None, "image_bytes": {}}


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


# ---- PDF determinism -------------------------------------------------------------

def test_pdf_deterministic_sha256():
    ed = parse_edition(PRINT)
    b1, sha1 = render_pdf(VALID, ed)
    b2, sha2 = render_pdf(VALID, ed)
    assert sha1 == sha2
    assert b1.startswith(b"%PDF-")
    assert b"D:20000101000000" in b1  # reportlab invariant pins creation/mod date


# ---- preflight ----------------------------------------------------------------

def test_valid_book_passes_core():
    ed = parse_edition(EBOOK)
    blob, _ = render_epub(VALID, ed)
    findings = run_preflight(_ctx(VALID, EBOOK, blob), load_ruleset())
    errors = [f for f in findings if f.severity == "error"]
    assert errors == []
    assert all(f.rule_version == "core-1.0.0" for f in findings) or not findings


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
        assert f.rule_version == "core-1.0.0"
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


def test_kdp_ruleset_layers_channel_rules():
    ruleset = load_ruleset("kdp")
    assert ruleset.version == "core-1.0.0+kdp-1.0.0"
    assert any(r.id.startswith("KDP-") for r in ruleset.rules)
    with pytest.raises(KeyError):
        load_ruleset("nook-2009")
