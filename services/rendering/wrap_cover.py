"""Paperback wrap geometry and deterministic PDF, based on the saved interior.

KDP formulas: https://kdp.amazon.com/en_US/help/topic/G201953020
Verified 2026-09-18. Custom geometry must come from the chosen printer's template.
"""
import hashlib
from html import escape
from io import BytesIO
from math import isfinite

from PIL import Image
from pypdf import PdfReader
from reportlab.graphics import renderPDF
from reportlab.graphics.barcode import createBarcodeDrawing
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import CMYKColor
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph

from editions import PrintEdition
from lulu_print import lulu_rtl_page_count
from rtl_text import requires_bidi_layout
from kdp_print import kdp_page_count, kdp_page_range
from print_fonts import _missing

VERSION = "paperback-cover-1.2.0"
UPLOADED_VERSION = "uploaded-paperback-cover-1.0.0"
BLEED = 0.125
FACTORS = {"kdp-white": 0.002252, "kdp-cream": 0.0025,
           "kdp-standard-color": 0.002252, "kdp-premium-color": 0.002347}


def pdf_page_count(data: bytes) -> int:
    try:
        reader = PdfReader(BytesIO(data))
        if reader.is_encrypted:
            raise ValueError("encrypted PDF")
        count = len(reader.pages)
        if not 1 <= count <= 2000:
            raise ValueError("unsupported page count")
        return count
    except Exception as error:
        raise ValueError("interior must be a readable, unencrypted PDF of 1–2000 pages") from error


def wrap_geometry(edition: PrintEdition, count: int) -> tuple[float, float, float]:
    config = edition.wrap_cover
    if not config.enabled:
        raise ValueError("enable full paperback cover before generating it")
    if config.profile == "custom":
        if config.lulu_rtl:
            upload_count = lulu_rtl_page_count(count)
            if upload_count != config.expected_page_count:
                raise ValueError(f"The Lulu cover template must match the {upload_count}-page upload from this {count}-page proof; update the template and spine width.")
        elif count != config.expected_page_count:
            raise ValueError(f"printer template expects {config.expected_page_count} pages but the rendered interior has {count}; update the template and spine width")
        spine = config.spine_width_in
    else:
        effective = kdp_page_count(count)
        minimum, maximum = kdp_page_range(config.profile, edition.trim_size)
        if not minimum <= effective <= maximum:
            raise ValueError(f"KDP {config.profile} at {edition.trim_size} requires {minimum}-{maximum} pages; "
                             f"the rendered interior has {count} ({effective} after even-page rounding)")
        spine = effective * FACTORS[config.profile]
    width, height = edition.trim_in
    return 2 * width + spine + 2 * BLEED, height + 2 * BLEED, spine


def _cmyk(hex_color: str) -> tuple[float, float, float, float]:
    r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    k = 1 - max(r, g, b)
    return (0, 0, 0, 1) if k == 1 else ((1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k)


def render_wrap_cover(front: bytes, interior: bytes, edition: PrintEdition) -> tuple[bytes, str]:
    count = pdf_page_count(interior)
    width, height, spine = wrap_geometry(edition, count)
    config = edition.wrap_cover
    for value in (config.back_text, config.spine_text):
        if requires_bidi_layout(value):
            raise ValueError("Wrap cover text requires bidirectional shaping, which is not available.")
        if _missing(value, "BookwormVera"):
            raise ValueError("back or spine text contains characters unsupported by the cover font")
    tw, th = edition.trim_in
    back = Paragraph(escape(config.back_text).replace("\n", "<br/>"), ParagraphStyle(
        "back-cover", fontName="BookwormVera", fontSize=11, leading=15,
        textColor=CMYKColor(*_cmyk(config.text_color))))
    back_width = (tw - 0.8) * 72
    barcode_width, barcode_height = (2.5, 1.7) if config.barcode == "lulu" else (2, 1.2)
    available_height = (th - barcode_height - 1.1) * 72
    _, back_height = back.wrap(back_width, available_height)
    if back_height > available_height:
        raise ValueError("back cover text does not fit above the reserved barcode area; shorten it")
    spine_size = min(12, (spine - 0.125) * 72)
    if config.spine_text and (spine_size < 7 or (config.profile != "custom" and count < 80)):
        raise ValueError("spine is too narrow for readable text; remove spine text or use a longer interior")
    if config.spine_text and pdfmetrics.stringWidth(config.spine_text, "BookwormVera", spine_size) > (th - 0.8) * 72:
        raise ValueError("spine text is too long; shorten it")

    output = BytesIO()
    canvas = Canvas(output, pagesize=(width * 72, height * 72), invariant=1,
                    pageCompression=1, enforceColorSpace="CMYK", initialFontName="BookwormVera")
    canvas.setCreator(f"AI Bookworm {VERSION}")
    canvas.setFillColorCMYK(*_cmyk(config.background_color))
    canvas.rect(0, 0, width * 72, height * 72, stroke=0, fill=1)
    with Image.open(BytesIO(front)) as image:
        # Flatten into one CMYK image; no ICC profiles or transparency are copied.
        canvas.drawImage(ImageReader(image.convert("CMYK")), (BLEED + tw + spine) * 72,
                         0, width=(tw + BLEED) * 72, height=height * 72)
    canvas.setFillColorCMYK(*_cmyk(config.text_color))
    back.drawOn(canvas, (BLEED + 0.4) * 72, (height - BLEED - 0.4) * 72 - back_height)
    if config.spine_text:
        canvas.saveState()
        canvas.translate((BLEED + tw + spine / 2) * 72, height * 36)
        canvas.rotate(90)
        canvas.setFont("BookwormVera", spine_size)
        canvas.drawCentredString(0, -spine_size * 0.3, config.spine_text)
        canvas.restoreState()
    # Leave the printer's placement area blank unless this edition supplies an ISBN barcode.
    barcode_x = (BLEED + tw - barcode_width - 0.25) * 72
    barcode_y = (BLEED + 0.25) * 72
    canvas.setFillColorCMYK(0, 0, 0, 0)
    canvas.rect(barcode_x, barcode_y, barcode_width * 72, barcode_height * 72, stroke=0, fill=1)
    if config.barcode:
        black = CMYKColor(0, 0, 0, 1)
        # ReportLab's drawing spans 113 modules including quiet zones. Lulu's
        # larger white box leaves a further quarter inch on each side.
        lulu_dimensions = {"barWidth": 2 * 72 / 113} if config.barcode == "lulu" else {}
        barcode = createBarcodeDrawing("EAN13", value=edition.isbn13[:12], fontName="BookwormVera",
            fontSize=9, barHeight=(1.2 if config.barcode == "lulu" else 1) * 72,
            barFillColor=black, textColor=black, **lulu_dimensions)
        renderPDF.draw(barcode, canvas, barcode_x + (barcode_width * 72 - barcode.width) / 2,
                       barcode_y + (barcode_height * 72 - barcode.height) / 2)
        canvas.setSubject(f"ISBN-13 {edition.isbn13} ({config.barcode})")
    canvas.showPage()
    canvas.save()
    data = output.getvalue()
    return data, hashlib.sha256(data).hexdigest()


def validate_wrap_pdf(cover: bytes, interior: bytes, edition: PrintEdition) -> None:
    width, height, _ = wrap_geometry(edition, pdf_page_count(interior))
    uploaded = edition.wrap_cover.source_pdf_version is not None
    if uploaded and (not cover.startswith(b"%PDF-") or len(cover) > 25 * 1024 * 1024):
        raise ValueError("upload a readable paperback cover PDF of up to 25 MB")
    try:
        reader = PdfReader(BytesIO(cover), strict=uploaded)
        if reader.is_encrypted or len(reader.pages) != 1:
            raise ValueError("cover must contain one unencrypted page")
        page = reader.pages[0]
        # Accommodate normal PDF exporter rounding on external templates.
        tolerance = 0.1 if uploaded else 0.01
        unit = float(page.user_unit)
        actual = [float(page.mediabox.width) * unit, float(page.mediabox.height) * unit]
        if page.rotation or not all(isfinite(value) for value in actual) or any(
            abs(value - expected * 72) > tolerance for value, expected in zip(actual, (width, height))
        ):
            raise ValueError(f"cover dimensions must be {width:.4f} × {height:.4f} inches for the rendered interior and saved spine settings")
        if any(not isfinite(float(a)) or not isfinite(float(b)) or abs(float(a - b) * unit) > tolerance for a, b in zip(page.cropbox, page.mediabox)):
            raise ValueError("cover crop box must preserve the full cover and bleed")
        if uploaded:
            catalog = reader.root_object
            names = catalog.get("/Names")
            if (any(key in catalog for key in ("/OpenAction", "/AA", "/AcroForm", "/AF", "/Collection", "/OCProperties"))
                or any(key in page for key in ("/AA", "/Annots", "/AF"))
                or (names is not None and any(key in names.get_object() for key in ("/JavaScript", "/EmbeddedFiles")))):
                raise ValueError("export a flattened print cover PDF without forms, layers, annotations, actions, or attachments")
            if page.get_contents() is None:
                raise ValueError("the uploaded cover page has no print content")
        if edition.wrap_cover.barcode:
            isbn = edition.isbn13
            expected = f"ISBN-13 {isbn} ({edition.wrap_cover.barcode})"
            if reader.metadata.get("/Subject") != expected or page.extract_text().split()[-3:] != [isbn[0], isbn[1:7], isbn[7:]]:
                raise ValueError("cover ISBN barcode does not match this saved print edition; render again")
    except ValueError:
        raise
    except Exception as error:
        raise ValueError("cover must be a readable single-page PDF") from error


def prepare_wrap_cover(cover: bytes, interior: bytes, edition: PrintEdition) -> tuple[bytes, str]:
    if edition.wrap_cover.source_pdf_version is None:
        return render_wrap_cover(cover, interior, edition)
    validate_wrap_pdf(cover, interior, edition)
    return cover, hashlib.sha256(cover).hexdigest()
