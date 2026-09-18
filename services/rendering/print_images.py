"""Print-specific illustration validation shared by rendering and preflight."""
from io import BytesIO

from PIL import Image, UnidentifiedImageError

from manuscript import image_print_placement

PRINT_DPI = 300


def full_bleed_issues(book: dict, edition, image_bytes: dict[str, bytes]) -> list[dict[str, str]]:
    if getattr(edition, "kind", None) != "print":
        return []
    page_width = edition.trim_in[0] + edition.bleed_in + (edition.bleed_in if edition.bleed_edges == "all" else 0)
    page_height = edition.trim_in[1] + 2 * edition.bleed_in
    required_width = round(page_width * PRINT_DPI)
    required_height = round(page_height * PRINT_DPI)
    issues = []
    for chapter in book.get("chapters", []):
        for node in chapter.get("nodes", []):
            if node.get("type") != "image" or image_print_placement(node) != "fullBleed":
                continue
            location = f"chapter:{chapter.get('id', '')} node:{node.get('id', '')}"
            if edition.bleed_in <= 0:
                issues.append({"code": "PRINT_FULL_BLEED_DISABLED",
                               "message": "Full-bleed artwork requires a print edition with bleed enabled.",
                               "location": location})
                continue
            asset_id = node.get("assetId")
            data = image_bytes.get(asset_id) if isinstance(asset_id, str) else None
            if not data:
                issues.append({"code": "PRINT_FULL_BLEED_IMAGE_MISSING",
                               "message": "Full-bleed artwork bytes are missing from this render.",
                               "location": location})
                continue
            try:
                with Image.open(BytesIO(data)) as image:
                    width, height = image.size
            except (UnidentifiedImageError, OSError, ValueError):
                issues.append({"code": "PRINT_FULL_BLEED_IMAGE_INVALID",
                               "message": "Full-bleed artwork is not a supported raster image.",
                               "location": location})
                continue
            if width < required_width or height < required_height:
                issues.append({"code": "PRINT_FULL_BLEED_RESOLUTION",
                               "message": f"Full-bleed artwork needs at least {required_width} x {required_height} pixels for this trim at {PRINT_DPI} DPI; received {width} x {height}.",
                               "location": location})
    return issues
