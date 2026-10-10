"""Saved publication dates are listing metadata, never publish scheduling."""
import copy
import json
import sys
import zipfile
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from editions import parse_edition
from epub_renderer import render_epub

BOOK = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/books/valid_book.json").read_text())
NS = {"o": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}


def _date(blob):
    with zipfile.ZipFile(BytesIO(blob)) as archive:
        opf = ET.fromstring(archive.read("OEBPS/content.opf"))
        return opf.find("o:metadata/dc:date", NS)


@pytest.mark.parametrize("flow", ["reflowable", "fixed"])
def test_saved_date_is_in_actual_epub_metadata_and_changes_only_its_snapshot(flow):
    book = copy.deepcopy(BOOK)
    book["metadata"]["publicationDate"] = "2024-02-29"
    edition = parse_edition({"kind": "ebook", "flow": flow})
    blob, checksum = render_epub(book, edition)
    assert _date(blob).text == "2024-02-29"
    assert render_epub(book, edition) == (blob, checksum)
    book["metadata"]["publicationDate"] = "2026-11-01"
    changed, changed_checksum = render_epub(book, edition)
    assert _date(changed).text == "2026-11-01"
    assert changed_checksum != checksum


@pytest.mark.parametrize("flow", ["reflowable", "fixed"])
def test_absent_or_null_date_preserves_legacy_epub_bytes_without_inventing_a_date(flow):
    book = copy.deepcopy(BOOK)
    edition = parse_edition({"kind": "ebook", "flow": flow})
    legacy = render_epub(book, edition)
    assert _date(legacy[0]) is None
    book["metadata"]["publicationDate"] = None
    assert render_epub(book, edition) == legacy


@pytest.mark.parametrize("value", ["2026-02-30", "1900-02-29", "2026-1-01", "0000-01-01", "2026-01-01T00:00:00Z", "", 20260101])
@pytest.mark.parametrize("flow", ["reflowable", "fixed"])
def test_invalid_dates_fail_before_an_epub_is_returned(value, flow, monkeypatch):
    import fixed_epub
    def forbidden_rasterization(*_args, **_kwargs):
        raise AssertionError("An invalid publication date must fail before native fixed-layout rendering.")
    monkeypatch.setattr(fixed_epub, "render_fixed_epub", forbidden_rasterization)
    book = copy.deepcopy(BOOK)
    book["metadata"]["publicationDate"] = value
    with pytest.raises(ValueError, match="publicationDate"):
        render_epub(book, parse_edition({"kind": "ebook", "flow": flow}))


@pytest.mark.parametrize("value", ["0001-01-01", "2000-02-29", "9999-12-31", None])
def test_shared_date_validation_preserves_exact_calendar_value(value):
    from publication_metadata import publication_date
    assert publication_date(value) == value


@pytest.mark.parametrize("value", ["２０２６-０１-０１", "2026-01-01 ", "2026-13-01", "2026-00-01", {}, True])
def test_shared_date_validation_does_not_coerce_or_normalize_invalid_values(value):
    from publication_metadata import publication_date
    with pytest.raises(ValueError, match="publicationDate"):
        publication_date(value)


def test_effective_metadata_helper_preserves_precedence_and_internal_null_clearing():
    from publication_metadata import effective_publication_metadata
    base = {"title": "Saved title", "publicationDate": "2024-02-29"}
    override = {"title": "Edition title", "publicationDate": "2026-11-01"}
    assert effective_publication_metadata(base, override) == override
    # Internal helper semantics only: supported edition transports remain string-only.
    assert effective_publication_metadata(base, {"publicationDate": None}) == {"title": "Saved title"}
    assert effective_publication_metadata({"title": "Saved title", "publicationDate": None}) == {"title": "Saved title"}
    assert base == {"title": "Saved title", "publicationDate": "2024-02-29"}
    assert override == {"title": "Edition title", "publicationDate": "2026-11-01"}


def test_effective_publication_metadata_preflight_checks_the_actual_override():
    from preflight import _meta, run_preflight
    from rules import load_ruleset
    book = copy.deepcopy(BOOK)
    edition = {"kind": "ebook", "metadata_overrides": {"title": "", "author": "", "publicationDate": "2026-11-01"}}
    ctx = {"book": book, "edition": edition, "artifact": None, "image_bytes": {}}
    assert _meta(ctx)["publicationDate"] == "2026-11-01"
    codes = {finding.code for finding in run_preflight(ctx, load_ruleset("kdp"))}
    assert {"NO_TITLE", "NO_AUTHOR"}.issubset(codes)
    assert book == BOOK, "preflight must not replace saved metadata"
