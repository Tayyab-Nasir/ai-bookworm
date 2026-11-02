"""Bounded structural checks for an EPUB navigation document.

These checks do not replace EPUBCheck or retailer validation.
"""
from xml.parsers import expat

MAX_NAV_BYTES = 8 * 1024 * 1024
MAX_NAV_ELEMENTS = 100_000
MAX_NAV_DEPTH = 128
_XHTML = "http://www.w3.org/1999/xhtml|"
_EPUB_TYPE = "http://www.idpf.org/2007/ops|type"
_EMBEDDED = {_XHTML + name for name in ("img", "audio", "video", "canvas", "object", "iframe", "embed")}
_EMBEDDED.update({"http://www.w3.org/2000/svg|svg", "http://www.w3.org/1998/Math/MathML|math"})


class _InvalidNavigation(ValueError):
    pass


class _NavigationLimit(ValueError):
    pass


def inspect_navigation(stream, size: int) -> str | None:
    """Return a stable finding code, or None when these checks pass."""
    if size < 0 or size > MAX_NAV_BYTES:
        return "NAV_LIMIT"
    parser = expat.ParserCreate(namespace_separator="|")
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    stack: list[str] = []
    frames: list[dict] = []
    toc_depth: int | None = None
    label_depth: int | None = None
    toc_count = 0
    elements = 0
    invalid_toc = False

    def start(name, attrs):
        nonlocal toc_depth, label_depth, toc_count, elements, invalid_toc
        elements += 1
        if elements > MAX_NAV_ELEMENTS or len(stack) >= MAX_NAV_DEPTH:
            raise _NavigationLimit("limit")
        if not stack and name != _XHTML + "html":
            raise _InvalidNavigation("root")
        frame: dict = {"kind": "other"}
        if name == _XHTML + "nav" and "toc" in attrs.get(_EPUB_TYPE, "").split():
            if _XHTML + "body" not in stack or toc_depth is not None:
                raise _InvalidNavigation("toc")
            toc_count += 1
            toc_depth = len(stack)
            frame = {"kind": "nav", "children": []}
        elif toc_depth is not None:
            parent = frames[-1]
            kind = parent["kind"]
            if kind in ("nav", "li"):
                parent["children"].append(name)
            if kind == "ol":
                if name != _XHTML + "li":
                    invalid_toc = True
                else:
                    parent["count"] += 1
            if name == _XHTML + "ol" and kind in ("nav", "li"):
                frame = {"kind": "ol", "count": 0}
            elif name == _XHTML + "li" and kind == "ol":
                frame = {"kind": "li", "children": []}
            elif name in (_XHTML + "a", _XHTML + "span") and kind == "li":
                frame = {"kind": "label", "has_text": False, "has_embedded": False,
                         "title": attrs.get("title", ""), "href": attrs.get("href", "")}
                label_depth = len(stack)
            elif label_depth is not None and name in _EMBEDDED:
                frames[label_depth]["has_embedded"] = True
                if attrs.get("alt", "").strip() or attrs.get("title", "").strip():
                    frames[label_depth]["has_text"] = True
        stack.append(name)
        frames.append(frame)

    def end(name):
        nonlocal toc_depth, label_depth, invalid_toc
        depth = len(stack) - 1
        frame = frames[-1]
        if frame["kind"] == "ol" and frame["count"] < 1:
            invalid_toc = True
        elif frame["kind"] == "li":
            children = frame["children"]
            valid = children == [_XHTML + "a"] or children == [_XHTML + "a", _XHTML + "ol"] or children == [_XHTML + "span", _XHTML + "ol"]
            invalid_toc = invalid_toc or not valid
        elif frame["kind"] == "label":
            has_label = frame["has_text"] or (frame["has_embedded"] and bool(frame["title"].strip()))
            invalid_toc = invalid_toc or not has_label or (name == _XHTML + "a" and not frame["href"].strip())
            label_depth = None
        elif frame["kind"] == "nav":
            headings = {_XHTML + f"h{index}" for index in range(1, 7)}
            children = frame["children"]
            valid_children = children == [_XHTML + "ol"] or (len(children) == 2 and children[0] in headings and children[1] == _XHTML + "ol")
            invalid_toc = invalid_toc or not valid_children
            toc_depth = None
        stack.pop()
        frames.pop()

    def text(value):
        nonlocal invalid_toc
        if label_depth is not None and value.strip():
            frames[label_depth]["has_text"] = True
        elif toc_depth is not None and frames and frames[-1]["kind"] in ("nav", "ol", "li") and value.strip():
            invalid_toc = True

    def doctype(_name, system_id, public_id, internal_subset):
        if system_id or public_id or internal_subset:
            raise _InvalidNavigation("doctype")

    def reject_entity(*_args):
        raise _InvalidNavigation("entity")

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    parser.StartDoctypeDeclHandler = doctype
    parser.EntityDeclHandler = reject_entity
    parser.ExternalEntityRefHandler = reject_entity
    try:
        read = 0
        while chunk := stream.read(64 * 1024):
            read += len(chunk)
            if read > MAX_NAV_BYTES or read > size:
                return "NAV_LIMIT"
            parser.Parse(chunk, False)
        if read != size:
            return "NAV_XML"
        parser.Parse(b"", True)
    except _NavigationLimit:
        return "NAV_LIMIT"
    except (_InvalidNavigation, expat.ExpatError):
        return "NAV_XML"
    if toc_count != 1 or invalid_toc:
        return "NO_TOC"
    return None
