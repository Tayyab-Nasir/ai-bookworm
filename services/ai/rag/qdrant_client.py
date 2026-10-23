"""Bounded Qdrant transport. All reads require scope, model and current versions.

The caller must reload authorized current versions and canonical source text from
Postgres. Index filters never replace application authorization or freshness checks.
"""
from __future__ import annotations

import json
import math
import os
import uuid

from rag.embeddings import text_hash, valid_dimension, valid_model, validate_vector

COLLECTIONS = ("book_chunks", "book_bible", "style_memory", "community_posts")


class QdrantUnavailableError(RuntimeError):
    pass


class MissingScopeError(ValueError):
    pass


def require_scope(workspace_id, book_id):
    for value in (workspace_id, book_id):
        if (not isinstance(value, str) or not value.strip() or value != value.strip()
                or len(value) > 200 or any(ord(char) < 32 or ord(char) == 127 for char in value)):
            raise MissingScopeError("Explicit bounded workspace/book/source identity is required.")


def point_id(workspace_id, book_id, version_id, chapter_id, node_id, chunk_index, digest, model):
    identity = json.dumps(["bookworm-vector-v2", workspace_id, book_id, version_id,
                           chapter_id, node_id, chunk_index, digest, model], separators=(",", ":"))
    return str(uuid.uuid5(uuid.NAMESPACE_URL, identity))


def checked_payload(payload: dict, workspace_id: str, book_id: str) -> dict:
    if not isinstance(payload, dict) or payload.get("workspace_id") != workspace_id or payload.get("book_id") != book_id:
        raise ValueError("Vector scope differs.")
    for key in ("chapter_id", "node_id", "document_version_id", "language"):
        require_scope(payload.get(key), book_id)
    valid_model(payload.get("embedding_model"))
    if type(payload.get("chunk_index")) is not int or not 0 <= payload["chunk_index"] < 128:
        raise ValueError("Invalid vector chunk index.")
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip() or len(text.encode("utf-8")) > 8_000 or text_hash(text) != payload.get("text_hash"):
        raise ValueError("Invalid vector source digest.")
    return {key: payload[key] for key in ("workspace_id", "book_id", "chapter_id", "node_id",
        "document_version_id", "chunk_index", "text_hash", "language", "text", "embedding_model")}


def payload_point_id(payload):
    return point_id(payload["workspace_id"], payload["book_id"], payload["document_version_id"],
                    payload["chapter_id"], payload["node_id"], payload["chunk_index"],
                    payload["text_hash"], payload["embedding_model"])


def _collection(name):
    if name not in COLLECTIONS:
        raise ValueError("Unsupported vector collection.")


def _conditions(pairs):
    from qdrant_client import models
    return [models.FieldCondition(key=key, match=models.MatchValue(value=value)) for key, value in pairs.items()]


def _require_completed(response):
    from qdrant_client import models
    if getattr(response, "status", None) != models.UpdateStatus.COMPLETED:
        raise QdrantUnavailableError("Vector write not confirmed; retry only the persisted index operation.")


class QdrantRag:
    def __init__(self, client=None, url=None, api_key=None, dim=None):
        self.dim = valid_dimension(dim if dim is not None else int(os.environ.get("EMBEDDING_DIM", "1536")))
        if client is None:
            from qdrant_client import QdrantClient
            client = QdrantClient(url=url or os.environ.get("QDRANT_URL", "http://localhost:6333"),
                                  api_key=api_key or os.environ.get("QDRANT_API_KEY"), timeout=10)
        self._client = client

    def _call(self, fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception:
            raise QdrantUnavailableError("qdrant call failed; do not repeat an embedding dispatch.") from None

    def ensure_collections(self):
        from qdrant_client import models
        for name in COLLECTIONS:
            if not self._call(self._client.collection_exists, name):
                self._call(self._client.create_collection, name,
                           vectors_config=models.VectorParams(size=self.dim, distance=models.Distance.COSINE))
            config = self._call(self._client.get_collection, name).config.params.vectors
            if not isinstance(config, models.VectorParams) or config.size != self.dim or config.distance != models.Distance.COSINE:
                raise ValueError("Existing vector collection is incompatible; no automatic replacement.")

    def upsert_points(self, collection, points, *, workspace_id, book_id):
        from qdrant_client import models
        _collection(collection)
        require_scope(workspace_id, book_id)
        if not isinstance(points, (list, tuple)) or not 1 <= len(points) <= 128:
            raise ValueError("Invalid bounded vector batch.")
        validated, identities = [], set()
        for point in points:
            payload = checked_payload(point.get("payload"), workspace_id, book_id)
            identity = payload_point_id(payload)
            if point.get("id") != identity or identity in identities:
                raise ValueError("Vector point identity differs or repeats.")
            identities.add(identity)
            validated.append(models.PointStruct(id=identity,
                vector=list(validate_vector(point.get("vector"), self.dim)), payload=payload))
        _require_completed(self._call(self._client.upsert, collection_name=collection, points=validated, wait=True))

    def delete_by_version(self, collection, workspace_id, book_id, document_version_id=None):
        from qdrant_client import models
        _collection(collection)
        require_scope(workspace_id, book_id)
        # Whole-book deletion must be a separate, explicit operator workflow.
        require_scope(document_version_id, book_id)
        _require_completed(self._call(self._client.delete, collection_name=collection, wait=True,
            points_selector=models.FilterSelector(filter=models.Filter(must=_conditions({
                "workspace_id": workspace_id, "book_id": book_id, "document_version_id": document_version_id})))))

    def search(self, query_vector, workspace_id, book_id, top_k=5, collection="book_chunks",
               *, document_version_ids=None, embedding_model=None):
        from qdrant_client import models
        _collection(collection)
        require_scope(workspace_id, book_id)
        model = valid_model(embedding_model)
        vector = validate_vector(query_vector, self.dim)
        if type(top_k) is not int or not 1 <= top_k <= 20:
            raise ValueError("Search limit must be 1-20.")
        if not isinstance(document_version_ids, list) or not 1 <= len(document_version_ids) <= 1000:
            raise ValueError("Current document versions are mandatory.")
        for version in document_version_ids:
            require_scope(version, book_id)
        versions = set(document_version_ids)
        filters = _conditions({"workspace_id": workspace_id, "book_id": book_id, "embedding_model": model})
        filters.append(models.FieldCondition(key="document_version_id", match=models.MatchAny(any=sorted(versions))))
        response = self._call(self._client.query_points, collection_name=collection,
            query=list(vector), query_filter=models.Filter(must=filters), limit=top_k,
            with_payload=True, with_vectors=False)
        # Qdrant is a derived index, not a trusted content or tenant boundary.
        try:
            if len(response.points) > top_k:
                raise ValueError("Unbounded vector result.")
            results, identities = [], set()
            for hit in response.points:
                payload = checked_payload(hit.payload, workspace_id, book_id)
                identity = str(hit.id)
                if (payload["document_version_id"] not in versions or payload["embedding_model"] != model
                        or identity != payload_point_id(payload) or identity in identities
                        or type(hit.score) not in (int, float) or not math.isfinite(hit.score)
                        or not -1.000001 <= hit.score <= 1.000001):
                    raise ValueError("Invalid scoped vector evidence.")
                identities.add(identity)
                results.append({**payload, "id": identity, "score": hit.score})
            return results
        except (ValueError, TypeError, AttributeError, KeyError):
            raise QdrantUnavailableError("Vector index returned invalid scoped evidence.") from None
