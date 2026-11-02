"""Bounded, offline verification of EPUB TOC links against the package spine.

This is a deliberately limited preflight check, not a replacement for EPUBCheck.
Unsupported URL bases, foreign fragments and EPUB CFI/SVG view fragments are
reported as unverifiable instead of being represented as invalid EPUB syntax.
"""
from collections import Counter
from urllib.parse import unquote_to_bytes, urlsplit
from xml.parsers import expat
import posixpath
import re

from nav_validation import inspect_navigation

_OPF = "http://www.idpf.org/2007/opf|"
_XML_BASE = "http://www.w3.org/XML/1998/namespace|base"
_XML_ID = "http://www.w3.org/XML/1998/namespace|id"
_XHTML = "http://www.w3.org/1999/xhtml|html"
_SVG = "http://www.w3.org/2000/svg|svg"
_MAX_XML = 8 * 1024 * 1024
_MAX_TOTAL_TARGET_XML = 64 * 1024 * 1024
_MAX_ELEMENTS = 100_000
_MAX_DEPTH = 128
_BAD_PERCENT = re.compile(r"%(?![0-9a-fA-F]{2})")
_ENCODED_SEPARATOR = re.compile(r"%(?:2f|5c)", re.IGNORECASE)


class _TargetError(ValueError):
    def __init__(self, code: str):
        self.code = code


def _parse_xml(archive, path: str, on_start, expected_root: str):
    try:
        info = archive.getinfo(path)
    except KeyError as exc:
        raise _TargetError("NAV_TARGET_MISSING") from exc
    if info.file_size > _MAX_XML:
        raise _TargetError("NAV_TARGET_LIMIT")
    parser = expat.ParserCreate(namespace_separator="|")
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    stack: list[str] = []
    count = 0
    def start(name, attrs):
        nonlocal count
        count += 1
        if count > _MAX_ELEMENTS or len(stack) >= _MAX_DEPTH:
            raise _TargetError("NAV_TARGET_LIMIT")
        if not stack and name != expected_root:
            raise _TargetError("NAV_TARGET_XML")
        on_start(name, attrs, stack)
        stack.append(name)
    def end(_name):
        stack.pop()
    def doctype(_name, system_id, public_id, internal_subset):
        if system_id or public_id or internal_subset:
            raise _TargetError("NAV_TARGET_UNSUPPORTED")
    def entity(*_args):
        raise _TargetError("NAV_TARGET_UNSUPPORTED")
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.StartDoctypeDeclHandler = doctype
    parser.EntityDeclHandler = entity
    parser.ExternalEntityRefHandler = entity
    try:
        read = 0
        with archive.open(info) as stream:
            while chunk := stream.read(64 * 1024):
                read += len(chunk)
                if read > _MAX_XML or read > info.file_size:
                    raise _TargetError("NAV_TARGET_LIMIT")
                parser.Parse(chunk, False)
        if read != info.file_size:
            raise _TargetError("NAV_TARGET_XML")
        parser.Parse(b"", True)
    except (expat.ExpatError, LookupError) as exc:
        raise _TargetError("NAV_TARGET_XML") from exc
    return info.file_size


def _decode(value: str) -> str:
    if _BAD_PERCENT.search(value):
        raise _TargetError("NAV_TARGET_URL")
    try:
        decoded = unquote_to_bytes(value).decode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise _TargetError("NAV_TARGET_URL") from exc
    if any(ord(char) < 32 or ord(char) == 127 for char in decoded):
        raise _TargetError("NAV_TARGET_URL")
    return decoded


def _resolve(base: str, reference: str, *, manifest=False) -> tuple[str, str | None]:
    if (not reference or len(reference) > 4096 or "\\" in reference
            or any(ord(char) < 32 or ord(char) == 127 for char in reference)):
        raise _TargetError("NAV_TARGET_URL")
    if reference != reference.strip(" "):
        # Browser URL parsing trims outer ASCII spaces. Reject ambiguity rather
        # than comparing them to literal archive filename characters.
        raise _TargetError("NAV_TARGET_UNSUPPORTED")
    try:
        parts = urlsplit(reference)
    except ValueError as exc:
        raise _TargetError("NAV_TARGET_URL") from exc
    if parts.scheme in ("http", "https") or parts.netloc or parts.path.startswith("/"):
        raise _TargetError("NAV_TARGET_UNSUPPORTED")
    if parts.scheme:
        raise _TargetError("NAV_TARGET_URL")
    if parts.query or (manifest and parts.fragment):
        raise _TargetError("NAV_TARGET_UNSUPPORTED")
    if _ENCODED_SEPARATOR.search(parts.path):
        raise _TargetError("NAV_TARGET_UNSUPPORTED")
    decoded = _decode(parts.path)
    path = posixpath.normpath(posixpath.join(posixpath.dirname(base), decoded)) if decoded else base
    if path == "." or path == ".." or path.startswith("../") or path.startswith("/"):
        raise _TargetError("NAV_TARGET_URL")
    fragment = _decode(parts.fragment) if parts.fragment else None
    if fragment and (fragment.startswith("epubcfi(") or fragment.startswith("svgView(")):
        raise _TargetError("NAV_TARGET_UNSUPPORTED")
    return path, fragment


def inspect_toc_targets(archive, nav_path="OEBPS/nav.xhtml", package_path="OEBPS/content.opf") -> str | None:
    """Return a finding code; never follow links or access the network."""
    try:
        links: list[str] = []
        alternate_base: list[bool] = []
        try:
            nav = archive.getinfo(nav_path)
        except KeyError:
            return None  # Existing navigation rule reports this.
        with archive.open(nav) as stream:
            issue = inspect_navigation(stream, nav.file_size, toc_links=links, alternate_base=alternate_base)
        if issue:
            return None  # Existing navigation rule reports malformed input.
        if alternate_base:
            raise _TargetError("NAV_TARGET_UNSUPPORTED")
        manifest: dict[str, tuple[str, str, str | None, set[str]]] = {}
        spine: list[str] = []
        sections = Counter()
        def package_start(name, attrs, stack):
            if _XML_BASE in attrs:
                raise _TargetError("NAV_TARGET_UNSUPPORTED")
            if stack == [_OPF + "package"] and name in (_OPF + "manifest", _OPF + "spine"):
                sections[name] += 1
            if stack == [_OPF + "package", _OPF + "manifest"] and name == _OPF + "item":
                item_id, href, mime = attrs.get("id", ""), attrs.get("href", ""), attrs.get("media-type", "")
                if not item_id or item_id in manifest or not href or not mime:
                    raise _TargetError("NAV_TARGET_PACKAGE")
                # Remote non-spine resources can be valid; resolve only if a
                # top-level item/fallback or nav declaration is actually used.
                manifest[item_id] = (href, mime, attrs.get("fallback"), set(attrs.get("properties", "").split()))
            if stack == [_OPF + "package", _OPF + "spine"] and name == _OPF + "itemref":
                spine.append(attrs.get("idref", ""))
        _parse_xml(archive, package_path, package_start, _OPF + "package")
        if sections[_OPF + "manifest"] != 1 or sections[_OPF + "spine"] != 1 or not spine:
            raise _TargetError("NAV_TARGET_PACKAGE")
        navs = [item for item in manifest.values() if "nav" in item[3]]
        if len(navs) != 1 or navs[0][1] != "application/xhtml+xml" or _resolve(package_path, navs[0][0], manifest=True)[0] != nav_path:
            raise _TargetError("NAV_TARGET_PACKAGE")
        targets: dict[str, tuple[str, str]] = {}
        steps = 0
        for item_id in spine:
            visited: set[str] = set()
            while item_id:
                steps += 1
                if steps > 100_000:
                    raise _TargetError("NAV_TARGET_LIMIT")
                if item_id in visited or item_id not in manifest:
                    raise _TargetError("NAV_TARGET_PACKAGE")
                visited.add(item_id)
                href, mime, fallback, _ = manifest[item_id]
                path, _ = _resolve(package_path, href, manifest=True)
                if path in targets and targets[path] != (mime, item_id):
                    raise _TargetError("NAV_TARGET_PACKAGE")
                targets[path] = (mime, item_id)
                item_id = fallback or ""
        documents: dict[str, set[str]] = {}
        archive_names = set(archive.namelist())
        for link in links:
            path, fragment = _resolve(nav_path, link)
            if path not in targets or path not in archive_names:
                raise _TargetError("NAV_TARGET_MISSING")
            if targets[path][0] in ("application/xhtml+xml", "image/svg+xml"):
                documents.setdefault(path, set())
            if fragment:
                if targets[path][0] not in ("application/xhtml+xml", "image/svg+xml"):
                    raise _TargetError("NAV_TARGET_UNSUPPORTED")
                documents[path].add(fragment)
        total = 0
        for path, wanted in documents.items():
            try:
                info = archive.getinfo(path)
            except KeyError as exc:
                raise _TargetError("NAV_TARGET_MISSING") from exc
            total += info.file_size
            if total > _MAX_TOTAL_TARGET_XML:
                raise _TargetError("NAV_TARGET_LIMIT")
            found: Counter[str] = Counter()
            def target_start(_name, attrs, _stack):
                ids = {attrs.get("id"), attrs.get(_XML_ID)}
                for value in ids & wanted:
                    found[value] += 1
            _parse_xml(archive, path, target_start, _XHTML if targets[path][0] == "application/xhtml+xml" else _SVG)
            if any(found[value] != 1 for value in wanted):
                raise _TargetError("NAV_TARGET_FRAGMENT")
        return None
    except _TargetError as error:
        return error.code
