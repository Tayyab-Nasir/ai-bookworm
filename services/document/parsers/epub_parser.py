"""EPUB importer: sandboxed unzip (zip-slip + size caps) -> OPF spine order ->
XHTML chapters -> Book Model nodes. Spec section 13."""
import io
import posixpath
import zipfile
from xml.etree import ElementTree as ET

from bs4 import BeautifulSoup

from . import (ParseError, check_size, make_book, make_report, new_chapter,
               node, safe_zip_members)

_CONTAINER = "META-INF/container.xml"
_OPF_NS = "{http://www.idpf.org/2007/opf}"
_TAG_BLOCK = {"p": "paragraph", "blockquote": "quote",
              "h1": "heading", "h2": "heading", "h3": "heading",
              "h4": "heading", "h5": "heading", "h6": "heading",
              "li": "listItem"}


def _read_opf_path(zf: zipfile.ZipFile) -> str:
    try:
        root = ET.fromstring(zf.read(_CONTAINER))
    except (KeyError, ET.ParseError) as e:
        raise ParseError("not a valid EPUB (no container.xml)") from e
    rf = root.find(".//{*}rootfile")
    if rf is None or not rf.get("full-path"):
        raise ParseError("EPUB container has no rootfile")
    return rf.attrib["full-path"]


def _spine_hrefs(zf: zipfile.ZipFile, opf_path: str) -> tuple[list[str], dict[str, str]]:
    """Return ordered spine hrefs and id->href manifest map."""
    try:
        root = ET.fromstring(zf.read(opf_path))
    except (KeyError, ET.ParseError) as e:
        raise ParseError(f"cannot read OPF {opf_path}") from e
    manifest = {i.attrib["id"]: i.attrib["href"]
                for i in root.iter(f"{_OPF_NS}item") if "id" in i.attrib and "href" in i.attrib}
    hrefs = []
    for ref in root.iter(f"{_OPF_NS}itemref"):
        idref = ref.attrib.get("idref")
        if idref in manifest:
            hrefs.append(manifest[idref])
    if not hrefs:
        raise ParseError("EPUB spine is empty")
    return hrefs, manifest


def _xhtml_to_nodes(soup: BeautifulSoup) -> list[dict]:
    nodes: list[dict] = []
    for el in soup.find_all(list(_TAG_BLOCK)):
        text = el.get_text(" ", strip=True)
        if not text:
            continue
        type_ = _TAG_BLOCK[el.name]
        if type_ == "heading":
            nodes.append(node("heading", text, level=int(el.name[1])))
        else:
            nodes.append(node(type_, text))
    return nodes


def parse_epub(data: bytes, title: str = "Untitled") -> tuple[dict, dict]:
    check_size(data)
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ParseError("not a valid EPUB (bad zip)") from e

    warnings: list[str] = []
    with zf:
        safe_zip_members(zf)
        opf_path = _read_opf_path(zf)
        base = posixpath.dirname(opf_path)
        hrefs, _ = _spine_hrefs(zf, opf_path)

        # metadata (best effort)
        try:
            root = ET.fromstring(zf.read(opf_path))
            title_el = root.find(".//{http://purl.org/dc/elements/1.1/}title")
            if title_el is not None and title_el.text:
                title = title_el.text.strip() or title
        except Exception:
            warnings.append("could not read EPUB metadata title")

        chapters: list[dict] = []
        for href in hrefs:
            path = posixpath.normpath(posixpath.join(base, href))
            try:
                raw = zf.read(path)
            except KeyError:
                warnings.append(f"spine item missing: {href}")
                continue
            try:
                soup = BeautifulSoup(raw, "lxml")
            except Exception as e:
                warnings.append(f"could not parse {href}: {e}")
                continue
            nodes = _xhtml_to_nodes(soup)
            if not nodes:
                continue
            # chapter title from first h1/h2, else filename
            heading = next((n for n in nodes if n["type"] == "heading" and n.get("level", 6) <= 2), None)
            ch_title = (heading["text"] if heading else posixpath.basename(href))[:200]
            chapters.append(new_chapter(ch_title, len(chapters)))
            chapters[-1]["nodes"] = nodes

    if not chapters:
        raise ParseError("EPUB contained no parseable content")
    book = make_book(chapters, title=title)
    return book, make_report(chapters, warnings)
