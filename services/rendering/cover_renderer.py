"""Deterministic front-cover composition from private artwork + edition settings."""
import hashlib
from io import BytesIO
from pathlib import Path

import qrcode
import reportlab
from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError

from editions import EbookEdition, PrintEdition, cover_requires_unsupported_rtl_typography
from print_fonts import _missing

COVER_RENDERER_VERSION = "cover-1.3.0"


def _font(size: int, bold: bool = False):
    name = "VeraBd.ttf" if bold else "Vera.ttf"
    path = Path(reportlab.__file__).resolve().parent / "fonts" / name
    return ImageFont.truetype(str(path), size=size)


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> str:
    """Wrap measured glyphs, including tokens without spaces; never discard text."""
    def width(value: str) -> int:
        box = draw.textbbox((0, 0), value, font=font)
        return box[2] - box[0]

    lines: list[str] = []
    for paragraph in text.splitlines() or [""]:
        current = ""
        for word in paragraph.split():
            candidate = f"{current} {word}".strip()
            if width(candidate) <= max_width:
                current = candidate
                continue
            if current:
                lines.append(current)
                current = ""
            for char in word:
                if current and width(current + char) > max_width:
                    lines.append(current)
                    current = ""
                current += char
        lines.append(current)
    return "\n".join(lines)


def _fit_text(draw, text: str, width: int, height: int, preferred: int, minimum: int, *, bold=False, label: str):
    """Choose a fitting font without shrinking below the readable floor."""
    if len(text) > 2048 or width <= 0 or height <= 0:
        raise ValueError(f"{label} does not fit the cover; shorten the text or disable the overlay")

    def measure(size):
        font = _font(size, bold)
        spacing = max(4, round(size * 0.18))
        wrapped = _wrap(draw, text, font, width)
        box = draw.multiline_textbbox((0, 0), wrapped, font=font, align="center", spacing=spacing)
        return (wrapped, font, spacing, box) if box[2] - box[0] <= width and box[3] - box[1] <= height else None

    fitted = measure(minimum)
    if fitted is None:
        raise ValueError(f"{label} does not fit at a readable size; shorten the text or disable the overlay")
    low, high = minimum + 1, max(minimum, preferred)
    while low <= high:
        size = (low + high) // 2
        candidate = measure(size)
        if candidate is None:
            high = size - 1
        else:
            fitted, low = candidate, size + 1
    return fitted


def _paint_text(draw, fitted, left: int, top: int, width: int, color: str):
    text, font, spacing, box = fitted
    # Anchor the actual ink bounds, including accented capitals and descenders.
    x = left + (width - (box[2] - box[0])) // 2 - box[0]
    y = top - box[1]
    draw.multiline_text((x, y), text, font=font, fill=color, align="center", spacing=spacing)


def _qr_image(url: str, size_px: int) -> Image.Image:
    code = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=1, border=4)
    try:
        code.add_data(url)
        code.make(fit=True)
    except (qrcode.exceptions.DataOverflowError, ValueError) as error:
        raise ValueError("QR destination exceeds QR capacity; shorten the HTTPS URL") from error
    modules = len(code.get_matrix())  # Includes the four-module quiet zone.
    code.box_size = size_px // modules
    if code.box_size < 4:
        raise ValueError("QR size is too small for this destination; increase QR size or shorten the HTTPS URL")
    # Do not resample: every module must occupy an integer number of pixels.
    qr_image = code.make_image(fill_color="black", back_color="white").convert("RGB")
    canvas = Image.new("RGB", (size_px, size_px), "white")
    inset = (size_px - qr_image.width) // 2
    canvas.paste(qr_image, (inset, inset))
    return canvas


def _target_size(edition: EbookEdition | PrintEdition) -> tuple[int, int]:
    if edition.kind == "print":
        width_in, height_in = edition.trim_in
        if edition.wrap_cover.enabled:
            return round((width_in + 0.125) * 300), round((height_in + 0.25) * 300)
        width = 1600
        return width, round(width * height_in / width_in)
    return 1600, 2400


def compose_front_cover(
    artwork: bytes,
    book: dict,
    edition: EbookEdition | PrintEdition,
) -> tuple[bytes, str]:
    """Return a deterministic PNG and sha256. Artwork is never written to disk."""
    if cover_requires_unsupported_rtl_typography(edition, book.get("metadata") or {}):
        raise ValueError("RTL cover text requires an embedded shaping-capable font; the base-font cover renderer cannot produce it safely")
    metadata = book.get("metadata") or {}
    for enabled, key in ((edition.cover.title_on_cover, "title"),
                         (edition.cover.subtitle_on_cover, "subtitle"),
                         (edition.cover.author_on_cover, "author")):
        if enabled and _missing(str(metadata.get(key) or ""), "BookwormVera"):
            raise ValueError(f"cover {key} contains characters unsupported by the cover font")
    if edition.cover.qr_code.enabled and _missing(edition.cover.qr_code.label or "", "BookwormVera"):
        raise ValueError("QR label contains characters unsupported by the cover font")
    try:
        with Image.open(BytesIO(artwork)) as source:
            source.load()
            image = ImageOps.fit(source.convert("RGB"), _target_size(edition), method=Image.Resampling.LANCZOS)
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise ValueError("cover asset is not a supported image") from error

    cover = edition.cover
    draw = ImageDraw.Draw(image, "RGBA")
    if cover.overlay_opacity:
        draw.rectangle((0, 0, image.width, image.height), fill=(0, 0, 0, round(255 * cover.overlay_opacity)))

    color = cover.text_color
    side = round(image.width * 0.09)
    safe_width = image.width - side * 2
    gap = max(16, round(image.width * 0.015))
    top, bottom = round(image.height * 0.1), round(image.height * 0.9)
    print_wrap = edition.kind == "print" and edition.wrap_cover.enabled
    qr = cover.qr_code
    if qr.enabled and qr.url:
        qr_image = _qr_image(qr.url, qr.size_px)
        pad = max(12, qr.size_px // 12)
        card = Image.new("RGB", (qr.size_px + pad * 2, qr.size_px + pad * 2), "white")
        card.paste(qr_image, (pad, pad))
        if card.width > safe_width or card.height > bottom - top:
            raise ValueError("QR code does not fit within the cover safe area; reduce QR size")
        x = side if qr.position == "bottom-left" else image.width - side - card.width
        y = bottom - card.height
        image.paste(card, (x, y))
        bottom = y - gap
        if qr.label and qr.label.strip():
            fitted = _fit_text(draw, qr.label, card.width, round(image.height * 0.12), image.width // 60,
                               30 if print_wrap else 18, label="QR label")
            bottom -= fitted[3][3] - fitted[3][1]
            _paint_text(draw, fitted, x, bottom, card.width, color)
            bottom -= gap

    if cover.author_on_cover and str(metadata.get("author") or "").strip():
        fitted = _fit_text(draw, str(metadata["author"]), safe_width, min(round(image.height * 0.14), bottom - top),
                           image.width // 23, 34, bold=True, label="cover author")
        bottom -= fitted[3][3] - fitted[3][1]
        _paint_text(draw, fitted, side, bottom, safe_width, color)
        bottom -= gap

    title = str(metadata.get("title") or "").strip() if cover.title_on_cover else ""
    subtitle = str(metadata.get("subtitle") or "").strip() if cover.subtitle_on_cover else ""
    if title:
        available = bottom - top
        title_height = int((available - gap) * 0.62) if subtitle else available
        fitted = _fit_text(draw, title, safe_width, title_height, image.width // 13, 48, bold=True, label="cover title")
        _paint_text(draw, fitted, side, top, safe_width, color)
        top += fitted[3][3] - fitted[3][1] + gap
    if subtitle:
        fitted = _fit_text(draw, subtitle, safe_width, bottom - top, image.width // 26, 30, label="cover subtitle")
        _paint_text(draw, fitted, side, top, safe_width, color)

    output = BytesIO()
    image.save(output, format="PNG", optimize=False, compress_level=9)
    data = output.getvalue()
    return data, hashlib.sha256(data).hexdigest()
