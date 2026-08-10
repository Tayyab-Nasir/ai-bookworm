"""Print edition -> PDF via reportlab. Deterministic: fixed creation date via invariant canvas,
builtin fonts only (no system font files), fixed flowable ordering. Same input -> same sha256.
"""
import hashlib
from io import BytesIO

from reportlab.lib.pagesizes import inch
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
)

from editions import PrintEdition

RENDERER_VERSION = "pdf-1.0.0"
# reportlab invariant=1 pins CreationDate/ModDate to D:20000101000000 — reproducible bytes


class _DeterministicCanvasMaker:
    """reportlab Canvas subclass pinning CreationDate/ModDate/Producer for reproducibility."""

    @staticmethod
    def make(*args, **kwargs):
        from reportlab.pdfgen import canvas

        class _Canvas(canvas.Canvas):
            def __init__(self, *a, **k):
                k["invariant"] = 1  # pins CreationDate/ModDate for reproducible bytes
                super().__init__(*a, **k)

        return _Canvas(*args, **kwargs)


def _on_page(numbering, canvas, doc):
    if numbering.style == "none":
        return
    n = doc.page - 1 + numbering.start_at
    if numbering.style == "roman":
        n = _roman(n)
    canvas.saveState()
    canvas.setFont("Helvetica", 9)
    w, h = doc.pagesize
    y = 0.45 * inch if numbering.position.startswith("bottom") else h - 0.45 * inch
    if numbering.position == "bottom-outer":
        x = doc.pagesize[0] - doc.rightMargin - 0.25 * inch if doc.page % 2 else doc.leftMargin + 0.25 * inch
    else:
        x = w / 2
    canvas.drawCentredString(x, y, str(n))
    canvas.restoreState()


def _roman(n: int) -> str:
    vals = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"),
            (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]
    out = ""
    for v, s in vals:
        while n >= v:
            out += s
            n -= v
    return out or "i"


def render_pdf(book: dict, edition: PrintEdition) -> tuple[bytes, str]:
    """Render print edition to PDF. Returns (pdf_bytes, sha256_hex)."""
    tw, th = edition.trim_in
    m = edition.margins
    typo = edition.typography
    pagesize = ((tw + 2 * edition.bleed_in) * inch, (th + 2 * edition.bleed_in) * inch)

    buf = BytesIO()
    doc = BaseDocTemplate(
        buf,
        pagesize=pagesize,
        leftMargin=m.outer * inch,
        rightMargin=m.inner * inch,
        topMargin=m.top * inch,
        bottomMargin=m.bottom * inch,
        title=book["metadata"].get("title", ""),
        author=book["metadata"].get("author", ""),
        creator=f"bookworm-renderer {RENDERER_VERSION}",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="body")
    numbering = edition.page_numbering
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame],
                                       onPage=lambda c, d: _on_page(numbering, c, d))])

    body = ParagraphStyle("body", fontName=typo.body_font, fontSize=typo.body_size_pt,
                          leading=typo.leading)
    heading = ParagraphStyle("heading", fontName=typo.heading_font,
                             fontSize=typo.heading_size_pt, leading=typo.heading_size_pt * 1.2,
                             spaceAfter=typo.leading)
    caption = ParagraphStyle("caption", parent=body, fontSize=typo.body_size_pt - 1)

    story: list = [Paragraph(book["metadata"].get("title", ""), heading), Spacer(1, typo.leading)]
    for ch in sorted(book["chapters"], key=lambda c: c["order"]):
        story.append(PageBreak())
        story.append(Paragraph(ch.get("title", ""), heading))
        for n in ch.get("nodes", []):
            text = (n.get("text") or "").replace("&", "&amp;").replace("<", "&lt;")
            t = n.get("type")
            if t == "heading":
                story.append(Paragraph(text, heading))
            elif t in ("paragraph", "quote", "footnote", "listItem"):
                story.append(Paragraph(text, body))
            elif t == "caption":
                story.append(Paragraph(text, caption))
            elif t == "pageBreak":
                story.append(PageBreak())
            elif t == "separator":
                story.append(Spacer(1, typo.leading))
            # images/tables deferred: print image pipeline needs asset bytes (P1)

    doc.build(story, canvasmaker=_DeterministicCanvasMaker.make)
    blob = buf.getvalue()
    return blob, hashlib.sha256(blob).hexdigest()
