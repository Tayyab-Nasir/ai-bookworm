"""DOCX parser: paragraphs/headings -> Book Model nodes, images -> asset refs,
chapter split on Heading 1. Spec section 13."""
import io
import zipfile

from docx import Document
from docx.text.run import Run
from docx.table import Table

from . import (ParseError, check_size, make_book, make_report, new_chapter,
               node, safe_zip_members)
from .embedded_images import EmbeddedImages

_HEADING_LEVELS = {f"Heading {i}": i for i in range(1, 7)}


def _paragraph_runs(para) -> list[dict]:
    """Keep text and supported marks, including hyperlink labels but never URLs."""
    result = []
    for content in para.iter_inner_content():
        for run in [content] if isinstance(content, Run) else content.runs:
            marks = []
            for prop, mark in (("bold", "bold"), ("italic", "italic"),
                               ("underline", "underline"), ("strike", "strike")):
                value = getattr(run.font, prop)
                for initial in (run.style, para.style):
                    style, seen = initial, set()
                    while value is None and style is not None and style.style_id not in seen:
                        seen.add(style.style_id)
                        value = getattr(style.font, prop)
                        style = style.base_style
                if value:
                    marks.append({"type": mark})
            for content_item in run.iter_inner_content():
                if isinstance(content_item, str):
                    for i, text in enumerate(content_item.split("\n")):
                        if i:
                            result.append({"type": "hardBreak"})
                        if text:
                            result.append({"type": "text", "text": text, **({"marks": marks} if marks else {})})
                elif hasattr(content_item, "_drawing"):
                    result.append({"type": "drawing", "element": content_item._drawing})
    return result


def _extract_images(doc) -> tuple[dict[str, dict], list[str]]:
    """Map docx rel id -> generated asset entry; extract image bytes for later upload."""
    warnings: list[str] = []
    images: dict[str, dict] = {}
    for rel_id, rel in doc.part.rels.items():
        if "image" not in rel.reltype:
            continue
        try:
            part = rel.target_part
            ext = (part.partname.ext or "bin").lstrip(".")
            images[rel_id] = {
                "filename": f"image-{len(images) + 1}.{ext}",
                "contentType": part.content_type,
                "bytes": part.blob,
            }
        except Exception:
            warnings.append(f"image rel {rel_id} could not be extracted")
    return images, warnings


def parse_docx(data: bytes, title: str = "Untitled", *, embedded_assets: list[dict] | None = None) -> tuple[dict, dict]:
    check_size(data)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            safe_zip_members(zf)  # docx is a zip too — same guards
        doc = Document(io.BytesIO(data))
    except ParseError:
        raise
    except Exception as e:
        raise ParseError(f"not a readable DOCX: {e}") from e

    images, warnings = _extract_images(doc)
    chapters: list[dict] = []
    current: dict | None = None
    assets: list[dict] = []
    transferred = EmbeddedImages(embedded_assets)

    for para in doc.iter_inner_content():
        if isinstance(para, Table):
            if current is None:
                current = new_chapter(title, 0)
                chapters.append(current)
            rows = []
            seen_cells = set()
            for row in para.rows:
                cells = []
                for cell in row.cells:
                    # Word exposes a merged cell multiple times in its grid.
                    # Keep its text once; don't invent repeated manuscript content.
                    if cell._tc in seen_cells:
                        cells.append("")
                    else:
                        seen_cells.add(cell._tc)
                        cells.append(cell.text)
                rows.append(cells)
            current["nodes"].append(node("table", "\n".join("\t".join(r) for r in rows), rows=rows))
            warnings.append("DOCX table text and row order were preserved; merged-cell layout, cell formatting and nested tables require review against the original.")
            continue
        style = para.style.name if para.style else ""
        level = _HEADING_LEVELS.get(style)
        rich_text = _paragraph_runs(para)
        text = "".join("\n" if r["type"] == "hardBreak" else r.get("text", "") for r in rich_text)
        if level == 1:
            current = new_chapter(text.strip() or f"Chapter {len(chapters) + 1}", len(chapters))
            chapters.append(current)
        if current is None:
            # content before the first Heading 1
            current = new_chapter(title, 0)
            chapters.append(current)

        pending = []
        text_blocks = 0

        def flush_text():
            nonlocal text_blocks
            value = "".join("\n" if r["type"] == "hardBreak" else r["text"] for r in pending)
            if value.strip():
                attrs = {"richText": list(pending)}
                kind = "paragraph"
                if not text_blocks:
                    if level:
                        kind = "heading"
                    elif style.lower().startswith(("quote", "block")):
                        kind = "quote"
                    elif style.lower().startswith("list"):
                        kind = "listItem"
                        suffix = style.rsplit(" ", 1)[-1]
                        attrs.update(listStyle="ordered" if "number" in style.lower() else "bullet",
                                     listDepth=min(6, max(0, int(suffix) - 1)) if suffix.isdigit() else 0)
                current["nodes"].append(node(kind, value, attributes=attrs, **({"level": level} if kind == "heading" else {})))
                text_blocks += 1
            pending.clear()

        for part in rich_text:
            if part["type"] != "drawing":
                pending.append(part)
                continue
            flush_text()
            drawing = part["element"]
            doc_pr = drawing.find(".//{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}docPr")
            alt = (doc_pr.get("descr") or doc_pr.get("title") or "")[:1000] if doc_pr is not None else ""
            for blip in drawing.findall(".//{http://schemas.openxmlformats.org/drawingml/2006/main}blip"):
                rel_id = blip.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed")
                image = images.get(rel_id)
                asset_id = image.get("assetId") if image else None
                if image and not asset_id:
                    asset_id = transferred.add(image["bytes"], image["contentType"])
                    image["assetId"] = asset_id
                if asset_id:
                    if not any(a["id"] == asset_id for a in assets):
                        assets.append({"id": asset_id, "role": "illustration", "caption": image["filename"]})
                    current["nodes"].append(node("image", assetId=asset_id, altText=alt))
                else:
                    warnings.append("An unsupported or external embedded image remains in the original DOCX; upload a PNG, JPEG, GIF or WebP replacement.")
                    current["nodes"].append(node("caption", alt or "[Embedded illustration — retained in original DOCX]"))
        flush_text()


    if not chapters:
        raise ParseError("DOCX contains no readable paragraphs")

    book = make_book(chapters, assets, title=title)
    report = make_report(chapters, list(dict.fromkeys(warnings)), image_count=len(assets))
    return book, report
