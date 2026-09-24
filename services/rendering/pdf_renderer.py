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
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
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
from manuscript import block_tree, image_focal_point, image_print_placement, image_width, inline_markup, table_header_rows, table_rows
from print_images import full_bleed_issues
from print_fonts import code_font, page_number_font, print_font_issues
from print_layout import NUMBER_SIZE_PT, NUMBER_TRIM_INSET_IN, number_metrics, print_layout_issues

RENDERER_VERSION = "pdf-1.13.0"
# reportlab invariant=1 pins CreationDate/ModDate to D:20000101000000 — reproducible bytes


class _Contents(TableOfContents):
    def wrap(self, availWidth, availHeight):
        size = super().wrap(availWidth, availHeight)
        self._table.splitInRow = 1
        return size


class _BookDocTemplate(BaseDocTemplate):
    def beforeDocument(self):
        self._toc_seen = set()

    def afterFlowable(self, flowable):
        name = getattr(getattr(flowable, "style", None), "name", None)
        if name not in self.toc_chapters or name in self._toc_seen:
            return
        self._toc_seen.add(name)
        title, key = self.toc_chapters[name]
        self.canv.bookmarkPage(key)
        self.canv.addOutlineEntry(title, key, level=0)
        text = escape(title) + ("<br/>" if self.toc_stacked else "")
        self.notify("TOCEntry", (0, text, self.page, key))


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


class _FullBleedImage(Flowable):
    """Consume one body frame while painting cropped artwork over the physical PDF page."""

    def __init__(self, data: bytes, pagesize: tuple[float, float], focal: tuple[float, float]):
        super().__init__()
        self.reader = ImageReader(BytesIO(data))
        self.page_w, self.page_h = pagesize
        source_w, source_h = self.reader.getSize()
        scale = max(self.page_w / source_w, self.page_h / source_h)
        self.draw_w, self.draw_h = source_w * scale, source_h * scale
        self.draw_x = -(self.draw_w - self.page_w) * focal[0]
        self.draw_y = -(self.draw_h - self.page_h) * (1 - focal[1])

    def wrap(self, available_width, available_height):
        return available_width, available_height

    def drawOn(self, canvas, x, y, _sW=0):  # noqa: N802 - ReportLab API
        canvas._bookworm_full_bleed = True
        canvas.saveState()
        path = canvas.beginPath()
        path.rect(0, 0, self.page_w, self.page_h)
        canvas.clipPath(path, stroke=0, fill=0)
        canvas.drawImage(self.reader, self.draw_x, self.draw_y, self.draw_w, self.draw_h,
                         preserveAspectRatio=False, mask="auto")
        canvas.restoreState()


def _on_page(numbering, margins, edition, canvas, doc):
    if numbering.style == "none" or getattr(canvas, "_bookworm_full_bleed", False):
        return
    n = doc.page - 1 + numbering.start_at
    if numbering.style == "roman":
        n = _roman(n)
    canvas.saveState()
    font, ascent, descent = number_metrics(edition)
    canvas.setFont(font, NUMBER_SIZE_PT)
    w, h = doc.pagesize
    bleed_in = edition.bleed_in
    trim_left = bleed_in if edition.bleed_edges == "all" or doc.page % 2 == 0 else 0
    trim_width = edition.trim_in[0]
    # Position the complete font box inside trim, not just its baseline.
    y = ((bleed_in + NUMBER_TRIM_INSET_IN) * inch - descent
         if numbering.position.startswith("bottom")
         else h - (bleed_in + NUMBER_TRIM_INSET_IN) * inch - ascent)
    label = str(n)
    label_width = pdfmetrics.stringWidth(label, font, NUMBER_SIZE_PT)
    safe_left = (trim_left + max(margins.outer if doc.page % 2 == 0 else margins.inner, NUMBER_TRIM_INSET_IN)) * inch
    safe_right = (trim_left + trim_width - max(margins.outer if doc.page % 2 else margins.inner, NUMBER_TRIM_INSET_IN)) * inch
    if numbering.position == "bottom-outer":
        x = safe_right - label_width if doc.page % 2 else safe_left
    else:
        x = (trim_left + trim_width / 2) * inch - label_width / 2
    if x < safe_left - 0.001 or x + label_width > safe_right + 0.001:
        raise ValueError("Page number does not fit between the inner and outer margins. Reduce the starting number, use Arabic numbering, or change margins.")
    canvas.drawString(x, y, label)
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
               image_bytes: dict[str, bytes] | None = None, *, chapter_bookmarks: bool = False) -> tuple[bytes, str]:
    """Render print edition to PDF. Returns (pdf_bytes, sha256_hex)."""
    layout_issues = print_layout_issues(edition)
    if layout_issues:
        raise ValueError(layout_issues[0]["message"])
    if print_requires_unsupported_rtl_typography(edition, book.get("metadata") or {}):
        raise ValueError("RTL print PDF requires an embedded shaping-capable font; the base-font renderer cannot produce it safely")
    font_issues = print_font_issues(book, edition.model_dump())
    if font_issues:
        raise ValueError(font_issues[0]["message"])
    image_issues = full_bleed_issues(book, edition, image_bytes or {})
    if image_issues:
        raise ValueError(image_issues[0]["message"])
    tw, th = edition.trim_in
    m = edition.margins
    typo = edition.typography
    inside_bleed = edition.bleed_in if edition.bleed_edges == "all" else 0
    pagesize = ((tw + inside_bleed + edition.bleed_in) * inch, (th + 2 * edition.bleed_in) * inch)

    buf = BytesIO()
    doc = _BookDocTemplate(
        buf,
        pagesize=pagesize,
        leftMargin=(m.inner + inside_bleed) * inch,
        rightMargin=(m.outer + edition.bleed_in) * inch,
        topMargin=(m.top + edition.bleed_in) * inch,
        bottomMargin=(m.bottom + edition.bleed_in) * inch,
        title=book["metadata"].get("title", ""),
        author=book["metadata"].get("author", ""),
        creator=f"bookworm-renderer {RENDERER_VERSION}",
        initialFontName=page_number_font(typo.body_font, typo.heading_font),
    )
    page_w, page_h = pagesize
    doc.toc_chapters = {}
    doc.toc_stacked = False
    # User margins are measured from the trim edge, never from the PDF edge.
    frame_w = (tw - m.inner - m.outer) * inch
    frame_h = page_h - (m.top + m.bottom + 2 * edition.bleed_in) * inch
    odd_frame = Frame((m.inner + inside_bleed) * inch, (m.bottom + edition.bleed_in) * inch,
                      frame_w, frame_h, id="odd-body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    even_frame = Frame((m.outer + edition.bleed_in) * inch, (m.bottom + edition.bleed_in) * inch,
                       frame_w, frame_h, id="even-body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    numbering = edition.page_numbering
    on_page = lambda c, d: _on_page(numbering, m, edition, c, d)
    begin_page = lambda c, d: setattr(c, "_bookworm_full_bleed", False)
    doc.addPageTemplates([
        PageTemplate(id="odd", frames=[odd_frame], onPage=begin_page, onPageEnd=on_page),
        PageTemplate(id="even", frames=[even_frame], onPage=begin_page, onPageEnd=on_page),
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
            ListItem([Paragraph(inline_markup(item["node"], pdf=True, pdf_code_font=code_font(typo.body_font)), list_body),
                      *(render_list(child) for child in item["children"])])
            for item in group["items"]
        ], bulletType="1" if group["style"] == "ordered" else "bullet", start=1 if group["style"] == "ordered" else "bullet", leftIndent=18,
           bulletFontName=typo.body_font, bulletFontSize=typo.body_size_pt)

    # Explicit cycle avoids autoNextPageTemplate retaining a stale next index.
    story: list = [NextPageTemplate(["even", "odd"]), Paragraph(escape(book["metadata"].get("title", "")), heading), Spacer(1, typo.leading)]
    front_style = ParagraphStyle("FrontMatter", parent=body, firstLineIndent=0, alignment=TA_LEFT)
    for key in ("subtitle", "author"):
        if book["metadata"].get(key):
            story.append(Paragraph(escape(book["metadata"][key]), front_style))
    if edition.front_matter.copyright_notice.strip() or edition.front_matter.publisher.strip():
        story.append(PageBreak())
        for text in (edition.front_matter.copyright_notice, edition.front_matter.publisher,
                     f"ISBN: {book['metadata']['isbn13']}" if book["metadata"].get("isbn13") else ""):
            if text.strip():
                story.append(Paragraph(escape(text).replace("\n", "<br/>"), front_style))
    if edition.include_table_of_contents:
        def contents_number(page):
            number = page - 1 + numbering.start_at
            return "" if numbering.style == "none" else _roman(number) if numbering.style == "roman" else str(number)

        # Reserve a separate label area so wrapped chapter titles cannot cover
        # page labels. The supported retailer interior range is at most 2000.
        label_width = max(pdfmetrics.stringWidth(contents_number(page), typo.body_font, typo.body_size_pt)
                          for page in range(1, 2001)) + 12
        doc.toc_stacked = label_width > frame_w * 0.4
        contents_style = ParagraphStyle("ContentsEntry", parent=body, firstLineIndent=0,
                                        alignment=TA_LEFT, rightIndent=0 if doc.toc_stacked else label_width)
        toc = _Contents(levelStyles=[contents_style], formatter=contents_number)
        toc.dotsMinLevel = -1 if numbering.style == "none" else 0
        story.extend([PageBreak(), Paragraph("Contents", heading), toc])
    for index, ch in enumerate(sorted(book["chapters"], key=lambda c: c["order"])):
        story.append(PageBreak())
        chapter_style = heading
        if edition.include_table_of_contents or chapter_bookmarks:
            chapter_style = ParagraphStyle(f"ChapterHeading{index}", parent=heading)
            doc.toc_chapters[chapter_style.name] = (ch.get("title", ""), f"chapter-{index}")
        story.append(Paragraph(escape(ch.get("title", "")), chapter_style))
        for block in block_tree(ch.get("nodes", [])):
            if "node" not in block:
                story.append(render_list(block))
                continue
            n = block["node"]
            t = n.get("type")
            text = inline_markup(n, pdf=True, pdf_code_font=code_font(typo.heading_font if t == "heading" else typo.body_font))
            if t == "heading":
                story.append(Paragraph(text, heading))
            elif t == "quote":
                story.append(Paragraph(text, quote))
            elif t in ("paragraph", "footnote"):
                story.append(Paragraph(text, body))
            elif t == "caption":
                story.append(Paragraph(text, caption))
            elif t == "pageBreak":
                if not isinstance(story[-1], PageBreak):
                    story.append(PageBreak())
            elif t == "separator":
                story.append(Spacer(1, typo.leading))
            elif t == "table":
                rows = table_rows(n)
                if rows:
                    columns = max(len(row) for row in rows)
                    if columns:
                        header_count = table_header_rows(n, rows)
                        cells = [[Paragraph(("<b>" if row_index < header_count else "")
                                            + escape(str(value)).replace("\n", "<br/>")
                                            + ("</b>" if row_index < header_count else ""), list_body)
                                  for value in [*row, *([""] * (columns - len(row)))]]
                                 for row_index, row in enumerate(rows)]
                        table_style = [("FONTNAME", (0, 0), (-1, -1), typo.body_font),
                                       ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#777777")),
                                       ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                       ("LEFTPADDING", (0, 0), (-1, -1), 5),
                                       ("RIGHTPADDING", (0, 0), (-1, -1), 5)]
                        if header_count:
                            table_style.append(("BACKGROUND", (0, 0), (-1, header_count - 1), colors.HexColor("#e7e2d8")))
                        story.append(LongTable(cells, colWidths=[frame_w / columns] * columns,
                            repeatRows=header_count, splitByRow=1, splitInRow=1, hAlign="LEFT",
                            spaceAfter=typo.leading, style=table_style))
                elif text:
                    story.append(Paragraph(text, body))
            elif t == "image" and n.get("assetId") in (image_bytes or {}):
                if image_print_placement(n) == "fullBleed":
                    if not isinstance(story[-1], PageBreak):
                        story.append(PageBreak())
                    story.append(_FullBleedImage((image_bytes or {})[n["assetId"]], pagesize, image_focal_point(n)))
                    continue
                illustration = FlowableImage(BytesIO((image_bytes or {})[n["assetId"]]))
                scale = min(frame_w * image_width(n) / 100 / illustration.imageWidth, frame_h * 0.65 / illustration.imageHeight)
                illustration.drawWidth = illustration.imageWidth * scale
                illustration.drawHeight = illustration.imageHeight * scale
                illustration.hAlign = "CENTER"
                if n.get("caption"):
                    story.append(KeepTogether([illustration, Paragraph(escape(n["caption"]), caption)]))
                else:
                    story.append(illustration)

    if edition.include_table_of_contents:
        doc.multiBuild(story, canvasmaker=_DeterministicCanvasMaker.make)
    else:
        doc.build(story, canvasmaker=_DeterministicCanvasMaker.make)
    blob = buf.getvalue()
    return blob, hashlib.sha256(blob).hexdigest()
