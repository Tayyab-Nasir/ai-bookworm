"""Bounded, inert page images from exact saved PDF bytes, never a new book render."""
from __future__ import annotations

import base64
import hashlib
from contextlib import ExitStack
from io import BytesIO
from math import isfinite, sqrt
from threading import BoundedSemaphore

import pypdfium2 as pdfium

VERSION = "pdf-proof-1.0.0"
MAX_PDF_BYTES = 150 * 1024 * 1024
MAX_PNG_BYTES = 6 * 1024 * 1024
MAX_PIXELS = 6_000_000
MAX_SIDE = 4096
WIDTHS = (720, 1080, 1440)
_slot = BoundedSemaphore(1)  # PDFium is not thread-safe, even across distinct documents.


def preview_pdf_page(content: bytes, page_number: int, width: int = 1080) -> dict:
    if (not isinstance(content, bytes) or not 9 <= len(content) <= MAX_PDF_BYTES
            or not content.startswith(b"%PDF-") or type(page_number) is not int
            or not 1 <= page_number <= 20_000 or type(width) is not int or width not in WIDTHS):
        raise ValueError("invalid saved PDF preview input")
    flags = getattr(pdfium.PDFIUM_INFO, "flags", None)
    if flags is None or any(flag.upper() in {"V8", "XFA"} for flag in flags):
        raise RuntimeError("saved PDF preview requires the non-scriptable PDFium build")
    if not _slot.acquire(blocking=False):
        raise RuntimeError("saved PDF preview is busy")
    try:
        try:
            with ExitStack() as handles:
                document = pdfium.PdfDocument(content)
                handles.callback(document.close)
                pages = len(document)
                if not 1 <= pages <= 20_000 or page_number > pages:
                    raise ValueError("saved PDF page is outside this document")
                page = document[page_number - 1]
                handles.callback(page.close)
                point_width, point_height = page.get_size()
                if not all(isfinite(value) and 1 <= value <= 14_400 for value in (point_width, point_height)):
                    raise ValueError("unsupported saved PDF geometry")
                scale = min(width / point_width, MAX_SIDE / point_height,
                            sqrt(MAX_PIXELS / (point_width * point_height)))
                # No form environment, annotations, JavaScript, XFA or external URL execution.
                bitmap = page.render(scale=scale, draw_annots=False, may_draw_forms=False,
                                     fill_color=(255, 255, 255, 255))
                handles.callback(bitmap.close)
                # to_pil() may share native memory. convert() makes an owned RGB copy.
                with bitmap.to_pil() as view, view.convert("RGB") as image:
                    pixels_w, pixels_h = image.size
                    if not (1 <= pixels_w <= MAX_SIDE and 1 <= pixels_h <= MAX_SIDE
                            and pixels_w * pixels_h <= MAX_PIXELS):
                        raise ValueError("saved PDF preview exceeds pixel limits")
                    buffer = BytesIO()
                    image.save(buffer, format="PNG", optimize=False, compress_level=6)
                    png = buffer.getvalue()
                if len(png) > MAX_PNG_BYTES:
                    raise ValueError("saved PDF preview exceeds its byte limit")
                text_page = page.get_textpage()
                handles.callback(text_page.close)
                count = text_page.count_chars()
                text = text_page.get_text_range(0, min(count, 6000)) if count else ""
                text = "".join(char for char in text if char in "\n\r\t" or 32 <= ord(char) < 127 or ord(char) >= 160)
                truncated = count > 6000 or len(text) > 6000
                return {"formatVersion": VERSION,
                        "sourceSha256": hashlib.sha256(content).hexdigest(), "sourceSizeBytes": len(content),
                        "pageNumber": page_number, "pageCount": pages, "requestedWidth": width,
                        "pageWidthPoints": point_width, "pageHeightPoints": point_height,
                        "text": text[:6000], "textTruncated": truncated,
                        "image": {"mimeType": "image/png", "width": pixels_w, "height": pixels_h,
                                  "sizeBytes": len(png), "sha256": hashlib.sha256(png).hexdigest(),
                                  "base64": base64.b64encode(png).decode("ascii")}}
        except pdfium.PdfiumError as error:
            raise ValueError("saved PDF cannot be decoded") from error
    finally:
        _slot.release()
