"""PDF importer (P1): pypdf text extraction with confidence warnings.
Sparse/garbled extraction -> confidence "low" + manual-QA warning. Spec section 13."""
import io
import re
import unicodedata

from pypdf import PdfReader

from . import ParseError, check_size, make_book, make_report, new_chapter, node

_MIN_CHARS_PER_PAGE = 20


def _looks_garbled(char: str) -> bool:
    # Supplementary Unicode (including emoji and historic scripts) is valid
    # text. Count replacement characters and unexpected controls instead.
    return char == "\ufffd" or (char not in "\t\n\r" and unicodedata.category(char) in {"Cc", "Cs"})


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
    sparse_pages = [i + 1 for i, page in enumerate(pages)
                    if sum(not char.isspace() for char in page) < _MIN_CHARS_PER_PAGE]
    garbled_count = sum(_looks_garbled(char) for page in pages for char in page)
    garbled_ratio = garbled_count / total_chars if total_chars else 1.0
    if sparse_pages:
        sample = ", ".join(str(number) for number in sparse_pages[:20])
        remaining = len(sparse_pages) - 20
        suffix = f", and {remaining} more" if remaining > 0 else ""
        warnings.append(f"PDF pages with sparse or blank extracted text: {sample}{suffix}. "
                        "Pages may be scanned or intentionally blank; manual QA required. OCR was not performed.")
    if garbled_ratio > 0.02:
        warnings.append(
            f"PDF text extraction garbled ({garbled_ratio:.0%} non-text chars) — manual QA required")
    confidence = "low" if (sparse_pages or garbled_ratio > 0.02) else "medium"
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
