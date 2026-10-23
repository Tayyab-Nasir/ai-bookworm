"""Prepare embeddings separately from index writes so retries never regenerate.

The funded worker must durably persist a PreparedIndex before calling its writer.
This module is private infrastructure, not an enabled author semantic-search API.
"""
from __future__ import annotations

from dataclasses import dataclass

from rag.embeddings import (Embedder, EmbeddingBatch, EmbeddingReceipt, EmbeddingConfigurationError,
                            request_hash, text_hash, validate_inputs, validate_vector, valid_model, valid_dimension)
from rag.qdrant_client import QdrantRag, require_scope, point_id

COLLECTION = "book_chunks"
_CHUNK_CHARS = 2000


def chunk_text(text: str, size: int = _CHUNK_CHARS) -> list[str]:
    if not isinstance(text, str) or type(size) is not int or not 1 <= size <= _CHUNK_CHARS:
        raise ValueError("Invalid bounded chunk input.")
    chunks, buf = [], ""
    for para in text.split("\n\n"):
        while len(para) > size:
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
    return [chunk for chunk in chunks if chunk.strip()]


@dataclass(frozen=True)
class PreparedIndex:
    workspace_id: str
    book_id: str
    version_id: str
    previous_version_id: str | None
    dimensions: int
    model: str
    points: tuple[dict, ...]
    embedding_receipt: EmbeddingReceipt | None


@dataclass(frozen=True)
class IndexResult:
    points_upserted: int
    embedding_receipt: EmbeddingReceipt | None


def _receipt_matches(receipt, texts, model, dimensions):
    if (not isinstance(receipt, EmbeddingReceipt) or type(receipt.input_count) is not int
            or receipt.input_count != len(texts) or type(receipt.dimensions) is not int
            or receipt.model != model or receipt.dimensions != dimensions
            or receipt.input_sha256 != request_hash(model, dimensions, texts)
            or receipt.provider not in ("openai", "mock")
            or type(receipt.prompt_tokens) is not int or type(receipt.total_tokens) is not int
            or receipt.prompt_tokens != receipt.total_tokens):
        raise ValueError("Embedding receipt differs; preserve prior index.")
    if receipt.provider == "mock":
        if receipt.model != "deterministic-mock-v1" or receipt.total_tokens != 0:
            raise ValueError("Invalid mock receipt.")
    elif not 1 <= receipt.total_tokens <= 300_000:
        raise ValueError("Provider usage requires reconciliation.")


def prepare_book_version(embedder: Embedder, workspace_id: str, book_id: str,
                         version_id: str, chapters: list[dict], language: str = "en",
                         previous_version_id: str | None = None) -> PreparedIndex:
    require_scope(workspace_id, book_id)
    require_scope(version_id, language)
    model = valid_model(embedder.model)
    dimensions = valid_dimension(embedder.dim)
    if previous_version_id is not None:
        require_scope(previous_version_id, book_id)
        if previous_version_id == version_id:
            raise ValueError("Never retire the version being indexed.")
    if not isinstance(chapters, list) or len(chapters) > 1000:
        raise ValueError("Index requires a bounded chapter list.")
    points, chapter_ids = [], set()
    for chapter in chapters:
        if not isinstance(chapter, dict):
            raise ValueError("Invalid chapter snapshot.")
        chapter_id = chapter.get("id")
        require_scope(chapter_id, version_id)
        if chapter_id in chapter_ids:
            raise ValueError("Duplicate chapter snapshot.")
        chapter_ids.add(chapter_id)
        nodes = chapter.get("nodes")
        if not isinstance(nodes, list) or len(nodes) > 10_000:
            raise ValueError("Invalid bounded node snapshot.")
        node_ids = set()
        for node in nodes:
            if not isinstance(node, dict):
                raise ValueError("Invalid canonical node.")
            node_id = node.get("id")
            require_scope(node_id, chapter_id)
            if node_id in node_ids:
                raise ValueError("Duplicate node identity.")
            node_ids.add(node_id)
            text = node.get("text", "")
            if not isinstance(text, str) or len(text) > 256_000:
                raise ValueError("Invalid bounded node text.")
            for ordinal, chunk in enumerate(chunk_text(text)):
                digest = text_hash(chunk)
                points.append({"id": point_id(workspace_id, book_id, version_id, chapter_id, node_id, ordinal, digest, model),
                    "payload": {"workspace_id": workspace_id, "book_id": book_id, "chapter_id": chapter_id,
                        "node_id": node_id, "document_version_id": version_id, "chunk_index": ordinal,
                        "text_hash": digest, "language": language, "text": chunk, "embedding_model": model}})
                if len(points) > 128:
                    raise ValueError("Index batch is too large; partition before funding.")
    receipt = None
    if points:
        texts = [point["payload"]["text"] for point in points]
        validate_inputs(texts)  # Check the ENTIRE batch before any provider call.
        batch = embedder.embed(texts)
        if not isinstance(batch, EmbeddingBatch) or len(batch.vectors) != len(points):
            raise ValueError("Embedding response count differs; preserve prior index.")
        receipt = batch.receipt
        _receipt_matches(receipt, texts, model, dimensions)
        for point, vector in zip(points, batch.vectors, strict=True):
            point["vector"] = validate_vector(vector, dimensions)
    return PreparedIndex(workspace_id, book_id, version_id, previous_version_id,
                         dimensions, model, tuple(points), receipt)


def write_prepared_index(rag: QdrantRag, prepared: PreparedIndex) -> IndexResult:
    """Idempotent index-only retry. This function cannot dispatch an embedding."""
    if not isinstance(prepared, PreparedIndex) or prepared.dimensions != rag.dim:
        raise ValueError("Prepared vector index dimensions differ.")
    valid_dimension(prepared.dimensions)
    require_scope(prepared.workspace_id, prepared.book_id)
    require_scope(prepared.version_id, prepared.book_id)
    valid_model(prepared.model)
    if prepared.previous_version_id is not None:
        require_scope(prepared.previous_version_id, prepared.book_id)
        if prepared.previous_version_id == prepared.version_id:
            raise ValueError("Never retire the version being indexed.")
    if len(prepared.points) > 128:
        raise ValueError("Prepared vector batch is unbounded.")
    if prepared.points:
        texts = [point["payload"]["text"] for point in prepared.points]
        validate_inputs(texts)
        _receipt_matches(prepared.embedding_receipt, texts, prepared.model, rag.dim)
        if any(point["payload"]["document_version_id"] != prepared.version_id
               or point["payload"]["embedding_model"] != prepared.model for point in prepared.points):
            raise ValueError("Prepared source version/model differs.")
        # Never delete the previous index until this synchronous write succeeds.
        rag.upsert_points(COLLECTION, prepared.points, workspace_id=prepared.workspace_id, book_id=prepared.book_id)
    elif prepared.embedding_receipt is not None:
        raise ValueError("Empty index must not contain an embedding receipt.")
    if prepared.previous_version_id is not None:
        rag.delete_by_version(COLLECTION, prepared.workspace_id, prepared.book_id, prepared.previous_version_id)
    return IndexResult(len(prepared.points), prepared.embedding_receipt)


def index_book_version(rag: QdrantRag, embedder: Embedder, workspace_id: str,
                       book_id: str, version_id: str, chapters: list[dict],
                       language: str = "en", previous_version_id: str | None = None) -> IndexResult:
    """Test-only convenience. Production must durably separate prepare from write."""
    if getattr(embedder, "name", None) != "mock":
        raise EmbeddingConfigurationError("Paid indexing must persist its prepared receipt before index writes.")
    if embedder.dim != rag.dim:
        raise ValueError("Embedding and index dimensions differ.")
    prepared = prepare_book_version(embedder, workspace_id, book_id, version_id, chapters, language, previous_version_id)
    return write_prepared_index(rag, prepared)
