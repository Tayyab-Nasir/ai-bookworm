"""TXT importer: encoding detection + chapter heuristics. Spec section 13."""
import re

import chardet

from . import ParseError, check_size, make_book, make_report, new_chapter, node

_CHAPTER_RE = re.compile(
    r"^\s*(chapter|part|book|prologue|epilogue|section)\b[\s:.\-]*([0-9ivxlcdm]+)?\s*(.*)$",
    re.IGNORECASE)
_MIN_ALLCAPS = 3


def _decode(data: bytes) -> tuple[str, list[str]]:
    warnings: list[str] = []
    if data.startswith(b"\xef\xbb\xbf"):
        try:
            return data.decode("utf-8-sig"), warnings
        except UnicodeDecodeError as error:
            raise ParseError("UTF-8 manuscript contains invalid text") from error
    # Statistical detectors can label a short valid UTF-8 file Windows-1252
    # (notably an isolated em dash). Prefer a lossless Unicode decode first.
    try:
        return data.decode("utf-8"), warnings
    except UnicodeDecodeError:
        pass
    guess = chardet.detect(data)
    enc = guess.get("encoding") or "utf-8"
    conf = guess.get("confidence") or 0
    if conf < 0.8:
        warnings.append(f"encoding detection low confidence ({enc}, {conf:.2f})")
    try:
        return data.decode(enc), warnings
    except (UnicodeDecodeError, LookupError):
        warnings.append(f"failed decoding as {enc}; fell back to utf-8 with replacement")
        return data.decode("utf-8", errors="replace"), warnings


def _is_chapter_heading(line: str) -> bool:
    s = line.strip()
    if not s or len(s) > 200:
        return False
    if _CHAPTER_RE.match(s):
        return True
    # ALLCAPS title: at least 3 alpha chars, all alpha uppercase
    alpha = [c for c in s if c.isalpha()]
    return len(alpha) >= _MIN_ALLCAPS and all(c.isupper() for c in alpha)


def parse_txt(data: bytes, title: str = "Untitled") -> tuple[dict, dict]:
    check_size(data)
    if b"\x00" in data:
        raise ParseError("file looks binary, not text")
    text, warnings = _decode(data)
    lines = text.splitlines()

    chapters: list[dict] = []
    current: dict | None = None
    buf: list[str] = []

    def flush_para() -> None:
        if buf:
            t = " ".join(l.strip() for l in buf).strip()
            if t:
                # Opening prose must survive a later recognized chapter heading.
                # The previous flush cleared it while current was still None.
                if current is None:
                    new_current(title)
                current["nodes"].append(node("paragraph", t))
        buf.clear()

    def new_current(ch_title: str) -> None:
        nonlocal current
        current = new_chapter(ch_title, len(chapters))
        chapters.append(current)

    for line in lines:
        if _is_chapter_heading(line):
            flush_para()
            new_current(line.strip())
            current["nodes"].append(node("heading", line.strip(), level=1))
        elif not line.strip():
            flush_para()
        else:
            buf.append(line)
    flush_para()

    if not chapters:
        raise ParseError("text file is empty")

    book = make_book(chapters, title=title)
    return book, make_report(chapters, warnings)
