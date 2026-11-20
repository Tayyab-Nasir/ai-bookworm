"""Check the actual EPUB validator before starting local release verification."""

import json
import os
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    jar = Path(os.environ.get("EPUBCHECK_JAR", ""))
    if not jar.is_file() or jar.suffix.lower() != ".jar":
        print("Set EPUBCHECK_JAR to the reviewed EPUBCheck 5.4.0 epubcheck.jar before running verification.", file=sys.stderr)
        return 1

    sys.path.insert(0, str(root / "services" / "rendering"))
    from editions import parse_edition
    from epub_renderer import render_epub
    from epubcheck_runner import run_epubcheck

    fixture = root / "tests" / "fixtures" / "books" / "valid_book.json"
    book = json.loads(fixture.read_text(encoding="utf-8"))
    epub, _ = render_epub(book, parse_edition({"kind": "ebook"}))
    if run_epubcheck(epub).status != "valid":
        print("EPUBCheck could not validate the synthetic EPUB. Check Java and the complete reviewed EPUBCheck 5.4.0 distribution.", file=sys.stderr)
        return 1

    print("EPUBCheck 5.4.0 validated the synthetic verification EPUB.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
