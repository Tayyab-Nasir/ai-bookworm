"""Fit checks exercise measured ink and the exact output QR module grid."""
import io
import copy
import sys
from pathlib import Path

import pytest
import qrcode
from PIL import Image, ImageChops, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cover_renderer
from editions import parse_edition


def artwork():
    output = io.BytesIO()
    Image.new("RGB", (600, 900), "black").save(output, "PNG")
    return output.getvalue()


def edition(kind="ebook", **qr):
    config = {"kind": kind, "cover": {"asset_id": "77777777-7777-4777-8777-777777777777", "overlay_opacity": 0,
              "qr_code": {"enabled": True, "url": "https://author.example/book", **qr}}}
    if kind == "print":
        config["trim_size"] = "8.5x11"
        config["wrap_cover"] = {"enabled": True}
    return parse_edition(config)


def test_long_tokens_wrap_without_losing_visible_characters_and_shrink_to_fit():
    draw = ImageDraw.Draw(Image.new("RGB", (1600, 2400)))
    text = "W" * 100 + "\nÉléphant descenders gjpq " * 4
    fitted = cover_renderer._fit_text(draw, text, 500, 600, 100, 30, bold=True, label="cover title")
    wrapped, font, _, box = fitted
    assert "".join(wrapped.split()) == "".join(text.split())
    assert 30 <= font.size < 100
    assert box[2] - box[0] <= 500 and box[3] - box[1] <= 600


@pytest.mark.parametrize("kind", ["ebook", "print"])
@pytest.mark.parametrize("position", ["bottom-left", "bottom-right"])
def test_composed_text_stays_inside_safe_area_and_never_collides_with_qr(monkeypatch, kind, position):
    config = edition(kind, size_px=512, position=position, label="Discover additional stories and author updates")
    book = {"metadata": {"title": "W" * 140, "subtitle": "Éléphant adventures and discoveries " * 10,
                         "author": "Alexandra Elizabeth Montgomery " * 5}}
    boxes = []
    actual_paint = cover_renderer._paint_text

    def record(draw, fitted, left, top, width, color):
        box = fitted[3]
        ink_left = left + (width - (box[2] - box[0])) // 2
        boxes.append((ink_left, top, ink_left + box[2] - box[0], top + box[3] - box[1]))
        actual_paint(draw, fitted, left, top, width, color)

    monkeypatch.setattr(cover_renderer, "_paint_text", record)
    data, checksum = cover_renderer.compose_front_cover(artwork(), book, config)
    first_boxes = list(boxes)
    assert len(first_boxes) == 4  # Title, subtitle, author and QR label.
    assert (data, checksum) == cover_renderer.compose_front_cover(artwork(), book, config)
    image = Image.open(io.BytesIO(data)).convert("RGB")
    side = round(image.width * 0.09)
    top, bottom = round(image.height * 0.1), round(image.height * 0.9)
    qr_extent = 512 + 2 * (512 // 12)
    x = side if position == "bottom-left" else image.width - side - qr_extent
    first_boxes.append((x, bottom - qr_extent, x + qr_extent, bottom))
    for index, box in enumerate(first_boxes):
        assert side <= box[0] < box[2] <= image.width - side
        assert top <= box[1] < box[3] <= bottom
        for other in first_boxes[index + 1:]:
            assert box[2] <= other[0] or other[2] <= box[0] or box[3] <= other[1] or other[3] <= box[1]
    # Real output pixels, not merely planned coordinates, respect the safe area.
    ink = ImageChops.difference(image, Image.new("RGB", image.size, "black")).getbbox()
    assert ink and ink[0] >= side and ink[1] >= top and ink[2] <= image.width - side and ink[3] <= bottom


@pytest.mark.parametrize("size", [180, 181, 255, 512])
def test_qr_output_preserves_integer_modules_and_four_module_quiet_zone(size):
    url = "https://author.example/book"
    image = cover_renderer._qr_image(url, size)
    expected = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=4)
    expected.add_data(url)
    expected.make(fit=True)
    matrix = expected.get_matrix()
    modules = len(matrix)
    pixels = size // modules
    inset = (size - modules * pixels) // 2
    assert pixels >= 4 and image.size == (size, size)
    for row, values in enumerate(matrix):
        for column, dark in enumerate(values):
            tile = image.crop((inset + column * pixels, inset + row * pixels,
                               inset + (column + 1) * pixels, inset + (row + 1) * pixels))
            value = 0 if dark else 255
            assert tile.getextrema() == ((value, value),) * 3
    ink = ImageChops.invert(image).getbbox()
    assert ink and ink[0] >= inset + 4 * pixels and ink[1] >= inset + 4 * pixels
    assert size - ink[2] >= 4 * pixels and size - ink[3] >= 4 * pixels


def test_composed_qr_card_preserves_exact_generated_code_bytes():
    config = edition(size_px=181, position="bottom-left")
    data, _ = cover_renderer.compose_front_cover(artwork(), {"metadata": {}}, config)
    image = Image.open(io.BytesIO(data)).convert("RGB")
    side, pad = round(image.width * 0.09), 181 // 12
    y = round(image.height * 0.9) - 181 - pad * 2
    extracted = image.crop((side + pad, y + pad, side + pad + 181, y + pad + 181))
    assert extracted.tobytes() == cover_renderer._qr_image(config.cover.qr_code.url, 181).tobytes()


@pytest.mark.parametrize("field", ["title", "subtitle", "author"])
def test_unfit_visible_text_fails_instead_of_clipping_or_truncating(field):
    config = edition()
    with pytest.raises(ValueError, match=f"cover {field} does not fit"):
        cover_renderer.compose_front_cover(artwork(), {"metadata": {field: "W" * 2049}}, config)
    setattr(config.cover, f"{field}_on_cover", False)
    assert cover_renderer.compose_front_cover(artwork(), {"metadata": {field: "W" * 2049}}, config)[0]


def test_qr_too_dense_over_capacity_or_unfit_label_fails_clearly():
    with pytest.raises(ValueError, match="increase QR size or shorten"):
        cover_renderer._qr_image("https://author.example/" + "x" * 300, 96)
    with pytest.raises(ValueError, match="exceeds QR capacity"):
        cover_renderer._qr_image("https://author.example/" + "x" * 10000, 512)
    config = edition("print", label="W" * 120)
    with pytest.raises(ValueError, match="QR label does not fit at a readable size"):
        cover_renderer.compose_front_cover(artwork(), {"metadata": {}}, config)
    config.cover.qr_code.enabled = False
    assert cover_renderer.compose_front_cover(artwork(), {"metadata": {}}, config)[0]


def _cover_book():
    return {"metadata": {"title": "The original title", "subtitle": "Original subtitle",
                         "author": "Original Author", "language": "en"}}


@pytest.mark.parametrize("kind, expected", [
    ("ebook", "3df9f923a5c48710f3e62474a38f1b3944e8a2bf053c515733ac15d6672c908c"),
    ("print", "20a633744c51dae17df0549a40d1e086bfe00dd21c693a603a6f934a0470308c"),
])
def test_effective_ebook_cover_preserves_legacy_no_override_and_print_png(kind, expected):
    # Captured with cover-1.3.0 before changing the effective-metadata policy.
    book = _cover_book()
    config = edition(kind, label="Discover more")
    original = copy.deepcopy((book, config.model_dump()))
    data, checksum = cover_renderer.compose_front_cover(artwork(), book, config)
    assert checksum == expected
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    assert (book, config.model_dump()) == original


@pytest.mark.parametrize("overrides", [
    {"title": "The edition title", "subtitle": "An edition subtitle", "author": "Edition Author"},
    {"title": ""}, {"subtitle": ""}, {"author": ""},
    {"title": "", "subtitle": "", "author": "", "language": "ar"},
])
def test_effective_ebook_cover_png_matches_equivalent_base_metadata_with_qr(overrides):
    book = _cover_book()
    control = {"metadata": {**book["metadata"], **overrides}}
    control_edition = edition(label="Discover more")
    config = parse_edition({**control_edition.model_dump(), "metadata_overrides": overrides})
    original = copy.deepcopy((book, config.model_dump()))
    actual = cover_renderer.compose_front_cover(artwork(), book, config)
    expected = cover_renderer.compose_front_cover(artwork(), control, control_edition)
    assert actual[1] == expected[1]
    assert actual[0] == expected[0]  # Exact PNG, including text and QR pixels.
    assert (book, config.model_dump()) == original


@pytest.mark.parametrize("field", ["title", "subtitle", "author"])
@pytest.mark.parametrize("visible", [True, False])
def test_effective_ebook_cover_checks_only_visible_override_glyphs(field, visible):
    book = _cover_book()
    config = edition()
    config.metadata_overrides = {field: "漢字"}
    setattr(config.cover, f"{field}_on_cover", visible)
    original = copy.deepcopy((book, config.model_dump()))
    if visible:
        with pytest.raises(ValueError, match=f"cover {field} contains characters unsupported"):
            cover_renderer.compose_front_cover(artwork(), book, config)
    else:
        control = {"metadata": {**book["metadata"], **config.metadata_overrides}}
        control_edition = parse_edition({**config.model_dump(), "metadata_overrides": {}})
        assert cover_renderer.compose_front_cover(artwork(), book, config) == (
            cover_renderer.compose_front_cover(artwork(), control, control_edition))
    assert (book, config.model_dump()) == original


@pytest.mark.parametrize("field", ["title", "subtitle", "author"])
def test_effective_ebook_cover_valid_override_masks_unsupported_base_glyphs(field):
    book = _cover_book()
    book["metadata"][field] = "漢字"
    config = edition()
    config.metadata_overrides = {field: "Readable edition text"}
    control = {"metadata": {**book["metadata"], **config.metadata_overrides}}
    control_edition = parse_edition({**config.model_dump(), "metadata_overrides": {}})
    assert cover_renderer.compose_front_cover(artwork(), book, config) == (
        cover_renderer.compose_front_cover(artwork(), control, control_edition))


@pytest.mark.parametrize("base_language, effective_language", [("en", "ar"), ("ar", "en")])
def test_effective_ebook_cover_rtl_guard_uses_override_language(base_language, effective_language):
    book = _cover_book()
    book["metadata"]["language"] = base_language
    config = edition()
    config.metadata_overrides = {"language": effective_language}
    if effective_language == "ar":
        with pytest.raises(ValueError, match="RTL cover text"):
            cover_renderer.compose_front_cover(artwork(), book, config)
    else:
        control = {"metadata": {**book["metadata"], "language": "en"}}
        assert cover_renderer.compose_front_cover(artwork(), book, config) == (
            cover_renderer.compose_front_cover(artwork(), control, edition()))


def test_effective_ebook_cover_all_hidden_rtl_overlays_do_not_block_artwork_or_qr():
    book = _cover_book()
    config = edition(label="Discover more")
    config.metadata_overrides = {"language": "ar", "title": "عنوان", "subtitle": "副題", "author": "كاتب"}
    config.cover.title_on_cover = config.cover.subtitle_on_cover = config.cover.author_on_cover = False
    control = {"metadata": {**book["metadata"], **config.metadata_overrides}}
    control_edition = parse_edition({**config.model_dump(), "metadata_overrides": {}})
    assert cover_renderer.compose_front_cover(artwork(), book, config) == (
        cover_renderer.compose_front_cover(artwork(), control, control_edition))
