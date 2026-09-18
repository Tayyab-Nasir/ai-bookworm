"""Paperback wrap geometry and deterministic PDF, based on the saved interior.

KDP formulas: https://kdp.amazon.com/en_US/help/topic/G201953020
Verified 2026-09-18. Custom geometry must come from the chosen printer's template.
"""
import hashlib
from html import escape
from io import BytesIO

from PIL import Image
from pypdf import PdfReader
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import CMYKColor
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph

from editions import PrintEdition
from kdp_print import kdp_page_count, kdp_page_range
from print_fonts import _missing

VERSION = "paperback-cover-1.1.0"
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
        if count != config.expected_page_count:
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
        if _missing(value, "BookwormVera"):
            raise ValueError("back or spine text contains characters unsupported by the cover font")
    tw, th = edition.trim_in
    back = Paragraph(escape(config.back_text).replace("\n", "<br/>"), ParagraphStyle(
        "back-cover", fontName="BookwormVera", fontSize=11, leading=15,
        textColor=CMYKColor(*_cmyk(config.text_color))))
    back_width = (tw - 0.8) * 72
    available_height = (th - 2.3) * 72
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
    # Printer supplies the ISBN barcode. This is a blank reserved area, not a barcode.
    canvas.setFillColorCMYK(0, 0, 0, 0)
    canvas.rect((BLEED + tw - 2.25) * 72, (BLEED + 0.25) * 72, 2 * 72, 1.2 * 72, stroke=0, fill=1)
    canvas.showPage()
    canvas.save()
    data = output.getvalue()
    return data, hashlib.sha256(data).hexdigest()


def validate_wrap_pdf(cover: bytes, interior: bytes, edition: PrintEdition) -> None:
    width, height, _ = wrap_geometry(edition, pdf_page_count(interior))
    try:
        reader = PdfReader(BytesIO(cover))
        if reader.is_encrypted or len(reader.pages) != 1:
            raise ValueError("cover must contain one unencrypted page")
        page = reader.pages[0]
        if page.rotation or abs(float(page.mediabox.width) - width * 72) > 0.01 or abs(float(page.mediabox.height) - height * 72) > 0.01:
            raise ValueError("cover dimensions do not match the rendered interior and saved spine settings")
        if any(abs(float(a) - float(b)) > 0.01 for a, b in zip(page.cropbox, page.mediabox)):
            raise ValueError("cover crop box must preserve the full cover and bleed")
    except ValueError:
        raise
    except Exception as error:
        raise ValueError("cover must be a readable single-page PDF") from error
