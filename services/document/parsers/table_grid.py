"""Canonical table-grid metadata shared by trusted archive importers."""
from hashlib import sha256
import json


def span_attributes(rows: list[list[str]], header_rows: int, spans: list[dict]) -> dict:
    attributes = {"tableHeaderRows": header_rows} if header_rows else {}
    if spans:
        attributes["tableSpans"] = spans
        # Out-of-band edits invalidate layout; the grid editor updates both atomically.
        grid = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
        attributes["tableSpanSource"] = "v2:" + sha256(grid.encode("utf-8")).hexdigest()
    return attributes
