"""Paginated, raster-page EPUB. Local Poppler only; no browser or network.

The page appearance follows the embedded-font PDF renderer. Text is supplied
as image alternatives, not selectable page text. This is not tagged/accessibility
certification. Reflowable EPUB remains preferable for ordinary text books.
"""
import hashlib
import os
import shutil
import subprocess
import tempfile
import time
import zipfile
from html import escape
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image
from pypdf import PdfReader

from editions import EbookEdition, PrintEdition, resolve_text_direction
from pdf_renderer import render_pdf

MAX_PAGES = 2000
MAX_BYTES = 150 * 1024 * 1024


def render_fixed_epub(book: dict, edition: EbookEdition, cover: bytes | None,
                      images: dict[str, bytes] | None) -> tuple[bytes, str]:
    from epub_renderer import _opf, _nav_xhtml, _CONTAINER_XML, SOURCE_DATE_EPOCH
    executable = shutil.which(os.environ.get("BOOKWORM_PDFTOPPM", "pdftoppm"))
    if not executable:
        raise ValueError("Fixed-layout EPUB requires local Poppler pdftoppm on the rendering worker.")
    model = {**book, "metadata": {**book["metadata"], **edition.metadata_overrides}}
    print_config = PrintEdition(text_direction=edition.text_direction,
        **edition.fixed_layout.model_dump(),
        front_matter=edition.front_matter, page_numbering={"style": "none"})
    pdf, _ = render_pdf(model, print_config, images, chapter_bookmarks=True)
    reader = PdfReader(BytesIO(pdf))
    if len(reader.pages) > MAX_PAGES:
        raise ValueError("Fixed-layout EPUB exceeds the 2000-page rendering limit.")
    skip = 0 if edition.include_title_page else 1
    offset = (1 if cover else 0) - skip
    chapters = [(f"page{reader.get_destination_page_number(item) + offset:04d}",
                 {"title": item.title}) for item in reader.outline]
    pages = []
    total = 0
    deadline = time.monotonic() + 120
    with tempfile.TemporaryDirectory(prefix="bookworm-fixed-") as directory:
        source = Path(directory) / "interior.pdf"
        source.write_bytes(pdf)
        if cover:
            pages.append((cover, f"Cover of {model['metadata'].get('title', '')}"))
            total += len(cover)
        for index in range(skip, len(reader.pages)):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError("Fixed-layout rasterization exceeded its 120-second limit.")
            try:
                result = subprocess.run([executable, "-f", str(index + 1), "-l", str(index + 1),
                    "-singlefile", "-scale-to", "1800", "-png", str(source)],
                    capture_output=True, timeout=remaining, check=False)
            except (OSError, subprocess.TimeoutExpired) as error:
                raise ValueError("Fixed-layout page conversion failed or timed out.") from error
            if result.returncode or not result.stdout.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("Fixed-layout page conversion returned an invalid image.")
            total += len(result.stdout)
            if total > MAX_BYTES:
                raise ValueError("Fixed-layout page images exceed the 150 MiB rendering limit.")
            pages.append((result.stdout, reader.pages[index].extract_text() or f"Book page {index + 1 - skip}"))
    lang = model["metadata"].get("language") or "en"
    direction = resolve_text_direction(lang, edition.text_direction)
    # Front matter already exists in the paginated interior, not separate XHTML.
    package_edition = edition.model_copy(update={"include_title_page": False,
        "front_matter": edition.front_matter.model_copy(update={"copyright_notice": "", "publisher": ""})})
    page_entries = [(f"page{index:04d}", {"title": f"Page {index + 1}"}) for index in range(len(pages))]
    opf = ET.fromstring(_opf(model, package_edition, page_entries, lang, None, [slug for slug, _ in page_entries]))
    ns = "{http://www.idpf.org/2007/opf}"
    ET.register_namespace("", ns[1:-1])
    ET.register_namespace("dc", "http://purl.org/dc/elements/1.1/")
    metadata = opf.find(ns + "metadata")
    for name, value in [("layout", "pre-paginated"), ("spread", "none"), ("orientation", "auto")]:
        ET.SubElement(metadata, ns + "meta", {"property": f"rendition:{name}"}).text = value
    for name, value in [("publisher", edition.front_matter.publisher), ("rights", edition.front_matter.copyright_notice)]:
        if value.strip():
            ET.SubElement(metadata, "{http://purl.org/dc/elements/1.1/}" + name).text = value
    for item in opf.find(ns + "spine"):
        if item.attrib.get("idref") == "nav":
            item.set("properties", "rendition:layout-reflowable")
            if chapters:
                spine = opf.find(ns + "spine")
                spine.remove(item)
                target = next(i for i, entry in enumerate(spine) if entry.attrib.get("idref") == chapters[0][0])
                spine.insert(target, item)
            break
    if cover:
        for item in opf.find(ns + "manifest"):
            if item.attrib.get("id") == "image-page0000":
                item.set("properties", "cover-image")
    nav = _nav_xhtml(model, chapters, lang, direction, package_edition, False)
    if edition.navigation == "toc+landmarks":
        front_links = []
        if cover:
            front_links.append('<li><a epub:type="cover" href="page0000.xhtml">Cover</a></li>')
        if edition.include_title_page:
            front_links.append(f'<li><a epub:type="titlepage" href="page{int(bool(cover)):04d}.xhtml">Title page</a></li>')
        if edition.front_matter.copyright_notice.strip() or edition.front_matter.publisher.strip():
            front_links.append(f'<li><a epub:type="copyright-page" href="page{int(bool(cover)) + int(edition.include_title_page):04d}.xhtml">Copyright</a></li>')
        nav = nav.replace('</ol></nav></body>', ''.join(front_links) + '</ol></nav></body>')
    entries = [("mimetype", b"application/epub+zip"), ("META-INF/container.xml", _CONTAINER_XML.encode()),
               ("OEBPS/content.opf", ET.tostring(opf, encoding="utf-8", xml_declaration=True)),
               ("OEBPS/nav.xhtml", nav.encode()), ("OEBPS/style.css", b"body{font-family:serif;line-height:1.5}")]
    for (slug, _), (png, alternative) in zip(page_entries, pages):
        with Image.open(BytesIO(png)) as image:
            width, height = image.size
        page = (f'<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="{escape(lang)}" lang="{escape(lang)}" dir="{direction}">'
                f'<head><title>{slug}</title><meta name="viewport" content="width={width}, height={height}"/>'
                '<style>html,body{margin:0;padding:0}img{display:block;width:100%;height:100%}</style></head>'
                f'<body><img src="images/{slug}.png" width="{width}" height="{height}" alt="{escape(alternative)}"/></body></html>')
        entries.extend([(f"OEBPS/{slug}.xhtml", page.encode()), (f"OEBPS/images/{slug}.png", png)])
    output = BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=SOURCE_DATE_EPOCH)
            info.compress_type = zipfile.ZIP_STORED if name == "mimetype" else zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)
    blob = output.getvalue()
    return blob, hashlib.sha256(blob).hexdigest()
