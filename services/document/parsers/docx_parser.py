"""DOCX parser: paragraphs/headings -> Book Model nodes, images -> asset refs,
chapter split on Heading 1. Spec section 13."""
import io
import zipfile

from docx import Document

from . import (ParseError, check_size, make_book, make_report, new_chapter,
               node, safe_zip_members)

_HEADING_LEVELS = {f"Heading {i}": i for i in range(1, 7)}


def _extract_images(doc) -> tuple[dict[str, dict], list[str]]:
    """Map docx rel id -> generated asset entry; extract image bytes for later upload."""
    warnings: list[str] = []
    images: dict[str, dict] = {}
    for rel_id, rel in doc.part.rels.items():
        if "image" not in rel.reltype:
            continue
        try:
            part = rel.target_part
            ext = part.partname.ext or ".bin"
            images[rel_id] = {
                "filename": f"image-{len(images) + 1}{ext}",
                "contentType": part.content_type,
                "bytes": part.blob,
            }
        except Exception:
            warnings.append(f"image rel {rel_id} could not be extracted")
    return images, warnings


def parse_docx(data: bytes, title: str = "Untitled") -> tuple[dict, dict]:
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
    used_images: set[str] = set()

    for para in doc.paragraphs:
        style = para.style.name if para.style else ""
        level = _HEADING_LEVELS.get(style)
        if level == 1:
            current = new_chapter(para.text.strip() or f"Chapter {len(chapters) + 1}", len(chapters))
            chapters.append(current)
            current["nodes"].append(node("heading", para.text, level=1))
            continue
        if current is None:
            # content before the first Heading 1
            current = new_chapter(title, 0)
            chapters.append(current)

        text = para.text
        # images embedded in this paragraph's runs
        for blip in para._p.findall(
                ".//{http://schemas.openxmlformats.org/drawingml/2006/main}blip"):
            rel_id = blip.get(
                "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed")
            if rel_id and rel_id in images:
                asset_id = images[rel_id].setdefault("assetId")
                if asset_id is None:
                    import uuid
                    asset_id = images[rel_id]["assetId"] = str(uuid.uuid4())
                    assets.append({"id": asset_id, "role": "illustration",
                                   "caption": images[rel_id]["filename"]})
                    used_images.add(rel_id)
                current["nodes"].append(node("image", assetId=asset_id))

        if not text.strip():
            continue
        if level:
            current["nodes"].append(node("heading", text, level=level))
        elif style.lower().startswith("quote") or style.lower().startswith("block"):
            current["nodes"].append(node("quote", text))
        elif style.lower().startswith("list"):
            current["nodes"].append(node("listItem", text,
                                         attributes={"listStyle": style}))
        else:
            current["nodes"].append(node("paragraph", text))

    if not chapters:
        raise ParseError("DOCX contains no readable paragraphs")

    book = make_book(chapters, assets, title=title)
    report = make_report(chapters, warnings, image_count=len(used_images))
    return book, report
