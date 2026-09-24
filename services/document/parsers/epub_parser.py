"""EPUB importer: sandboxed unzip (zip-slip + size caps) -> OPF spine order ->
XHTML chapters -> Book Model nodes. Spec section 13."""
import io
import posixpath
import re
import zipfile
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET

from bs4 import BeautifulSoup, Comment, NavigableString

from . import (ParseError, check_size, make_book, make_report, new_chapter,
               node, safe_zip_members)
from .embedded_images import EmbeddedImages, EXTENSIONS

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


def _xhtml_to_nodes(soup: BeautifulSoup, *, _nesting=0, image_node=None) -> list[dict]:
    """Walk once in reading order; never flatten a parent and its children twice."""
    nodes: list[dict] = []
    marks_by_tag = {"b": "bold", "strong": "bold", "i": "italic", "em": "italic",
                    "u": "underline", "s": "strike", "del": "strike", "code": "code"}
    containers = {"body", "div", "section", "article", "main", "header", "footer",
                  "figure", "aside", "ul", "ol", "table", "tbody", "thead", "tr", "td", "th"}

    def walk(el, kind="paragraph", attrs=None, nesting=0):
        if nesting > 128:
            raise ParseError("EPUB markup nesting exceeds safe import limit")
        attrs = dict(attrs or {})
        runs = []

        def flush():
            while runs and runs[0]["type"] == "text" and not runs[0]["text"].lstrip():
                runs.pop(0)
            if runs and runs[0]["type"] == "text":
                runs[0]["text"] = runs[0]["text"].lstrip()
            if runs and runs[-1]["type"] == "text":
                runs[-1]["text"] = runs[-1]["text"].rstrip()
                if not runs[-1]["text"]:
                    runs.pop()
            text = "".join("\n" if r["type"] == "hardBreak" else r["text"] for r in runs)
            if text.strip():
                level = {"level": int(el.name[1])} if kind == "heading" else {}
                nodes.append(node(kind, text, **level, attributes={**attrs, "richText": list(runs)}))
            runs.clear()

        def visit(child, marks=(), level=0):
            if nesting + level > 128:
                raise ParseError("EPUB markup nesting exceeds safe import limit")
            if isinstance(child, Comment):
                return
            if isinstance(child, NavigableString):
                text = re.sub(r"[\t\r\n ]+", " ", str(child))
                if runs and (runs[-1]["type"] == "hardBreak" or runs[-1].get("text", "").endswith(" ")):
                    text = text.lstrip(" ")
                if text:
                    runs.append({"type": "text", "text": text,
                                 **({"marks": [{"type": m} for m in sorted(set(marks))]} if marks else {})})
                return
            tag = child.name
            if tag in {"script", "style", "noscript", "template", "head", "nav"} or child.has_attr("hidden"):
                return
            if tag == "br":
                runs.append({"type": "hardBreak"})
            elif tag == "li":
                flush()
                parent_list = child.find_parent(["ol", "ul"])
                list_depth = len(child.find_parents(["ol", "ul"])) - 1
                walk(child, "listItem", {"listStyle": "ordered" if parent_list and parent_list.name == "ol" else "bullet",
                                         "listDepth": min(6, max(0, list_depth))}, nesting + level + 1)
            elif tag == "table":
                flush()
                caption = child.find("caption", recursive=False)
                if caption:
                    walk(caption, "caption", nesting=nesting + level + 1)
                rows = []
                header_rows = 0
                for row in child.find_all("tr"):
                    if row.find_parent("table") is not child:
                        continue
                    cells = []
                    source_cells = row.find_all(["td", "th"], recursive=False)
                    for cell in source_cells:
                        # Reuse the same safe walker; no scripts, links or source HTML.
                        cell_nodes = _xhtml_to_nodes(cell, _nesting=nesting + level + 1, image_node=image_node)
                        cells.append("\n".join(n.get("text", "") for n in cell_nodes))
                    if cells:
                        head = row.find_parent("thead")
                        if header_rows == len(rows) and ((head is not None and head.find_parent("table") is child) or all(cell.name == "th" and cell.get("scope") != "row" for cell in source_cells)):
                            header_rows += 1
                        rows.append(cells)
                if rows:
                    nodes.append(node("table", "\n".join("\t".join(r) for r in rows), rows=rows,
                                      **({"attributes": {"tableHeaderRows": header_rows}} if header_rows else {})))
            elif tag in _TAG_BLOCK or tag in containers or tag == "figcaption":
                # Paragraphs within a list item are its own text, not new bullets.
                if tag == "p" and kind == "listItem":
                    if runs:
                        runs.append({"type": "hardBreak"})
                    for item in child.children:
                        visit(item, marks, level + 1)
                    return
                flush()
                child_kind = "quote" if tag == "blockquote" or (kind == "quote" and tag == "p") else _TAG_BLOCK.get(tag, "caption" if tag == "figcaption" else "paragraph")
                walk(child, child_kind, nesting=nesting + level + 1)
            elif tag in {"img", "image"}:
                # Preserve a visible placement without fetching untrusted URLs.
                flush()
                nodes.append(image_node(child) if image_node else node("caption", child.get("alt") or "[Embedded illustration — retained in original EPUB]",
                                  attributes={"importedNodeType": "image"}))
            elif tag == "hr":
                flush()
                nodes.append(node("pageBreak" if "page-break" in child.get("class", []) else "separator"))
            else:
                next_marks = (*marks, marks_by_tag[tag]) if tag in marks_by_tag else marks
                for item in child.children:
                    visit(item, next_marks, level + 1)

        for child in el.children:
            visit(child)
        flush()

    walk(soup.body or soup, nesting=_nesting)
    return nodes


def parse_epub(data: bytes, title: str = "Untitled", *, embedded_assets: list[dict] | None = None) -> tuple[dict, dict]:
    check_size(data)
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ParseError("not a valid EPUB (bad zip)") from e

    warnings: list[str] = []
    transferred = EmbeddedImages(embedded_assets)
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
            def image_node(el):
                source = el.get("src") or el.get("href") or el.get("xlink:href") or ""
                parsed = urlsplit(source)
                image_path = posixpath.normpath(posixpath.join(posixpath.dirname(path), unquote(parsed.path)))
                alt = (el.get("alt") or "")[:1000]
                asset_id = None
                if source and not parsed.scheme and not parsed.netloc and not parsed.query and not image_path.startswith(("/", "../")):
                    ext = posixpath.splitext(image_path)[1].lower().lstrip(".")
                    mime = next((m for m, extension in EXTENSIONS.items() if ext == extension or (m == "image/jpeg" and ext == "jpeg")), "")
                    if mime:
                        try:
                            asset_id = transferred.add(zf.read(image_path), mime)
                        except KeyError:
                            pass
                if asset_id:
                    return node("image", assetId=asset_id, altText=alt,
                                attributes={"decorative": el.has_attr("alt") and not alt})
                warnings.append("An external, missing or unsupported EPUB image remains in the original; upload a PNG, JPEG, GIF or WebP replacement.")
                return node("caption", alt or "[Embedded illustration — retained in original EPUB]",
                            attributes={"importedNodeType": "image"})

            nodes = _xhtml_to_nodes(soup, image_node=image_node)
            if soup.find("table"):
                warnings.append(f"Table text, row order and any explicit header rows in {href} were preserved; merged-cell layout and cell formatting require review against the original.")
            if not nodes:
                continue
            # chapter title from first h1/h2, else filename
            heading = next((n for n in nodes if n["type"] == "heading" and n.get("level", 6) <= 2), None)
            ch_title = (heading["text"] if heading else posixpath.basename(href))[:200]
            chapters.append(new_chapter(ch_title, len(chapters)))
            chapters[-1]["nodes"] = nodes

    if not chapters:
        raise ParseError("EPUB contained no parseable content")
    assets = [{"id": entry["id"], "role": "illustration", "caption": entry["filename"]} for entry in transferred.output]
    book = make_book(chapters, assets, title=title)
    return book, make_report(chapters, list(dict.fromkeys(warnings)), image_count=len(assets))
