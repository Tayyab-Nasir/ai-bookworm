"""PDF importer (P1): pypdf text extraction with confidence warnings.
Sparse/garbled extraction -> confidence "low" + manual-QA warning. Spec section 13."""
import io
import re

from pypdf import PdfReader

from . import ParseError, check_size, make_book, make_report, new_chapter, node

_MIN_CHARS_PER_PAGE = 20
_GARBLED_RE = re.compile(r"[�]|[^\x09\x0a\x0d\x20-\x7e -￿]")


def parse_pdf(data: bytes, title: str = "Untitled") -> tuple[dict, dict]:
    check_size(data)
    try:
        reader = PdfReader(io.BytesIO(data))
        n_pages = len(reader.pages)
        if n_pages == 0:
            raise ParseError("PDF has no pages")
        pages = [(reader.pages[i].extract_text() or "") for i in range(n_pages)]
    except ParseError:
        raise
    except Exception as e:
        raise ParseError(f"not a readable PDF: {e}") from e

    warnings: list[str] = []
    total_chars = sum(len(p) for p in pages)
    sparse = total_chars < _MIN_CHARS_PER_PAGE * n_pages
    garbled_ratio = (len(_GARBLED_RE.findall("".join(pages))) / total_chars) if total_chars else 1.0
    if sparse:
        warnings.append(
            "PDF text extraction sparse (likely scanned image pages) — manual QA required")
    if garbled_ratio > 0.02:
        warnings.append(
            f"PDF text extraction garbled ({garbled_ratio:.0%} non-text chars) — manual QA required")
    confidence = "low" if (sparse or garbled_ratio > 0.02) else "medium"
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
        warnings.append("no extractable text at all — OCR/manual transcription needed")

    book = make_book([chapter], title=title)
    report = make_report([chapter], warnings, confidence=confidence)
    report["pageCount"] = n_pages
    return book, report
