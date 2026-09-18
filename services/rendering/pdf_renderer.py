"""Print edition -> PDF via reportlab. Deterministic: fixed creation date via invariant canvas,
fixed base or bundled embedded fonts (no system fonts), fixed flowable ordering. Same input -> same sha256.
"""
import hashlib
from html import escape
from io import BytesIO

from reportlab.lib.enums import TA_JUSTIFY, TA_LEFT
from reportlab.lib import colors
from reportlab.lib.pagesizes import inch
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Image as FlowableImage,
    KeepTogether,
    ListFlowable,
    ListItem,
    LongTable,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
)

from editions import PrintEdition, print_requires_unsupported_rtl_typography
from manuscript import block_tree, image_width, inline_markup, table_rows
from print_fonts import print_font_issues

RENDERER_VERSION = "pdf-1.6.0"
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


def _on_page(numbering, margins, edition, canvas, doc):
    if numbering.style == "none":
        return
    n = doc.page - 1 + numbering.start_at
    if numbering.style == "roman":
        n = _roman(n)
    canvas.saveState()
    canvas.setFont("Helvetica", 9)
    w, h = doc.pagesize
    bleed_in = edition.bleed_in
    trim_left = bleed_in if edition.bleed_edges == "all" or doc.page % 2 == 0 else 0
    trim_width = edition.trim_in[0]
    y = (bleed_in + 0.45) * inch if numbering.position.startswith("bottom") else h - (bleed_in + 0.45) * inch
    if numbering.position == "bottom-outer":
        x = (trim_left + trim_width - margins.outer) * inch if doc.page % 2 else (trim_left + margins.outer) * inch
    else:
        x = (trim_left + trim_width / 2) * inch
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


def render_pdf(book: dict, edition: PrintEdition,
               image_bytes: dict[str, bytes] | None = None) -> tuple[bytes, str]:
    """Render print edition to PDF. Returns (pdf_bytes, sha256_hex)."""
    if print_requires_unsupported_rtl_typography(edition, book.get("metadata") or {}):
        raise ValueError("RTL print PDF requires an embedded shaping-capable font; the base-font renderer cannot produce it safely")
    font_issues = print_font_issues(book, edition.model_dump())
    if font_issues:
        raise ValueError(font_issues[0]["message"])
    tw, th = edition.trim_in
    m = edition.margins
    typo = edition.typography
    inside_bleed = edition.bleed_in if edition.bleed_edges == "all" else 0
    pagesize = ((tw + inside_bleed + edition.bleed_in) * inch, (th + 2 * edition.bleed_in) * inch)

    buf = BytesIO()
    doc = BaseDocTemplate(
        buf,
        pagesize=pagesize,
        leftMargin=(m.inner + inside_bleed) * inch,
        rightMargin=(m.outer + edition.bleed_in) * inch,
        topMargin=(m.top + edition.bleed_in) * inch,
        bottomMargin=(m.bottom + edition.bleed_in) * inch,
        title=book["metadata"].get("title", ""),
        author=book["metadata"].get("author", ""),
        creator=f"bookworm-renderer {RENDERER_VERSION}",
    )
    page_w, page_h = pagesize
    # User margins are measured from the trim edge, never from the PDF edge.
    frame_w = (tw - m.inner - m.outer) * inch
    frame_h = page_h - (m.top + m.bottom + 2 * edition.bleed_in) * inch
    odd_frame = Frame((m.inner + inside_bleed) * inch, (m.bottom + edition.bleed_in) * inch,
                      frame_w, frame_h, id="odd-body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    even_frame = Frame((m.outer + edition.bleed_in) * inch, (m.bottom + edition.bleed_in) * inch,
                       frame_w, frame_h, id="even-body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    numbering = edition.page_numbering
    on_page = lambda c, d: _on_page(numbering, m, edition, c, d)
    doc.addPageTemplates([
        PageTemplate(id="odd", frames=[odd_frame], onPage=on_page),
        PageTemplate(id="even", frames=[even_frame], onPage=on_page),
    ])

    body = ParagraphStyle("body", fontName=typo.body_font, fontSize=typo.body_size_pt,
                          leading=typo.leading, spaceAfter=typo.paragraph_spacing_pt,
                          firstLineIndent=typo.first_line_indent_in * inch,
                          alignment=TA_JUSTIFY if typo.text_align == "justify" else TA_LEFT)
    heading = ParagraphStyle("heading", fontName=typo.heading_font,
                             fontSize=typo.heading_size_pt, leading=typo.heading_size_pt * 1.2,
                             spaceAfter=typo.leading)
    caption = ParagraphStyle("caption", parent=body, fontSize=typo.body_size_pt - 1, firstLineIndent=0)
    quote = ParagraphStyle("quote", parent=body, leftIndent=18, rightIndent=18, firstLineIndent=0)
    list_body = ParagraphStyle("list-body", parent=body, firstLineIndent=0)

    def render_list(group):
        return ListFlowable([
            ListItem([Paragraph(inline_markup(item["node"], pdf=True), list_body),
                      *(render_list(child) for child in item["children"])])
            for item in group["items"]
        ], bulletType="1" if group["style"] == "ordered" else "bullet", start=1 if group["style"] == "ordered" else "bullet", leftIndent=18,
           bulletFontName=typo.body_font, bulletFontSize=typo.body_size_pt)

    # Explicit cycle avoids autoNextPageTemplate retaining a stale next index.
    story: list = [NextPageTemplate(["even", "odd"]), Paragraph(escape(book["metadata"].get("title", "")), heading), Spacer(1, typo.leading)]
    for ch in sorted(book["chapters"], key=lambda c: c["order"]):
        story.append(PageBreak())
        story.append(Paragraph(escape(ch.get("title", "")), heading))
        for block in block_tree(ch.get("nodes", [])):
            if "node" not in block:
                story.append(render_list(block))
                continue
            n = block["node"]
            text = inline_markup(n, pdf=True)
            t = n.get("type")
            if t == "heading":
                story.append(Paragraph(text, heading))
            elif t == "quote":
                story.append(Paragraph(text, quote))
            elif t in ("paragraph", "footnote"):
                story.append(Paragraph(text, body))
            elif t == "caption":
                story.append(Paragraph(text, caption))
            elif t == "pageBreak":
                story.append(PageBreak())
            elif t == "separator":
                story.append(Spacer(1, typo.leading))
            elif t == "table":
                rows = table_rows(n)
                if rows:
                    columns = max(len(row) for row in rows)
                    if columns:
                        cells = [[Paragraph(escape(str(value)).replace("\n", "<br/>"), list_body)
                                  for value in [*row, *([""] * (columns - len(row)))]] for row in rows]
                        story.append(LongTable(cells, colWidths=[frame_w / columns] * columns,
                            splitByRow=1, splitInRow=1, hAlign="LEFT", spaceAfter=typo.leading,
                            style=[("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#777777")),
                                   ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                   ("LEFTPADDING", (0, 0), (-1, -1), 5),
                                   ("RIGHTPADDING", (0, 0), (-1, -1), 5)]))
                elif text:
                    story.append(Paragraph(text, body))
            elif t == "image" and n.get("assetId") in (image_bytes or {}):
                illustration = FlowableImage(BytesIO((image_bytes or {})[n["assetId"]]))
                scale = min(frame_w * image_width(n) / 100 / illustration.imageWidth, frame_h * 0.65 / illustration.imageHeight)
                illustration.drawWidth = illustration.imageWidth * scale
                illustration.drawHeight = illustration.imageHeight * scale
                illustration.hAlign = "CENTER"
                if n.get("caption"):
                    story.append(KeepTogether([illustration, Paragraph(escape(n["caption"]), caption)]))
                else:
                    story.append(illustration)

    doc.build(story, canvasmaker=_DeterministicCanvasMaker.make)
    blob = buf.getvalue()
    return blob, hashlib.sha256(blob).hexdigest()
