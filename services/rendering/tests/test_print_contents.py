"""Actual PDF contents labels and destinations across pagination changes."""
import io
import re
import sys
from pathlib import Path

import pytest
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from editions import PrintEdition
from pdf_renderer import render_pdf, _roman


def book(count=4):
    return {"metadata": {"title": "Harbor Letters", "author": "Ada Finch", "language": "en"},
            "chapters": [{"id": f"chapter-{i}", "order": i, "title": f"Letter {i + 1} & its journey",
                          "nodes": [{"id": f"p-{i}", "type": "paragraph", "text": "A letter arrived safely. " * 100}]}
                         for i in range(count)], "assets": []}


@pytest.mark.parametrize("style", ["arabic", "roman", "none"])
@pytest.mark.parametrize("count", [4, 65])
def test_contents_links_match_actual_chapter_pages(style, count):
    model = book(count)
    edition = PrintEdition(include_table_of_contents=True,
        page_numbering={"style": style, "start_at": 17},
        typography={"body_font": "BookwormVera", "heading_font": "BookwormVera-Bold"},
        front_matter={"copyright_notice": "Permission required."})
    blob, checksum = render_pdf(model, edition)
    assert render_pdf(model, edition)[1] == checksum
    pdf = PdfReader(io.BytesIO(blob))
    assert len(pdf.outline) == count
    first_chapter = pdf.get_destination_page_number(pdf.outline[0])
    assert first_chapter >= 3  # title, copyright, at least one contents page
    contents_pages = pdf.pages[2:first_chapter]
    if count == 65:
        assert len(contents_pages) > 1
    contents = "\n".join(page.extract_text() for page in contents_pages)
    assert "Placeholder" not in contents
    assert "Contents" in contents
    for index, destination in enumerate(pdf.outline):
        actual = pdf.get_destination_page_number(destination)
        title = model["chapters"][index]["title"]
        assert title in pdf.pages[actual].extract_text()
        assert title in contents
        displayed = actual + 17
        if style != "none":
            label = _roman(displayed) if style == "roman" else str(displayed)
            assert re.search(rf"(?<!\w){re.escape(label)}\s*\n{re.escape(title)}", contents)
    assert all(page.get("/Annots") for page in contents_pages)
    assert "Contents" not in pdf.pages[0].extract_text()


def test_contents_repaginate_when_typography_changes_and_remain_optional():
    model = book(3)
    compact = PdfReader(io.BytesIO(render_pdf(model, PrintEdition(include_table_of_contents=True))[0]))
    larger = PdfReader(io.BytesIO(render_pdf(model, PrintEdition(include_table_of_contents=True,
        typography={"body_size_pt": 20, "leading": 26}))[0]))
    assert larger.get_destination_page_number(larger.outline[-1]) > compact.get_destination_page_number(compact.outline[-1])
    legacy = PdfReader(io.BytesIO(render_pdf(model, PrintEdition())[0]))
    assert not legacy.outline
    assert "Contents" not in "\n".join(page.extract_text() for page in legacy.pages)


def test_wrapped_titles_link_once_and_contents_font_is_checked():
    model = book(2)
    model["chapters"][0]["title"] = "A long chapter title about the harbor and its letters " * 3
    result = render_pdf(model, PrintEdition(include_table_of_contents=True, trim_size="5x8"))[0]
    pdf = PdfReader(io.BytesIO(result))
    assert len(pdf.outline) == 2
    assert pdf.get_destination_page_number(pdf.outline[0]) >= 2
    from print_fonts import print_font_issues
    model["chapters"][0]["title"] = "A Greek Ω"
    config = {"kind": "print", "typography": {"heading_font": "BookwormVera", "body_font": "Times-Roman"}}
    assert not any("contents" in issue["location"] for issue in print_font_issues(model, config))
    config["include_table_of_contents"] = True
    assert any("contents" in issue["location"] for issue in print_font_issues(model, config))


def test_large_roman_labels_and_long_titles_render_without_narrow_title_columns():
    model = book(3)
    title = "An unexpectedly long chapter title about boats and the keeper who waited " * 3
    model["chapters"][1]["title"] = title
    edition = PrintEdition(include_table_of_contents=True, trim_size="5x8",
        page_numbering={"style": "roman", "start_at": 9999},
        typography={"body_font": "BookwormVera", "heading_font": "BookwormVera-Bold",
                    "body_size_pt": 20, "heading_size_pt": 24, "leading": 26})
    data, checksum = render_pdf(model, edition)
    assert render_pdf(model, edition)[1] == checksum
    pdf = PdfReader(io.BytesIO(data))
    assert len(pdf.outline) == 3
    first_chapter = pdf.get_destination_page_number(pdf.outline[0])
    contents = " ".join(page.extract_text() for page in pdf.pages[1:first_chapter])
    assert " ".join(title.split()) in " ".join(contents.split())
    for item in pdf.outline:
        assert _roman(pdf.get_destination_page_number(item) + 9999) in contents
