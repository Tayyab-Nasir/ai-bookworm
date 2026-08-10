"""Shared Book Model helpers. Output mirrors packages/book-model schema (spec section 7):
{schemaVersion:"1.0", bookId, metadata, styleGuide, bookBible, chapters[], assets[]}.

All file content is untrusted: parsers must not exec, must guard zip-slip and size.
"""
import re
import uuid

MAX_FILE_BYTES = 100 * 1024 * 1024  # 100MB, spec section 13
MAX_ZIP_ENTRIES = 10_000


class ParseError(Exception):
    """Unparseable/unsafe input -> API returns 422."""


def check_size(data: bytes) -> None:
    if len(data) > MAX_FILE_BYTES:
        raise ParseError(f"file exceeds {MAX_FILE_BYTES} byte cap")


def safe_zip_members(zf) -> list[str]:
    """Reject zip-slip entries and oversized archives. Returns safe member names."""
    names = zf.namelist()
    if len(names) > MAX_ZIP_ENTRIES:
        raise ParseError("archive has too many entries")
    total = 0
    safe = []
    for info in zf.infolist():
        n = info.filename
        if n.startswith("/") or n.startswith("\\") or re.match(r"^[a-zA-Z]:", n):
            raise ParseError(f"unsafe zip entry: {n!r}")
        parts = [p for p in n.replace("\\", "/").split("/") if p]
        if any(p == ".." for p in parts):
            raise ParseError(f"zip-slip entry rejected: {n!r}")
        total += info.file_size
        if total > MAX_FILE_BYTES:
            raise ParseError("archive decompressed size exceeds cap")
        safe.append(n)
    return safe


def new_chapter(title: str, order: int) -> dict:
    return {"id": str(uuid.uuid4()), "order": order, "title": title, "nodes": []}


def node(type_: str, text: str | None = None, **kw) -> dict:
    n = {"id": f"n-{uuid.uuid4().hex[:12]}", "type": type_}
    if text is not None:
        n["text"] = text
    n.update(kw)
    return n


def make_book(chapters: list[dict], assets: list[dict] | None = None,
              title: str = "Untitled", author: str = "Unknown", language: str = "en") -> dict:
    return {
        "schemaVersion": "1.0",
        "bookId": str(uuid.uuid4()),
        "metadata": {"title": title, "author": author, "language": language},
        "styleGuide": {},
        "bookBible": {"entities": []},
        "chapters": chapters,
        "assets": assets or [],
    }


def make_report(chapters: list[dict], warnings: list[str] | None = None,
                confidence: str = "high", image_count: int = 0) -> dict:
    return {
        "warnings": warnings or [],
        "chapterCount": len(chapters),
        "nodeCount": sum(len(c["nodes"]) for c in chapters),
        "imageCount": image_count,
        "confidence": confidence,
    }
