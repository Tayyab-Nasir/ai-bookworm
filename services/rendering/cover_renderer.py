"""Deterministic front-cover composition from private artwork + edition settings."""
import hashlib
from io import BytesIO
from pathlib import Path

import qrcode
import reportlab
from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError

from editions import EbookEdition, PrintEdition, cover_requires_unsupported_rtl_typography
from print_fonts import _missing

COVER_RENDERER_VERSION = "cover-1.2.0"


def _font(size: int, bold: bool = False):
    name = "VeraBd.ttf" if bold else "Vera.ttf"
    path = Path(reportlab.__file__).resolve().parent / "fonts" / name
    return ImageFont.truetype(str(path), size=size)


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> str:
    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if current and draw.textbbox((0, 0), candidate, font=font)[2] > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return "\n".join(lines)


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

    metadata = book.get("metadata") or {}
    color = cover.text_color
    side = round(image.width * 0.09)
    title_y = round(image.height * 0.1)
    title_font = _font(max(48, image.width // 13), bold=True)
    subtitle_font = _font(max(30, image.width // 26))
    author_font = _font(max(34, image.width // 23), bold=True)

    if cover.title_on_cover and metadata.get("title"):
        title = _wrap(draw, str(metadata["title"]), title_font, image.width - side * 2)
        draw.multiline_text((image.width / 2, title_y), title, font=title_font, fill=color, anchor="ma", align="center", spacing=12)
        title_box = draw.multiline_textbbox((image.width / 2, title_y), title, font=title_font, anchor="ma", align="center", spacing=12)
        title_y = title_box[3] + 28

    if cover.subtitle_on_cover and metadata.get("subtitle"):
        subtitle = _wrap(draw, str(metadata["subtitle"]), subtitle_font, image.width - side * 2)
        draw.multiline_text((image.width / 2, title_y), subtitle, font=subtitle_font, fill=color, anchor="ma", align="center", spacing=8)

    if cover.author_on_cover and metadata.get("author"):
        author = _wrap(draw, str(metadata["author"]), author_font, round(image.width * 0.65))
        draw.multiline_text((image.width / 2, round(image.height * 0.9)), author, font=author_font, fill=color, anchor="ms", align="center", spacing=8)

    qr = cover.qr_code
    if qr.enabled and qr.url:
        code = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=4)
        code.add_data(qr.url)
        code.make(fit=True)
        qr_image = code.make_image(fill_color="black", back_color="white").convert("RGB")
        qr_image = qr_image.resize((qr.size_px, qr.size_px), Image.Resampling.NEAREST)
        pad = max(12, qr.size_px // 12)
        card = Image.new("RGB", (qr.size_px + pad * 2, qr.size_px + pad * 2), "white")
        card.paste(qr_image, (pad, pad))
        x = side if qr.position == "bottom-left" else image.width - side - card.width
        y = image.height - side - card.height
        image.paste(card, (x, y))
        if qr.label:
            label_font = _font(max(30 if edition.kind == "print" and edition.wrap_cover.enabled else 18, image.width // 60))
            draw = ImageDraw.Draw(image)
            draw.text((x + card.width / 2, y - 12), qr.label, font=label_font, fill=color, anchor="ms")

    output = BytesIO()
    image.save(output, format="PNG", optimize=False, compress_level=9)
    data = output.getvalue()
    return data, hashlib.sha256(data).hexdigest()
