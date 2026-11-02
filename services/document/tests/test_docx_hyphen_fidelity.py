"""Word explicit hyphen controls retain their semantic Unicode characters."""
import io
import sys
from pathlib import Path

import pytest
from docx import Document
from docx.enum.text import WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "rendering"))
from parsers import ParseError
from parsers.docx_parser import parse_docx
from parsers.epub_parser import parse_epub
from editions import EbookEdition, PrintEdition
from epub_renderer import render_epub
from print_fonts import print_font_issues
from pdf_renderer import render_pdf
from pypdf import PdfReader


def source_document():
    doc = Document()
    paragraph = doc.add_paragraph()
    run = paragraph.add_run("alpha")
    run.bold = True
    run._r.append(OxmlElement("w:noBreakHyphen"))
    run.add_text("beta")
    run._r.append(OxmlElement("w:softHyphen"))
    run.add_text("gamma")
    paragraph.add_run(" ending").italic = True
    data = io.BytesIO()
    doc.save(data)
    return data.getvalue()


def test_word_hyphens_preserve_order_and_run_marks():
    book, report = parse_docx(source_document())
    node = book["chapters"][0]["nodes"][0]
    assert node["text"] == "alpha\u2011beta\u00adgamma ending"
    assert node["attributes"]["richText"] == [
        {"type": "text", "text": "alpha\u2011beta\u00adgamma", "marks": [{"type": "bold"}]},
        {"type": "text", "text": " ending", "marks": [{"type": "italic"}]},
    ]
    assert any("nonbreaking hyphens" in warning and "print" in warning for warning in report["warnings"])


def test_word_hyphen_semantics_survive_epub_export_and_import():
    book, _ = parse_docx(source_document())
    epub, _ = render_epub(book, EbookEdition())
    restored, _ = parse_epub(epub)
    assert restored["chapters"][0]["nodes"][0]["text"] == "alpha\u2011beta\u00adgamma ending"


def test_print_validation_refuses_current_font_without_nonbreaking_hyphen():
    book, _ = parse_docx(source_document())
    issues = print_font_issues(book, PrintEdition().model_dump())
    assert any("U+2011" in issue["message"] for issue in issues)


def test_optional_word_hyphen_is_printable_and_does_not_insert_visible_punctuation():
    doc = Document()
    run = doc.add_paragraph().add_run("un")
    run._r.append(OxmlElement("w:softHyphen"))
    run.add_text("broken text")
    data = io.BytesIO()
    doc.save(data)
    book, _ = parse_docx(data.getvalue())
    assert book["chapters"][0]["nodes"][0]["text"] == "un\u00adbroken text"
    assert not print_font_issues(book, PrintEdition().model_dump())
    pdf, _ = render_pdf(book, PrintEdition())
    text = "\n".join(page.extract_text() for page in PdfReader(io.BytesIO(pdf)).pages)
    assert "unbroken text" in text


def add_word_hyphens(paragraph):
    run = paragraph.add_run("alpha")
    run._r.append(OxmlElement("w:noBreakHyphen"))
    run.add_text("beta")
    run._r.append(OxmlElement("w:softHyphen"))
    run.add_text("gamma")


def test_hyphens_in_chapter_title_and_table_survive_epub_with_merged_cells():
    doc = Document()
    heading = doc.add_heading(level=1)
    add_word_hyphens(heading)
    table = doc.add_table(rows=2, cols=2)
    cell = table.cell(0, 0).merge(table.cell(0, 1))
    add_word_hyphens(cell.paragraphs[0])
    cell.add_paragraph("second paragraph")
    table.cell(1, 0).text = "left"
    table.cell(1, 1).text = "right"
    raw = io.BytesIO()
    doc.save(raw)
    book, report = parse_docx(raw.getvalue())
    expected = "alpha\u2011beta\u00adgamma"
    chapter = book["chapters"][0]
    assert chapter["title"] == expected
    assert chapter["nodes"][0]["text"] == expected
    table_node = chapter["nodes"][1]
    assert table_node["rows"] == [[expected + "\nsecond paragraph", ""], ["left", "right"]]
    assert sum("nonbreaking hyphens" in item for item in report["warnings"]) == 1
    epub, _ = render_epub(book, EbookEdition())
    restored, _ = parse_epub(epub)
    assert restored["chapters"][0]["nodes"][0]["text"] == expected
    assert restored["chapters"][0]["nodes"][1]["rows"] == table_node["rows"]


def test_hyphens_only_in_table_produce_diagnostic_without_duplicate_merged_text():
    doc = Document()
    table = doc.add_table(rows=1, cols=2)
    cell = table.cell(0, 0).merge(table.cell(0, 1))
    add_word_hyphens(cell.paragraphs[0])
    raw = io.BytesIO()
    doc.save(raw)
    book, report = parse_docx(raw.getvalue())
    assert book["chapters"][0]["nodes"][0]["rows"] == [["alpha\u2011beta\u00adgamma", ""]]
    assert sum("nonbreaking hyphens" in item for item in report["warnings"]) == 1


def test_table_preserves_hyperlink_labels_tabs_and_nested_table_text_in_order():
    doc = Document()
    cell = doc.add_table(rows=1, cols=1).cell(0, 0)
    paragraph = cell.paragraphs[0]
    paragraph.add_run("Before\t")
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), doc.part.relate_to("https://example.invalid/private-target", RT.HYPERLINK, is_external=True))
    run = OxmlElement("w:r")
    text = OxmlElement("w:t")
    text.text = "linked"
    run.append(text)
    hyperlink.append(run)
    paragraph._p.append(hyperlink)
    paragraph.add_run(" after")
    nested = cell.add_table(rows=1, cols=1)
    nested.cell(0, 0).text = "Nested text retained"
    cell.paragraphs[-1].add_run("After nested table")
    raw = io.BytesIO()
    doc.save(raw)
    book, report = parse_docx(raw.getvalue())
    rows = book["chapters"][0]["nodes"][0]["rows"]
    assert rows == [["Before\tlinked after\nNested text retained\nAfter nested table"]]
    assert "example.invalid" not in str(rows)
    assert any("nested tables were flattened" in warning for warning in report["warnings"])


def test_nested_tables_preserve_all_levels_and_do_not_duplicate_merged_cells():
    doc = Document()
    outer = doc.add_table(rows=1, cols=1).cell(0, 0)
    outer.paragraphs[0].text = "Before"
    nested = outer.add_table(rows=2, cols=2)
    nested.cell(0, 0).text = "Merged heading"
    nested.cell(0, 0).merge(nested.cell(0, 1))
    nested.cell(1, 0).text = "Left"
    nested.cell(1, 1).text = "Right"
    deeper = nested.cell(1, 1).add_table(rows=1, cols=1)
    deeper.cell(0, 0).text = "Deeper content"
    outer.paragraphs[-1].text = "After"
    raw = io.BytesIO()
    doc.save(raw)
    book, report = parse_docx(raw.getvalue())
    text = book["chapters"][0]["nodes"][0]["rows"][0][0]
    assert text.count("Merged heading") == 1
    assert text.index("Before") < text.index("Merged heading") < text.index("Left") < text.index("Right") < text.index("Deeper content") < text.index("After")
    assert sum("nested tables were flattened" in warning for warning in report["warnings"]) == 1
    epub, _ = render_epub(book, EbookEdition())
    reimported, _ = parse_epub(epub)
    epub_text = reimported["chapters"][0]["nodes"][0]["rows"][0][0]
    pdf, _ = render_pdf(book, PrintEdition())
    pdf_text = "\n".join(page.extract_text() for page in PdfReader(io.BytesIO(pdf)).pages)
    for phrase in ("Before", "Merged heading", "Left", "Right", "Deeper content", "After"):
        assert phrase in epub_text
        assert phrase in pdf_text


def test_extreme_nested_table_depth_fails_instead_of_truncating_text():
    doc = Document()
    cell = doc.add_table(rows=1, cols=1).cell(0, 0)
    for _ in range(17):
        cell = cell.add_table(rows=1, cols=1).cell(0, 0)
    cell.text = "Deep content"
    raw = io.BytesIO()
    doc.save(raw)
    with pytest.raises(ParseError, match="nested tables exceed the supported depth"):
        parse_docx(raw.getvalue())


def test_images_inside_nested_tables_are_reported_without_inventing_text():
    image = io.BytesIO()
    Image.new("RGB", (2, 2), "red").save(image, format="PNG")
    image.seek(0)
    doc = Document()
    cell = doc.add_table(rows=1, cols=1).cell(0, 0)
    nested = cell.add_table(rows=1, cols=1).cell(0, 0)
    nested.paragraphs[0].add_run("Before")
    nested.paragraphs[0].add_run().add_picture(image)
    nested.paragraphs[0].add_run("After")
    raw = io.BytesIO()
    doc.save(raw)
    book, report = parse_docx(raw.getvalue())
    assert "BeforeAfter" in book["chapters"][0]["nodes"][0]["rows"][0][0]
    assert any("images inside tables are not imported" in warning for warning in report["warnings"])


def test_table_line_column_and_page_breaks_remain_ordered_and_warn():
    doc = Document()
    cell = doc.add_table(rows=1, cols=1).cell(0, 0)
    run = cell.paragraphs[0].add_run("first")
    run.add_break(WD_BREAK.LINE)
    run.add_text("second")
    run.add_break(WD_BREAK.COLUMN)
    run.add_text("third")
    run.add_break(WD_BREAK.PAGE)
    run.add_text("fourth")
    raw = io.BytesIO()
    doc.save(raw)
    book, report = parse_docx(raw.getvalue())
    assert book["chapters"][0]["nodes"][0]["rows"] == [["first\nsecond\nthirdfourth"]]
    assert any("column breaks" in warning for warning in report["warnings"])
    assert any("page breaks inside table cells" in warning for warning in report["warnings"])
