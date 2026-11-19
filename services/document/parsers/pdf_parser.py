"""PDF manuscript extraction, with local OCR for pages without a text layer."""
import io
import re
import unicodedata
from time import monotonic

from pypdf import PdfReader, apply_configuration

from . import ParseError, check_size, make_book, make_report, new_chapter, node
from .pdf_ocr import OCR_SECONDS, recover_pdf_scan

_MIN_CHARS_PER_PAGE = 20
# Per-stream limits supplement, but do not replace, process resource controls.
_PDF_DECODE_LIMIT = 16_000_000
_PDF_DECODE_WORK_LIMIT = 64_000_000
_OCR_ISSUES = {
    "unsupported_language": "Scan recognition is unavailable for this manuscript language.",
    "limit": "This scan exceeds Bookworm's OCR limits. Use a searchable copy or split it into smaller sections.",
    "unavailable": "Scan recognition is unavailable on this document worker.",
    "busy": "Scan recognition is busy. Retry the import to recover the scanned pages.",
    "incomplete": "Scan recognition could not finish within its processing limits. Review the original or use a searchable copy.",
}


def _looks_garbled(char: str) -> bool:
    # Supplementary Unicode (including emoji and historic scripts) is valid
    # text. Count replacement characters and unexpected controls instead.
    return char == "\ufffd" or (char not in "\t\n\r" and unicodedata.category(char) in {"Cc", "Cs"})


def _page_list(pages: list[int]) -> str:
    listed = ", ".join(str(number) for number in pages[:20])
    return f"{listed}, and {len(pages) - 20} more" if len(pages) > 20 else listed


def parse_pdf(data: bytes, title: str = "Untitled", *, language: str = "en") -> tuple[dict, dict]:
    check_size(data)
    deadline = monotonic() + OCR_SECONDS
    try:
        with apply_configuration(
            zlib_maximum_output_length=_PDF_DECODE_LIMIT,
            stream_decoding_work_maximum_length=_PDF_DECODE_WORK_LIMIT,
        ):
            reader = PdfReader(io.BytesIO(data))
            n_pages = len(reader.pages)
            if n_pages == 0:
                raise ParseError("PDF has no pages")
            pages = [(reader.pages[i].extract_text() or "") for i in range(n_pages)]
    except ParseError:
        raise
    except Exception as e:
        raise ParseError(f"not a readable PDF: {e}") from e

    warnings: list[str] = [
        "PDF import extracts text only; images, graphics, annotations and original layout are not imported. "
        "Compare every page with the original and add missing artwork separately."
    ]
    empty_pages = [number for number, text in enumerate(pages, 1) if not text.strip()]
    recovered, issue = recover_pdf_scan(data, empty_pages, language, deadline) if empty_pages else ({}, None)
    if issue and len(empty_pages) == n_pages:
        # A processing interruption must not save the start of a scan as a full book.
        recovered = {}
    for number, text in recovered.items():
        pages[number - 1] = text
    if recovered:
        warnings.append(f"OCR recovered text from PDF pages: {_page_list(sorted(recovered))}. Compare these pages with the original before editing.")
    if issue:
        warnings.append(_OCR_ISSUES[issue])
    total_chars = sum(len(p) for p in pages)
    sparse_pages = [i + 1 for i, page in enumerate(pages)
                    if sum(not char.isspace() for char in page) < _MIN_CHARS_PER_PAGE]
    garbled_count = sum(_looks_garbled(char) for page in pages for char in page)
    garbled_ratio = garbled_count / total_chars if total_chars else 1.0
    if sparse_pages:
        warnings.append(f"PDF pages with sparse or blank extracted text: {_page_list(sparse_pages)}. "
                        "Review these pages against the original. Some may be intentionally blank.")
    if garbled_ratio > 0.02:
        warnings.append(
            f"PDF text extraction garbled ({garbled_ratio:.0%} non-text chars) — manual QA required")
    confidence = "low" if (recovered or sparse_pages or garbled_ratio > 0.02) else "medium"
    if confidence != "medium":
        warnings.append("import confidence is LOW: review the whole document before editing")
    else:
        warnings.append("PDF import is best-effort (no layout fidelity) — spot-check before editing")

    # single chapter; pages separated by pageBreak nodes, paragraphs from blank lines
    chapter = new_chapter(title, 0)
    for i, page in enumerate(pages):
        for para in re.split(r"\n\s*\n", page):
            t = " ".join(l.strip() for l in para.splitlines()).strip()
            if t:
                chapter["nodes"].append(node("paragraph", t))
        if i < n_pages - 1:
            chapter["nodes"].append(node("pageBreak"))
    if not any(n["type"] == "paragraph" for n in chapter["nodes"]):
        warnings.append("No readable text was recovered from the PDF.")

    book = make_book([chapter], title=title, language=language)
    report = make_report([chapter], warnings, confidence=confidence)
    report["pageCount"] = n_pages
    if issue:
        report["ocrIssue"] = issue
    return book, report
