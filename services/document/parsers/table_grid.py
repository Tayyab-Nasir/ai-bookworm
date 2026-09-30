"""Canonical table-grid metadata shared by trusted archive importers."""
from hashlib import sha256


def span_attributes(rows: list[list[str]], header_rows: int, spans: list[dict]) -> dict:
    attributes = {"tableHeaderRows": header_rows} if header_rows else {}
    if spans:
        text = "\n".join("\t".join(row) for row in rows)
        attributes["tableSpans"] = spans
        # A later cell edit invalidates layout rather than applying old merges.
        attributes["tableSpanSource"] = sha256(text.encode("utf-8")).hexdigest()
    return attributes
