"""Deterministic synthetic DOCX table image for the import-pipeline fixture."""
import base64
import io
import itertools
import json
import sys
import uuid
from pathlib import Path
from unittest.mock import patch

from docx import Document

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from parsers.docx_parser import parse_docx

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")


def parsed_fixture():
    doc = Document()
    cell = doc.add_table(rows=1, cols=1).cell(0, 0)
    cell.paragraphs[0].add_run("Before")
    picture = cell.paragraphs[0].add_run().add_picture(io.BytesIO(PNG))
    picture._inline.docPr.set("descr", "Synthetic diagram")
    cell.paragraphs[0].add_run("After")
    raw = io.BytesIO()
    doc.save(raw)
    assets = []
    identifiers = itertools.count(1)
    def fixture_uuid():
        return uuid.UUID(f"{next(identifiers):08x}-0000-4000-8000-000000000000")
    with patch("uuid.uuid4", side_effect=fixture_uuid):
        book, report = parse_docx(raw.getvalue(), title="Synthetic", embedded_assets=assets)
    return {"bookModel": book, "report": report, "embeddedAssets": assets}


if __name__ == "__main__":
    print(json.dumps(parsed_fixture(), ensure_ascii=False, indent=2))
