"""Book Model JSON -> deterministic EPUB3 (stdlib zipfile only).

Determinism: fixed zip entry order, fixed SOURCE_DATE_EPOCH timestamp, sorted attrs,
no cover bytes unless provided (callers pass cover_bytes to keep it pure).
Same (book_model, edition, RENDERER_VERSION) input -> same sha256.
"""
import hashlib
import zipfile
from io import BytesIO
from xml.sax.saxutils import escape

from editions import EbookEdition

RENDERER_VERSION = "epub-1.0.0"
SOURCE_DATE_EPOCH = (1980, 1, 1, 0, 0, 0)  # zip epoch minimum; fixed for reproducibility

_OEBPS = "OEBPS"

_CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""

_CSS = "body{font-family:serif;line-height:1.5}h1,h2{page-break-before:always}"


def _slug(chapter_id: str, index: int) -> str:
    return f"ch{index:04d}"  # deterministic, order-based; ids are uuids anyway


def _node_html(node: dict) -> str:
    t = node.get("type")
    text = escape(node.get("text") or "")
    if t == "heading":
        level = min(max(int(node.get("level") or 1), 1), 6)
        return f"<h{level}>{text}</h{level}>"
    if t == "paragraph":
        return f"<p>{text}</p>"
    if t == "quote":
        return f"<blockquote><p>{text}</p></blockquote>"
    if t == "list":
        items = "".join(f"<li>{escape(c)}</li>" for c in node.get("items", []) or [])
        return f"<ul>{items}</ul>" if items else f"<p>{text}</p>"
    if t == "image":
        asset = node.get("assetId")
        if asset:
            alt = escape(node.get("altText") or node.get("caption") or "")
            return f'<figure><img alt="{alt}" src="images/{asset}.png"/></figure>'
        return ""
    if t == "caption":
        return f'<p class="caption">{text}</p>'
    if t == "pageBreak":
        return '<hr class="page-break"/>'
    if t == "separator":
        return "<hr/>"
    if t == "footnote":
        return f'<aside epub:type="footnote"><p>{text}</p></aside>'
    if t == "table":
        rows = "".join(
            "<tr>" + "".join(f"<td>{escape(str(c))}</td>" for c in r) + "</tr>"
            for r in node.get("rows", []) or [])
        return f"<table>{rows}</table>" if rows else f"<p>{text}</p>"
    return f"<p>{text}</p>" if text else ""


def _chapter_xhtml(book: dict, chapter: dict, lang: str) -> str:
    body = "".join(_node_html(n) for n in chapter.get("nodes", []))
    title = escape(chapter.get("title") or "")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE html>\n'
        f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{lang}" lang="{lang}">\n'
        f'<head><title>{title}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n'
        f"<body>{body}</body></html>"
    )


def _nav_xhtml(book: dict, chapters: list[tuple[str, dict]], lang: str) -> str:
    lis = "".join(
        f'<li><a href="{slug}.xhtml">{escape(ch.get("title") or slug)}</a></li>'
        for slug, ch in chapters)
    title = escape(book["metadata"]["title"])
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE html>\n'
        f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{lang}" lang="{lang}">\n'
        f'<head><title>{title} — Contents</title></head>\n'
        f'<body><nav epub:type="toc" id="toc"><h1>{title}</h1><ol>{lis}</ol></nav></body></html>'
    )


def _opf(book: dict, edition: EbookEdition, chapters: list[tuple[str, dict]], lang: str) -> str:
    md = dict(book["metadata"])
    md.update(edition.metadata_overrides)  # edition-level overrides win
    uid = f"urn:uuid:{book['bookId']}"
    manifest_items = [
        '<item href="nav.xhtml" id="nav" media-type="application/xhtml+xml" properties="nav"/>',
        '<item href="style.css" id="css" media-type="text/css"/>',
    ]
    manifest_items += [
        f'<item href="{slug}.xhtml" id="{slug}" media-type="application/xhtml+xml"/>'
        for slug, _ in chapters]
    spine = "".join(f'<itemref idref="{slug}"/>' for slug, _ in chapters)
    meta = [
        f'<dc:identifier id="pub-id">{uid}</dc:identifier>',
        f"<dc:title>{escape(md.get('title', ''))}</dc:title>",
        f"<dc:creator>{escape(md.get('author', ''))}</dc:creator>",
        f"<dc:language>{escape(lang)}</dc:language>",
        '<meta property="dcterms:modified">1980-01-01T00:00:00Z</meta>',
        f'<meta property="bookworm:renderer">{RENDERER_VERSION}</meta>',
    ]
    if md.get("description"):
        meta.append(f"<dc:description>{escape(md['description'])}</dc:description>")
    for kw in sorted(md.get("keywords") or []):
        meta.append(f"<dc:subject>{escape(kw)}</dc:subject>")
    if md.get("isbn13"):
        meta.append(f"<dc:identifier>{escape(str(md['isbn13']))}</dc:identifier>")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">\n'
        f'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">{"".join(meta)}</metadata>\n'
        f"<manifest>{''.join(manifest_items)}</manifest>\n"
        f"<spine>{spine}</spine>\n</package>"
    )


def render_epub(book: dict, edition: EbookEdition, cover_bytes: bytes | None = None) -> tuple[bytes, str]:
    """Render to EPUB3. Returns (zip_bytes, sha256_hex). Pure/deterministic."""
    lang = book["metadata"].get("language") or "en"
    chapters = [
        (_slug(ch["id"], i), ch)
        for i, ch in enumerate(sorted(book["chapters"], key=lambda c: c["order"]))
    ]

    # fixed entry order: mimetype first (stored), then container, then sorted OEBPS files
    entries: list[tuple[str, bytes, bool]] = [("mimetype", b"application/epub+zip", True)]
    entries.append(("META-INF/container.xml", _CONTAINER_XML.encode(), False))
    entries.append((f"{_OEBPS}/content.opf", _opf(book, edition, chapters, lang).encode(), False))
    entries.append((f"{_OEBPS}/nav.xhtml", _nav_xhtml(book, chapters, lang).encode(), False))
    entries.append((f"{_OEBPS}/style.css", _CSS.encode(), False))
    for slug, ch in chapters:
        entries.append((f"{_OEBPS}/{slug}.xhtml", _chapter_xhtml(book, ch, lang).encode(), False))
    if cover_bytes and edition.cover.asset_id:
        entries.append((f"{_OEBPS}/images/{edition.cover.asset_id}.png", cover_bytes, False))

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data, stored in entries:
            info = zipfile.ZipInfo(name, date_time=SOURCE_DATE_EPOCH)
            info.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)
    blob = buf.getvalue()
    return blob, hashlib.sha256(blob).hexdigest()
