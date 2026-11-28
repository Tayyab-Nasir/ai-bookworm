"""Embedded Arabic print PDF with trusted Typst source and per-book inputs."""
from datetime import datetime, timezone
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image
import typst

from editions import PrintEdition, resolve_text_direction
from manuscript import (
    block_tree, image_focal_point, image_print_placement, image_width, inline_runs,
    table_header_rows, table_rows, table_spans,
)

RENDERER_VERSION = "pdf-1.21.0-amiri"
_DIRECTORY = Path(__file__).resolve().parent
_TEMPLATE = (_DIRECTORY / "typst_print.typ").read_bytes()
_FONTS = _DIRECTORY / "fonts"
_TIMESTAMP = datetime(2000, 1, 1, tzinfo=timezone.utc)


def _table(node, rows):
    spans = {(span["row"], span["col"]): span for span in table_spans(node, rows)}
    covered = set()
    cells = []
    columns = max(map(len, rows))
    for y, row in enumerate(rows):
        for x in range(columns):
            if (y, x) in covered:
                continue
            span = spans.get((y, x)) or {"rowspan": 1, "colspan": 1}
            cells.append({"x": x, "y": y, "width": span["colspan"],
                          "height": span["rowspan"], "text": row[x] if x < len(row) else ""})
            covered.update((r, c) for r in range(y, y + span["rowspan"])
                           for c in range(x, x + span["colspan"]))
    return {"kind": "table", "header_rows": table_header_rows(node, rows), "columns": columns, "cells": cells}


def _image(node, data, files, width, height):
    full_bleed = image_print_placement(node) == "fullBleed"
    with Image.open(BytesIO(data)) as source:
        w, h = source.size
        if full_bleed:
            # Crop to the physical page using the saved focal point before placing
            # the image. The preflight DPI check uses the same cover scale.
            fx, fy = image_focal_point(node)
            scale = max(width / w, height / h)
            crop_w, crop_h = width / scale, height / scale
            x, y = fx * (w - crop_w), fy * (h - crop_h)
            image = source.crop((x, y, x + crop_w, y + crop_h))
        else:
            image = source
        if full_bleed or source.format not in {"PNG", "JPEG", "GIF", "WEBP"}:
            encoded = BytesIO()
            mode = "RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB"
            image.convert(mode).save(encoded, format="PNG")
            data = encoded.getvalue()
    path = f"art-{len(files)}"
    files[path] = data
    return {"kind": "fullBleed" if full_bleed else "image", "path": path,
            "ratio": w / h, "width": image_width(node) / 100,
            "alt": node.get("altText") or "", "caption": node.get("caption") or ""}


def _blocks(nodes, images, files, width, height):
    def serialize(block):
        if "node" not in block:
            numbered = block["style"] == "ordered"
            step = -1 if block["reversed"] else 1
            items = []
            for index, item in enumerate(block["items"]):
                number = block["start"] + index * step if numbered else 0
                if numbered and not 1 <= number <= (3999 if block["numberStyle"].endswith("roman") else 1_000_000):
                    raise ValueError("List numbering exceeds the supported print range. Adjust its start or number style.")
                items.append({"number": number, "runs": inline_runs(item["node"]),
                              "children": [serialize(child) for child in item["children"]]})
            return {"kind": "list", "numbered": numbered, "style": block["numberStyle"], "items": items}
        node = block["node"]
        kind = node.get("type")
        if kind == "image":
            data = images.get(node.get("assetId"))
            return _image(node, data, files, width, height) if data else None
        if kind == "table":
            rows = table_rows(node)
            if rows and any(rows):
                return _table(node, rows)
            kind = "paragraph"
        if kind in {"paragraph", "heading", "quote", "footnote", "caption", "pageBreak", "separator"}:
            return {"kind": kind, "runs": inline_runs(node)}
        return None

    result = []
    for block in block_tree(nodes):
        item = serialize(block)
        if item is not None:
            if item["kind"] == "fullBleed" and result and result[-1]["kind"] == "pageBreak":
                result.pop()
            result.append(item)
    return result


def render_amiri_pdf(book: dict, edition: PrintEdition, images: dict[str, bytes], *, chapter_bookmarks: bool) -> bytes:
    metadata = book["metadata"]
    language = (metadata.get("language") or "en").replace("_", "-").split("-")[0].lower()
    if not language.isascii() or not language.isalpha() or len(language) not in (2, 3):
        language = "en"
    inner_bleed = edition.bleed_in if edition.bleed_edges == "all" else 0
    w, h = edition.trim_in
    width, height = (w + inner_bleed + edition.bleed_in) * 72, (h + 2 * edition.bleed_in) * 72
    assets = {"main.typ": _TEMPLATE}
    chapters = []
    for chapter in sorted(book["chapters"], key=lambda item: item["order"]):
        title = chapter.get("title") or ""
        nodes = chapter.get("nodes", [])
        first = nodes[0] if nodes else {}
        repeats_title = (first.get("type") == "heading" and first.get("level") == 1 and bool(title.strip())
                         and (first.get("text") or "").strip() == title.strip())
        chapters.append({"title": inline_runs(first) if repeats_title else [{"text": title, "marks": []}],
                         "blocks": _blocks(nodes[1:] if repeats_title else nodes, images, assets, width, height)})
    isbn = edition.isbn13 if "isbn13" in edition.model_fields_set else metadata.get("isbn13")
    notice = [edition.front_matter.copyright_notice, edition.front_matter.publisher]
    title_lines = [metadata.get(key) or "" for key in ("title", "subtitle", "author")]
    isbn_line = f"ISBN: {isbn}" if isbn else ""
    copyright_lines = ([isbn_line, *title_lines, *notice] if edition.isbn13 else
                       [*notice, isbn_line] if any(line.strip() for line in notice) else [])
    model = {
        "title": title_lines[0], "subtitle": title_lines[1], "author": title_lines[2],
        "subject": f"ISBN-13 {edition.isbn13}" if edition.isbn13 else "",
        "language": language, "rtl": resolve_text_direction(metadata.get("language"), edition.text_direction) == "rtl",
        "page": {"width": width, "height": height, "trim_width": w * 72,
                 "outer_bleed": edition.bleed_in * 72, "inner_bleed": inner_bleed * 72,
                 **{key: value * 72 for key, value in edition.margins.model_dump().items()}},
        "numbering": edition.page_numbering.model_dump(), "typography": edition.typography.model_dump(),
        "copyright": [line for line in copyright_lines if line.strip()],
        "contents": edition.include_table_of_contents, "bookmarks": chapter_bookmarks or edition.include_table_of_contents,
        "chapters": chapters,
    }
    assets["book.json"] = json.dumps(model, ensure_ascii=False).encode("utf-8")
    try:
        with TemporaryDirectory(prefix="bookworm-amiri-") as directory:
            root = Path(directory)
            for name, content in assets.items():
                (root / name).write_bytes(content)
            return typst.compile(root / "main.typ", root=root, font_paths=[_FONTS],
                                 ignore_system_fonts=True, timestamp=_TIMESTAMP)
    except typst.TypstError as error:
        # Compiler diagnostics can include private manuscript text. Keep the
        # API response independent of the compiler's source context.
        raise ValueError("The Amiri print layout could not be rendered. Review the edition settings and manuscript layout.") from error
