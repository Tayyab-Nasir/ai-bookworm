"""Bounded, inert reader of exact saved EPUB bytes; no regeneration or I/O.

The HTTP caller must isolate CPU work and enforce its own absolute deadline.
This module never extracts archives, fetches URLs, executes content, renders a
book model, or changes resource bytes. Untrusted styling is not replayed.
"""
import base64
import binascii
import hashlib
import html
import io
import json
import posixpath
import re
import stat
import struct
import unicodedata
import warnings
import zipfile
import zlib
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET

from PIL import Image

FORMAT_VERSION = "epub-reader-1.0.0"
MAX_SOURCE_BYTES = 150 * 1024 * 1024
MAX_ZIP_ENTRIES = 10_000
MAX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_SPINE_ITEMS = 2_500
MAX_METADATA_BYTES = 1024 * 1024
MAX_XHTML_BYTES = 8 * 1024 * 1024
MAX_CSS_BYTES = 64 * 1024
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_IMAGE_SIDE = 7_200
MAX_IMAGE_PIXELS = 40_000_000
MAX_HTML_BYTES = 12 * 1024 * 1024
MAX_RESPONSE_BYTES = 12 * 1024 * 1024
MAX_NODES = 100_000
MAX_DEPTH = 64
MAX_COMPRESSION_RATIO = 1_000
_CHUNK = 64 * 1024
_X = "{http://www.w3.org/1999/xhtml}"
_O = "{http://www.idpf.org/2007/opf}"
_C = "{urn:oasis:names:tc:opendocument:xmlns:container}"
_XML = "{http://www.w3.org/XML/1998/namespace}"
_RASTERS = {"image/png": "PNG", "image/jpeg": "JPEG"}
_TAGS = frozenset("section div p h1 h2 h3 h4 h5 h6 blockquote strong em b i u s del code pre br hr ul ol li table thead tbody tfoot tr td th caption figure figcaption aside span nav a img".split())
_VOID = frozenset({"br", "hr", "img"})
_ACTIVE = frozenset({"script", "style", "iframe", "object", "embed", "form", "input", "button", "select", "textarea", "base", "link", "meta", "audio", "video", "source", "canvas", "svg", "math"})
_TRUSTED_CSS = frozenset({
    b'body{font-family:serif;line-height:1.5}',
    b'html,body{margin:0;padding:0}img{display:block;width:100%;height:100%}',
    (b'body{font-family:serif;line-height:1.5}h1,h2,h3,h4,h5,h6{break-after:avoid}'
     b'figure{text-align:center;margin:1.5em 0;break-inside:avoid}img{height:auto;max-width:100%}'
     b'figcaption,.caption{font-size:.9em;font-style:italic}blockquote{margin:1em 2em}'
     b'.page-break{break-before:page;border:0}code{font-family:monospace}.cover{margin:0;text-align:center}'
     b'table{border-collapse:collapse;width:100%;margin:1em 0}td,th{border:1px solid #777;padding:.4em;vertical-align:top;overflow-wrap:anywhere}'
     b'th{font-weight:bold;background:#e7e2d8}html[dir="rtl"] body{text-align:right}html[dir="rtl"] .cover{text-align:center}'),
})


def _fail(message: str) -> None:
    # Messages are fixed operator guidance; never echo archive paths or contents.
    raise ValueError(message)


def _path(value: str, *, directory: bool = False) -> str:
    if not value or len(value) > 1024 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        _fail("EPUB archive contains an invalid path.")
    if "\\" in value or value.startswith("/") or ":" in value:
        _fail("EPUB archive contains an unsafe path.")
    raw = value[:-1] if directory and value.endswith("/") else value
    if not raw or any(part in {"", ".", ".."} for part in raw.split("/")):
        _fail("EPUB archive contains an unsafe path.")
    return raw


def _resolve(base: str, href: str, *, fragment: bool = False) -> str:
    if not isinstance(href, str) or not href or len(href) > 2048 or any(ord(char) < 32 or ord(char) == 127 for char in href):
        _fail("EPUB contains an invalid resource reference.")
    if re.search(r"%(?![0-9a-fA-F]{2})", href) or re.search(r"%(?:2f|5c)", href, re.I):
        _fail("EPUB contains an unsafe encoded resource reference.")
    if "?" in href or "#" in href and not fragment:
        _fail("EPUB resource queries and fragments are not allowed.")
    try:
        url = urlsplit(href)
        if url.scheme or url.netloc or url.query or (url.fragment and not fragment):
            _fail("EPUB contains a non-local resource reference.")
        decoded = unquote(url.path, encoding="utf-8", errors="strict")
    except (ValueError, UnicodeError):
        _fail("EPUB contains an invalid resource reference.")
    _path(decoded)
    return _path(posixpath.join(posixpath.dirname(base), decoded))


def _entry_limit(name: str) -> int:
    lower = name.lower()
    if lower.endswith((".opf", ".xml")):
        return MAX_METADATA_BYTES
    if lower.endswith((".xhtml", ".html", ".htm")):
        return MAX_XHTML_BYTES
    if lower.endswith(".css"):
        return MAX_CSS_BYTES
    if lower.endswith((".png", ".jpg", ".jpeg")):
        return MAX_IMAGE_BYTES
    return MAX_EXPANDED_BYTES


class _Archive:
    def __init__(self, data: bytes):
        try:
            self.zip = zipfile.ZipFile(io.BytesIO(data))
            items = self.zip.infolist()
            if not items or len(items) > MAX_ZIP_ENTRIES:
                _fail("EPUB ZIP entry limit exceeded.")
            if items[0].filename != "mimetype" or items[0].header_offset != 0 or items[0].compress_type != zipfile.ZIP_STORED:
                _fail("EPUB mimetype must be the first stored entry.")
            self.items = {}
            canonical = set()
            ranges = []
            advertised = 0
            actual_total = 0
            for item in items:
                name = _path(item.orig_filename, directory=item.is_dir())
                key = unicodedata.normalize("NFC", name).casefold()
                if key in canonical:
                    _fail("EPUB ZIP has duplicate or ambiguous paths.")
                canonical.add(key)
                mode = stat.S_IFMT(item.external_attr >> 16)
                if mode not in {0, stat.S_IFREG, stat.S_IFDIR} or (mode == stat.S_IFDIR) != item.is_dir() and mode != 0:
                    _fail("EPUB ZIP contains a non-regular entry.")
                if item.is_dir() and item.file_size != 0:
                    _fail("EPUB ZIP directory entries must be empty.")
                if item.flag_bits & ~0x80E or item.flag_bits & 1:
                    _fail("EPUB ZIP encryption or unsupported flags are not allowed.")
                if item.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                    _fail("EPUB ZIP compression is not supported.")
                limit = _entry_limit(name)
                advertised += item.file_size
                if item.file_size < 0 or item.compress_size < 0 or item.file_size > limit or advertised > MAX_EXPANDED_BYTES:
                    _fail("EPUB ZIP expanded byte limit exceeded.")
                if item.file_size > max(1, item.compress_size) * MAX_COMPRESSION_RATIO:
                    _fail("EPUB ZIP compression ratio limit exceeded.")
                offset = item.header_offset
                if offset < 0 or offset + 30 > self.zip.start_dir:
                    _fail("EPUB ZIP local header is invalid.")
                header = struct.unpack_from("<4s5H3I2H", data, offset)
                signature, _, flags, method, _, _, crc, compressed, expanded, name_length, extra_length = header
                start = offset + 30 + name_length + extra_length
                end = start + item.compress_size
                if signature != b"PK\x03\x04" or flags != item.flag_bits or method != item.compress_type or end > self.zip.start_dir:
                    _fail("EPUB ZIP local and central headers disagree.")
                raw_name = data[offset + 30:offset + 30 + name_length].decode("utf-8" if flags & 0x800 else "cp437")
                if raw_name != item.orig_filename:
                    _fail("EPUB ZIP local and central paths disagree.")
                if not flags & 8 and (crc != item.CRC or compressed not in {item.compress_size, 0xFFFFFFFF} or expanded not in {item.file_size, 0xFFFFFFFF}):
                    _fail("EPUB ZIP local and central sizes disagree.")
                ranges.append((offset, end))
                actual_total += self._verify_stream(data, start, end, item, min(limit, MAX_EXPANDED_BYTES - actual_total))
                if not item.is_dir():
                    self.items[name] = item
            previous = 0
            for start, end in sorted(ranges):
                if start < previous:
                    _fail("EPUB ZIP entries overlap.")
                previous = end
            if self.read("mimetype", 64) != b"application/epub+zip":
                _fail("EPUB mimetype is invalid.")
        except (zipfile.BadZipFile, RuntimeError, OSError, UnicodeError, struct.error, zlib.error, NotImplementedError):
            _fail("EPUB ZIP is corrupt or unsupported.")

    @staticmethod
    def _verify_stream(data, start, end, item, limit):
        crc = 0
        actual = 0
        decoder = zlib.decompressobj(-15) if item.compress_type == zipfile.ZIP_DEFLATED else None
        for offset in range(start, end, _CHUNK):
            pending = data[offset:min(offset + _CHUNK, end)]
            while pending:
                output = decoder.decompress(pending, _CHUNK) if decoder else pending
                pending = decoder.unconsumed_tail if decoder else b""
                actual += len(output)
                if actual > limit or actual > item.file_size:
                    _fail("EPUB ZIP actual expanded byte limit exceeded.")
                crc = binascii.crc32(output, crc)
                if decoder and decoder.unused_data:
                    _fail("EPUB ZIP compressed stream contains trailing data.")
        if decoder and not decoder.eof:
            _fail("EPUB ZIP compressed stream is truncated.")
        if actual != item.file_size or crc & 0xFFFFFFFF != item.CRC:
            _fail("EPUB ZIP size or checksum verification failed.")
        return actual

    def read(self, name: str, limit: int) -> bytes:
        item = self.items.get(name)
        if item is None or item.file_size > limit:
            _fail("EPUB required entry is missing or exceeds its byte limit.")
        try:
            with self.zip.open(item) as stream:
                value = stream.read(limit + 1)
                if len(value) > limit or len(value) != item.file_size:
                    _fail("EPUB entry byte limit or size verification failed.")
                return value
        except (zipfile.BadZipFile, RuntimeError, OSError, zlib.error):
            _fail("EPUB entry checksum verification failed.")


def _xml(data: bytes, *, xhtml: bool = False) -> ET.Element:
    try:
        text = data.decode("utf-8-sig", errors="strict")
        if text.startswith("<?xml"):
            declaration = re.match(r'<\?xml\s+version=["\']1\.[01]["\'](?:\s+encoding=["\'](?:UTF-8|utf-8|utf8)["\'])?(?:\s+standalone=["\'](?:yes|no)["\'])?\s*\?>', text)
            if not declaration:
                _fail("EPUB XML declaration is unsupported.")
            text = text[declaration.end():]
        if "<!DOCTYPE" in text:
            prologue = re.match(r"\s*<!DOCTYPE html>", text)
            if not xhtml or text.count("<!DOCTYPE") != 1 or prologue is None:
                _fail("EPUB XML DTD is not allowed.")
            text = text[prologue.end():]
        if re.search(r"<!\s*(?:DOCTYPE|ENTITY)|<\?", text, re.I):
            _fail("EPUB XML entities and processing instructions are not allowed.")
        root = ET.fromstring(text)
        pending = [(root, 1)]
        count = 0
        while pending:
            node, depth = pending.pop()
            count += 1
            if count > MAX_NODES or depth > MAX_DEPTH:
                _fail("EPUB XML node or depth limit exceeded.")
            pending.extend((child, depth + 1) for child in node)
        return root
    except (UnicodeError, ET.ParseError, RecursionError):
        _fail("EPUB XML is malformed or unsupported.")


def _package(archive: _Archive):
    container = _xml(archive.read("META-INF/container.xml", MAX_METADATA_BYTES))
    rootfiles = container.findall(_C + "rootfiles/" + _C + "rootfile")
    if container.tag != _C + "container" or len(rootfiles) != 1 or rootfiles[0].get("media-type") != "application/oebps-package+xml":
        _fail("EPUB must declare one unambiguous package.")
    package_path = _resolve("container.xml", rootfiles[0].get("full-path", ""))
    package = _xml(archive.read(package_path, MAX_METADATA_BYTES))
    if package.tag != _O + "package" or len(package.findall(_O + "manifest")) != 1 or len(package.findall(_O + "spine")) != 1:
        _fail("EPUB package structure is invalid.")
    manifest = {}
    by_path = {}
    resources = []
    navs = []
    for item in package.findall(_O + "manifest/" + _O + "item"):
        item_id, mime = item.get("id", ""), item.get("media-type", "")
        path = _resolve(package_path, item.get("href", ""))
        if not item_id or len(item_id) > 1024 or item_id in manifest or path in by_path or path not in archive.items or not mime:
            _fail("EPUB manifest is missing, duplicate or ambiguous.")
        value = {"path": path, "mime": mime, "properties": item.get("properties", "").split()}
        manifest[item_id] = by_path[path] = value
        if mime in _RASTERS:
            value["resourceIndex"] = len(resources)
            resources.append(value)
        if "nav" in value["properties"]:
            if mime != "application/xhtml+xml":
                _fail("EPUB navigation must be XHTML.")
            navs.append(value)
    if len(navs) != 1:
        _fail("EPUB must declare one unambiguous navigation document.")
    _document(archive, navs[0]["path"], MAX_METADATA_BYTES)
    layouts = [item.text for item in package.findall(_O + "metadata/" + _O + "meta") if item.get("property") == "rendition:layout"]
    if len(layouts) > 1 or layouts and layouts[0] not in {"reflowable", "pre-paginated"}:
        _fail("EPUB rendition layout is invalid.")
    layout = layouts[0] if layouts else "reflowable"
    spine = []
    for item in package.findall(_O + "spine/" + _O + "itemref"):
        entry = manifest.get(item.get("idref", ""))
        if entry is None or entry["mime"] != "application/xhtml+xml":
            _fail("EPUB spine references an invalid document.")
        properties = item.get("properties", "").split()
        overrides = [name for name in properties if name in {"rendition:layout-reflowable", "rendition:layout-pre-paginated"}]
        if len(overrides) > 1:
            _fail("EPUB spine contains conflicting layouts.")
        spine.append({"path": entry["path"], "layout": overrides[0].removeprefix("rendition:layout-") if overrides else layout})
    if not spine or len(spine) > MAX_SPINE_ITEMS:
        _fail("EPUB spine item limit exceeded or spine is empty.")
    return layout, spine, by_path, resources


def _document(archive, path, limit=None):
    root = _xml(archive.read(path, MAX_XHTML_BYTES if limit is None else limit), xhtml=True)
    heads, bodies = root.findall(_X + "head"), root.findall(_X + "body")
    if root.tag != _X + "html" or len(heads) != 1 or len(bodies) != 1:
        _fail("EPUB reading document must have one XHTML head and body.")
    titles = heads[0].findall(_X + "title")
    if len(titles) != 1:
        _fail("EPUB reading document title is missing or ambiguous.")
    title = "".join(titles[0].itertext()).strip()
    if len(title) > 4096:
        _fail("EPUB reading document title limit exceeded.")
    return root, heads[0], bodies[0], title


def _raster(archive, entry, index):
    data = archive.read(entry["path"], MAX_IMAGE_BYTES)
    expected = _RASTERS[entry["mime"]]
    if expected == "PNG" and not data.startswith(b"\x89PNG\r\n\x1a\n") or expected == "JPEG" and not data.startswith(b"\xff\xd8\xff"):
        _fail("EPUB raster signature and media type disagree.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                width, height = image.size
                if image.format != expected or getattr(image, "n_frames", 1) != 1 or width < 1 or height < 1 or max(width, height) > MAX_IMAGE_SIDE or width * height > MAX_IMAGE_PIXELS:
                    _fail("EPUB raster dimensions, frames or media type are unsupported.")
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                image.load()
    except (OSError, SyntaxError, ValueError, Image.DecompressionBombWarning, Image.DecompressionBombError):
        _fail("EPUB raster validation failed.")
    return {"index": index, "mimeType": entry["mime"], "sha256": hashlib.sha256(data).hexdigest(),
            "sizeBytes": len(data), "width": width, "height": height}, data


def _positive(value, ceiling=MAX_IMAGE_SIDE):
    if value is None or not re.fullmatch(r"[1-9][0-9]{0,6}", value) or int(value) > ceiling:
        _fail("EPUB contains an invalid numeric reading attribute.")
    return int(value)


def _safe_markup(archive, path, body, manifest, resources, warning_set):
    references = {}
    chunks = []
    size = 0

    def emit(value):
        nonlocal size
        size += len(value.encode("utf-8"))
        if size > MAX_HTML_BYTES:
            _fail("EPUB serialized reading document byte limit exceeded.")
        chunks.append(value)

    def escaped_text(value):
        if value:
            emit(html.escape(value, quote=False))

    def attributes(node, tag):
        values = {}
        for name, value in node.attrib.items():
            if name in {"lang", _XML + "lang"} and re.fullmatch(r"[A-Za-z0-9-]{1,64}", value):
                values["lang"] = value
            elif name == "dir" and value in {"ltr", "rtl", "auto"}:
                values["dir"] = value
            elif name == "id" and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.:-]{0,127}", value):
                values["id"] = value
            elif name == "class":
                classes = [token for token in value.split() if token in {"caption", "cover", "page-break"}]
                if classes:
                    values["class"] = " ".join(dict.fromkeys(classes))
                if len(classes) != len(value.split()):
                    warning_set.add("unsupported-styles-ignored")
            elif name == "style":
                match = re.fullmatch(r"width:([1-9][0-9]?|100)%(?:;)?", value) if tag == "img" else None
                if match:
                    values["data-reader-width-percent"] = match.group(1)
                else:
                    warning_set.add("unsupported-styles-ignored")
            elif name in {"colspan", "rowspan"} and tag in {"td", "th"}:
                values[name] = str(_positive(value, 1000))
            elif name == "scope" and tag == "th" and value in {"row", "col", "rowgroup", "colgroup"}:
                values[name] = value
            elif name in {"start", "value"} and (tag == "ol" and name == "start" or tag == "li" and name == "value"):
                if not re.fullmatch(r"-?[0-9]{1,7}", value):
                    _fail("EPUB list numbering attribute is invalid.")
                values[name] = str(int(value))
            elif name == "href" or tag == "a":
                warning_set.add("links-disabled")
            elif name.lower().startswith("on"):
                warning_set.add("active-content-removed")
            elif name in {"srcset", "hidden"} or name not in {"src", "alt", "width", "height", "{http://www.idpf.org/2007/ops}type"}:
                warning_set.add("unsupported-markup-removed")
        if tag == "img":
            target = _resolve(path, node.get("src", ""))
            entry = manifest.get(target)
            if entry is None or entry["mime"] not in _RASTERS:
                _fail("EPUB image must reference a declared supported raster.")
            index = entry["resourceIndex"]
            if index not in references:
                references[index] = _raster(archive, resources[index], index)[0]
            values["data-reader-resource"] = str(index)
            alt = node.get("alt", "")
            if len(alt.encode("utf-8")) > MAX_METADATA_BYTES:
                _fail("EPUB image alternative text byte limit exceeded.")
            values["alt"] = alt
            for name in {"width", "height"}:
                if name in node.attrib:
                    values[name] = str(_positive(node.attrib[name]))
        return "".join(f' {key}="{html.escape(value, quote=True)}"' for key, value in sorted(values.items()))

    def visit(node):
        tag = node.tag.removeprefix(_X) if isinstance(node.tag, str) else ""
        if not node.tag.startswith(_X) or tag in _ACTIVE:
            warning_set.add("active-content-removed")
            return
        if tag not in _TAGS:
            warning_set.add("unsupported-markup-removed")
            escaped_text(node.text)
            for child in node:
                visit(child)
                escaped_text(child.tail)
            return
        emit("<" + tag + attributes(node, tag) + ">")
        if tag not in _VOID:
            escaped_text(node.text)
            for child in node:
                visit(child)
                escaped_text(child.tail)
            emit("</" + tag + ">")

    # Preserve safe body semantics in an inert div, never emit a second body.
    emit("<div" + attributes(body, "div") + ">")
    escaped_text(body.text)
    for child in body:
        visit(child)
        escaped_text(child.tail)
    emit("</div>")
    return "".join(chunks), [references[index] for index in sorted(references)]


def preview_epub(data: bytes, spine_index: int = 0, resource_index: int | None = None) -> dict:
    """Read one saved spine item or declared raster, bound to exact source SHA.

    Resource indices are artifact-global raster manifest order, not ZIP paths.
    The caller must bind this response to its privately authorized artifact.
    """
    if type(data) is not bytes or not data or len(data) > MAX_SOURCE_BYTES:
        _fail("Saved EPUB must be nonempty bytes within the source byte limit.")
    if type(spine_index) is not int or spine_index < 0 or resource_index is not None and (type(resource_index) is not int or resource_index < 0):
        _fail("EPUB reader index must be a nonnegative integer.")
    archive = _Archive(data)
    try:
        layout, spine, manifest, resources = _package(archive)
        identity = {"formatVersion": FORMAT_VERSION, "sourceSha256": hashlib.sha256(data).hexdigest(), "sourceSizeBytes": len(data)}
        if resource_index is not None:
            if resource_index >= len(resources):
                _fail("EPUB resource index is out of range.")
            resource, value = _raster(archive, resources[resource_index], resource_index)
            return {**identity, "resource": {**resource, "base64": base64.b64encode(value).decode("ascii")}, "warnings": []}
        if spine_index >= len(spine):
            _fail("EPUB spine index is out of range.")
        selected = None
        public_spine = []
        for index, item in enumerate(spine):
            document = _document(archive, item["path"])
            public_spine.append({"index": index, "title": document[3], "layout": item["layout"]})
            if index == spine_index:
                selected = document
        root, head, body, title = selected
        warning_set = set()
        if any(any(name.lower().startswith("on") for name in node.attrib) for node in root.iter()):
            warning_set.add("active-content-removed")
        for entry in manifest.values():
            if entry["mime"] == "text/css" and archive.read(entry["path"], MAX_CSS_BYTES) not in _TRUSTED_CSS:
                warning_set.add("unsupported-styles-ignored")
        for style in head.findall(_X + "style"):
            css = "".join(style.itertext()).encode("utf-8")
            if len(css) > MAX_CSS_BYTES:
                _fail("EPUB inline stylesheet byte limit exceeded.")
            if css not in _TRUSTED_CSS:
                warning_set.add("unsupported-styles-ignored")
        for node in head:
            if node.tag == _X + "link":
                # Only the exact local, declared stylesheet is recognized; none is emitted.
                try:
                    linked = manifest.get(_resolve(spine[spine_index]["path"], node.get("href", "")))
                    if linked is None or linked["mime"] != "text/css":
                        warning_set.add("unsupported-styles-ignored")
                except ValueError:
                    warning_set.add("unsupported-styles-ignored")
            elif node.tag not in {_X + "title", _X + "style", _X + "meta"}:
                warning_set.add("active-content-removed")
            elif node.tag == _X + "meta" and "http-equiv" in node.attrib:
                warning_set.add("active-content-removed")
        direction = root.get("dir", body.get("dir", "ltr"))
        if direction not in {"ltr", "rtl"}:
            _fail("EPUB document direction is unsupported.")
        if spine[spine_index]["layout"] == "pre-paginated":
            if len(body) != 1 or body[0].tag != _X + "img" or (body.text or "").strip() or (body[0].tail or "").strip() or len(body[0]):
                _fail("EPUB fixed preview supports one exact saved raster page only.")
        markup, referenced = _safe_markup(archive, spine[spine_index]["path"], body, manifest, resources, warning_set)
        document = {"index": spine_index, "title": title, "layout": spine[spine_index]["layout"],
                    "direction": direction, "html": markup, "resources": referenced}
        if document["layout"] == "pre-paginated":
            viewports = [node.get("content", "") for node in head.findall(_X + "meta") if node.get("name") == "viewport"]
            match = re.fullmatch(r"width=([1-9][0-9]{0,6}),\s*height=([1-9][0-9]{0,6})", viewports[0]) if len(viewports) == 1 else None
            if not match:
                _fail("EPUB fixed page requires one bounded viewport.")
            width, height = _positive(match.group(1)), _positive(match.group(2))
            if len(referenced) != 1 or (width, height) != (referenced[0]["width"], referenced[0]["height"]):
                _fail("EPUB fixed viewport must match one verified saved raster.")
            if (_positive(body[0].get("width")), _positive(body[0].get("height"))) != (width, height):
                _fail("EPUB fixed raster dimensions must match the saved viewport.")
            document.update(width=width, height=height)
        response = {**identity, "layout": layout, "spine": public_spine, "document": document, "warnings": sorted(warning_set)}
        if len(json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_RESPONSE_BYTES:
            _fail("EPUB reading response byte limit exceeded.")
        return response
    finally:
        archive.zip.close()
