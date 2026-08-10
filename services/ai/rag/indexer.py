"""Index book content into Qdrant book_chunks (spec section 11, Step 8).

Reindex on version change = delete the old version's points, then upsert.
Idempotent: point ids are uuid5(bookId + nodeId + textHash), so re-running the
same version upserts the same points.
"""
from __future__ import annotations

import uuid

from rag.embeddings import Embedder, text_hash
from rag.qdrant_client import QdrantRag

COLLECTION = "book_chunks"
_CHUNK_CHARS = 2000  # ponytail: ~500 tokens at ~4 chars/token; swap for tokenizer if recall suffers


def chunk_text(text: str, size: int = _CHUNK_CHARS) -> list[str]:
    """Split on paragraph boundaries, packing up to `size` chars; hard-split long paragraphs."""
    chunks, buf = [], ""
    for para in text.split("\n\n"):
        while len(para) > size:  # hard-split oversized paragraphs
            if buf:
                chunks.append(buf)
                buf = ""
            chunks.append(para[:size])
            para = para[size:]
        if buf and len(buf) + len(para) + 2 > size:
            chunks.append(buf)
            buf = ""
        buf = f"{buf}\n\n{para}" if buf else para
    if buf:
        chunks.append(buf)
    return [c for c in chunks if c.strip()]


def point_id(book_id: str, node_id: str, thash: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"bookworm:{book_id}:{node_id}:{thash}"))


def index_book_version(
    rag: QdrantRag,
    embedder: Embedder,
    workspace_id: str,
    book_id: str,
    version_id: str,
    chapters: list[dict],
    language: str = "en",
    previous_version_id: str | None = None,
) -> int:
    """chapters: [{"id": ..., "nodes": [{"id": ..., "text": ...}]}]. Returns points upserted."""
    if previous_version_id:
        rag.delete_by_version(COLLECTION, workspace_id, book_id, previous_version_id)

    points = []
    for chapter in chapters:
        for node in chapter.get("nodes", []):
            for chunk in chunk_text(node.get("text", "")):
                thash = text_hash(chunk)
                points.append(
                    {
                        "id": point_id(book_id, node.get("id", ""), thash),
                        "payload": {
                            "workspace_id": workspace_id,
                            "book_id": book_id,
                            "chapter_id": chapter.get("id"),
                            "node_id": node.get("id"),
                            "document_version_id": version_id,
                            "text_hash": thash,
                            "language": language,
                            "text": chunk,
                        },
                    }
                )
    if points:
        vectors = embedder.embed([p["payload"]["text"] for p in points])
        for p, v in zip(points, vectors):
            if len(v) != rag.dim:
                raise ValueError(f"embedder dim {len(v)} != qdrant dim {rag.dim}; set EMBEDDING_DIM consistently")
            p["vector"] = v
        rag.upsert_points(COLLECTION, points)
    return len(points)
