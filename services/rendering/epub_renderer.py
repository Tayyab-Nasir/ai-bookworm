"""Book Model JSON -> deterministic EPUB3 (stdlib zipfile only).

Determinism: fixed zip entry order, fixed SOURCE_DATE_EPOCH timestamp, sorted attrs,
no cover bytes unless provided (callers pass cover_bytes to keep it pure).
Same (book_model, edition, RENDERER_VERSION) input -> same sha256.
"""
import hashlib
import zipfile
from io import BytesIO
from html import escape

from editions import EbookEdition, resolve_text_direction
from manuscript import block_tree, image_width, inline_markup, table_rows

RENDERER_VERSION = "epub-1.8.0"
SOURCE_DATE_EPOCH = (1980, 1, 1, 0, 0, 0)  # zip epoch minimum; fixed for reproducibility

_OEBPS = "OEBPS"

_CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""

_CSS = "body{font-family:serif;line-height:1.5}h1,h2,h3,h4,h5,h6{break-after:avoid}figure{text-align:center;margin:1.5em 0;break-inside:avoid}img{height:auto;max-width:100%}figcaption,.caption{font-size:.9em;font-style:italic}blockquote{margin:1em 2em}.page-break{break-before:page;border:0}code{font-family:monospace}.cover{margin:0;text-align:center}"
_CSS += "table{border-collapse:collapse;width:100%;margin:1em 0}td{border:1px solid #777;padding:.4em;vertical-align:top;overflow-wrap:anywhere}"
_CSS += 'html[dir="rtl"] body{text-align:right}html[dir="rtl"] .cover{text-align:center}'


def _slug(chapter_id: str, index: int) -> str:
    return f"ch{index:04d}"  # deterministic, order-based; ids are uuids anyway


def _node_html(node: dict, image_ids: set[str] | None = None) -> str:
    t = node.get("type")
    text = inline_markup(node)
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
        if asset and (image_ids is None or asset in image_ids):
            decorative = (node.get("attributes") or {}).get("decorative") is True
            alt = "" if decorative else escape(node.get("altText") or node.get("caption") or "")
            caption = f'<figcaption>{escape(node["caption"])}</figcaption>' if node.get("caption") else ""
            return f'<figure><img alt="{alt}" src="images/{escape(asset)}.png" style="width:{image_width(node)}%"/>{caption}</figure>'
        description = escape(node.get("caption") or node.get("altText") or "")
        return f'<p class="caption">{description}</p>' if description else ""
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
            "<tr>" + "".join("<td>" + escape(str(c)).replace("\n", "<br/>") + "</td>" for c in r) + "</tr>"
            for r in table_rows(node))
        return f"<table>{rows}</table>" if rows else f"<p>{text}</p>"
    return f"<p>{text}</p>" if text else ""


def _chapter_xhtml(book: dict, chapter: dict, lang: str, direction: str, image_ids: set[str] | None = None) -> str:
    def block_html(block):
        if "node" in block:
            return _node_html(block["node"], image_ids)
        tag = "ol" if block["style"] == "ordered" else "ul"
        items = "".join("<li>" + inline_markup(item["node"]) + "".join(block_html(child) for child in item["children"]) + "</li>" for item in block["items"])
        return f"<{tag}>{items}</{tag}>"
    body = "".join(block_html(block) for block in block_tree(chapter.get("nodes", [])))
    lang = escape(lang)
    title = escape(chapter.get("title") or "")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE html>\n'
        f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{lang}" lang="{lang}" dir="{direction}">\n'
        f'<head><title>{title}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n'
        f"<body>{body}</body></html>"
    )


def _nav_xhtml(book: dict, chapters: list[tuple[str, dict]], lang: str, direction: str,
               edition: EbookEdition, has_cover: bool) -> str:
    lang = escape(lang)
    lis = "".join(
        f'<li><a href="{slug}.xhtml">{escape(ch.get("title") or slug)}</a></li>'
        for slug, ch in chapters)
    title = escape(edition.metadata_overrides.get("title", book["metadata"]["title"]))
    landmarks = ""
    if edition.navigation == "toc+landmarks":
        links = [("toc", "nav.xhtml#toc", "Contents")]
        if has_cover:
            links.insert(0, ("cover", "cover.xhtml", "Cover"))
        for slug, _ in _front_pages(book, edition):
            links.append(("titlepage" if slug == "title-page" else "copyright-page", f"{slug}.xhtml",
                          "Title page" if slug == "title-page" else "Copyright"))
        if chapters:
            links.append(("bodymatter", f"{chapters[0][0]}.xhtml", chapters[0][1].get("title") or "Start reading"))
        items = "".join(f'<li><a epub:type="{kind}" href="{href}">{escape(label)}</a></li>' for kind, href, label in links)
        landmarks = f'<nav epub:type="landmarks" id="landmarks" hidden="hidden"><h2>Guide</h2><ol>{items}</ol></nav>'
    hidden = ' hidden="hidden"' if edition.navigation == "none" else ""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE html>\n'
        f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{lang}" lang="{lang}" dir="{direction}">\n'
        f'<head><title>{title} — Contents</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n'
        f'<body><nav epub:type="toc" id="toc"{hidden}><h1>{title} — Contents</h1><ol>{lis}</ol></nav>{landmarks}</body></html>'
    )


def _cover_xhtml(asset_id: str, title: str, lang: str, direction: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE html>\n'
        f'<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="{escape(lang)}" lang="{escape(lang)}" dir="{direction}">\n'
        f'<head><title>{escape(title)} — Cover</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n'
        f'<body class="cover"><img alt="Cover of {escape(title)}" src="images/{escape(asset_id)}.png"/></body></html>'
    )


def _opf(book: dict, edition: EbookEdition, chapters: list[tuple[str, dict]], lang: str,
         cover_asset_id: str | None, image_asset_ids: list[str]) -> str:
    md = dict(book["metadata"])
    md.update(edition.metadata_overrides)  # edition-level overrides win
    uid = f"urn:uuid:{book['bookId']}"
    manifest_items = [
        '<item href="nav.xhtml" id="nav" media-type="application/xhtml+xml" properties="nav"/>',
        '<item href="style.css" id="css" media-type="text/css"/>',
    ]
    manifest_items += [
        f'<item href="{slug}.xhtml" id="{slug}" media-type="application/xhtml+xml"/>'
        for slug, _ in _front_pages(book, edition)]
    manifest_items += [
        f'<item href="{slug}.xhtml" id="{slug}" media-type="application/xhtml+xml"/>'
        for slug, _ in chapters]
    if cover_asset_id:
        manifest_items += [
            f'<item href="images/{escape(cover_asset_id)}.png" id="cover-image" media-type="image/png" properties="cover-image"/>',
            '<item href="cover.xhtml" id="cover-page" media-type="application/xhtml+xml"/>',
        ]
    manifest_items += [
        f'<item href="images/{escape(asset_id)}.png" id="image-{escape(asset_id)}" media-type="image/png"/>'
        for asset_id in image_asset_ids if asset_id != cover_asset_id
    ]
    spine = ('<itemref idref="cover-page"/>' if cover_asset_id else "") + "".join(
        f'<itemref idref="{slug}"/>' for slug, _ in _front_pages(book, edition)) + (
        '<itemref idref="nav"/>' if edition.navigation != "none" else "") + "".join(
        f'<itemref idref="{slug}"/>' for slug, _ in chapters)
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
    if edition.front_matter.publisher.strip():
        meta.append(f"<dc:publisher>{escape(edition.front_matter.publisher)}</dc:publisher>")
    if edition.front_matter.copyright_notice.strip():
        meta.append(f"<dc:rights>{escape(edition.front_matter.copyright_notice)}</dc:rights>")
    for kw in sorted(md.get("keywords") or []):
        meta.append(f"<dc:subject>{escape(kw)}</dc:subject>")
    if md.get("isbn13"):
        meta.append(f"<dc:identifier>{escape(str(md['isbn13']))}</dc:identifier>")
    if cover_asset_id:
        meta.append('<meta name="cover" content="cover-image"/>')
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" prefix="bookworm: urn:bookworm:metadata:">\n'
        f'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">{"".join(meta)}</metadata>\n'
        f"<manifest>{''.join(manifest_items)}</manifest>\n"
        f"<spine>{spine}</spine>\n</package>"
    )


def _front_pages(book: dict, edition: EbookEdition) -> list[tuple[str, list[str]]]:
    md = {**book["metadata"], **edition.metadata_overrides}
    pages = [("title-page", [md.get(key) or "" for key in ("title", "subtitle", "author")])] if edition.include_title_page else []
    front = edition.front_matter
    if front.copyright_notice.strip() or front.publisher.strip():
        pages.append(("copyright-page", [front.copyright_notice, front.publisher,
                      f"ISBN: {md['isbn13']}" if md.get("isbn13") else ""]))
    return pages


def render_epub(book: dict, edition: EbookEdition, cover_bytes: bytes | None = None,
                image_bytes: dict[str, bytes] | None = None) -> tuple[bytes, str]:
    """Render to EPUB3. Returns (zip_bytes, sha256_hex). Pure/deterministic."""
    if edition.flow == "fixed":
        from fixed_epub import render_fixed_epub
        return render_fixed_epub(book, edition, cover_bytes, image_bytes)
    lang = book["metadata"].get("language") or "en"
    direction = resolve_text_direction(lang, edition.text_direction)
    chapters = [
        (_slug(ch["id"], i), ch)
        for i, ch in enumerate(sorted(book["chapters"], key=lambda c: c["order"]))
    ]

    # fixed entry order: mimetype first (stored), then container, then sorted OEBPS files
    entries: list[tuple[str, bytes, bool]] = [("mimetype", b"application/epub+zip", True)]
    entries.append(("META-INF/container.xml", _CONTAINER_XML.encode(), False))
    cover_asset_id = edition.cover.asset_id if cover_bytes and edition.cover.asset_id else None
    embedded_images = sorted((image_bytes or {}).items())
    entries.append((f"{_OEBPS}/content.opf", _opf(book, edition, chapters, lang, cover_asset_id, [item[0] for item in embedded_images]).encode(), False))
    entries.append((f"{_OEBPS}/nav.xhtml", _nav_xhtml(book, chapters, lang, direction, edition, bool(cover_asset_id)).encode(), False))
    entries.append((f"{_OEBPS}/style.css", _CSS.encode(), False))
    for slug, lines in _front_pages(book, edition):
        body = "".join(f"<p>{escape(line).replace(chr(10), '<br/>')}</p>" for line in lines if line.strip())
        semantic = "titlepage" if slug == "title-page" else "copyright-page"
        document = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{escape(lang)}" lang="{escape(lang)}" dir="{direction}">'
            f'<head><title>{"Title page" if slug == "title-page" else "Copyright"}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>'
            f'<body epub:type="{semantic}">{body}</body></html>')
        entries.append((f"{_OEBPS}/{slug}.xhtml", document.encode(), False))
    for slug, ch in chapters:
        entries.append((f"{_OEBPS}/{slug}.xhtml", _chapter_xhtml(book, ch, lang, direction, set(image_bytes or {}) | ({cover_asset_id} if cover_asset_id else set())).encode(), False))
    for asset_id, data in embedded_images:
        if asset_id != cover_asset_id:
            entries.append((f"{_OEBPS}/images/{asset_id}.png", data, False))
    if cover_asset_id and cover_bytes:
        entries.append((f"{_OEBPS}/cover.xhtml", _cover_xhtml(cover_asset_id, book["metadata"].get("title", ""), lang, direction).encode(), False))
        entries.append((f"{_OEBPS}/images/{cover_asset_id}.png", cover_bytes, False))

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data, stored in entries:
            info = zipfile.ZipInfo(name, date_time=SOURCE_DATE_EPOCH)
            info.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)
    blob = buf.getvalue()
    return blob, hashlib.sha256(blob).hexdigest()
