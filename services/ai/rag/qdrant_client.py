"""Thin Qdrant wrapper (spec section 11).

Four collections (book_chunks, book_bible, style_memory, community_posts),
cosine distance, vector dim from EMBEDDING_DIM (config, not business logic).
EVERY search/delete is filtered by workspace_id + book_id — missing filters
are a hard error (tenant isolation). Qdrant is a derived retrieval index,
never the source of truth; deleted/obsolete versions must be removed.
"""
from __future__ import annotations

import os

COLLECTIONS = ("book_chunks", "book_bible", "style_memory", "community_posts")


class QdrantUnavailableError(RuntimeError):
    """Qdrant is down/unreachable — callers must fail the job, never silently pass."""


class MissingScopeError(ValueError):
    """workspace_id/book_id filter missing — an unscoped query would leak across tenants."""


def _conditions(pairs: dict[str, str]):
    from qdrant_client import models

    return [
        models.FieldCondition(key=k, match=models.MatchValue(value=v))
        for k, v in pairs.items()
        if v
    ]


class QdrantRag:
    """Wraps qdrant_client.QdrantClient. Pass `client` to inject a fake in tests."""

    def __init__(self, client=None, url: str | None = None, api_key: str | None = None, dim: int | None = None):
        self.dim = dim or int(os.environ.get("EMBEDDING_DIM", "1536"))
        if client is None:
            from qdrant_client import QdrantClient

            client = QdrantClient(
                url=url or os.environ.get("QDRANT_URL", "http://localhost:6333"),
                api_key=api_key or os.environ.get("QDRANT_API_KEY"),
            )
        self._client = client

    def _call(self, fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as e:  # connection, timeout, unexpected-response — all fatal to the job
            raise QdrantUnavailableError(f"qdrant call failed: {e}") from e

    def ensure_collections(self) -> None:
        from qdrant_client import models

        for name in COLLECTIONS:
            if not self._call(self._client.collection_exists, name):
                self._call(
                    self._client.create_collection,
                    name,
                    vectors_config=models.VectorParams(size=self.dim, distance=models.Distance.COSINE),
                )

    def upsert_points(self, collection: str, points: list[dict]) -> None:
        """points: [{"id": str, "vector": [...], "payload": {...}}] (spec 11 point shape)."""
        from qdrant_client import models

        self._call(
            self._client.upsert,
            collection_name=collection,
            points=[models.PointStruct(id=p["id"], vector=p["vector"], payload=p["payload"]) for p in points],
        )

    def delete_by_version(
        self,
        collection: str,
        workspace_id: str | None,
        book_id: str | None,
        document_version_id: str | None = None,
    ) -> None:
        """Remove points for a superseded document_version_id, or a whole book when omitted."""
        if not workspace_id or not book_id:
            raise MissingScopeError("workspace_id and book_id filters are mandatory (spec 11)")
        from qdrant_client import models

        self._call(
            self._client.delete,
            collection_name=collection,
            points_selector=models.FilterSelector(
                filter=models.Filter(
                    must=_conditions(
                        {
                            "workspace_id": workspace_id,
                            "book_id": book_id,
                            "document_version_id": document_version_id or "",
                        }
                    )
                )
            ),
        )

    def search(
        self,
        query_vector: list[float],
        workspace_id: str | None,
        book_id: str | None,
        top_k: int = 5,
        collection: str = "book_chunks",
    ) -> list[dict]:
        if not workspace_id or not book_id:
            raise MissingScopeError("workspace_id and book_id filters are mandatory (spec 11)")
        from qdrant_client import models

        hits = self._call(
            self._client.search,
            collection_name=collection,
            query_vector=query_vector,
            query_filter=models.Filter(must=_conditions({"workspace_id": workspace_id, "book_id": book_id})),
            limit=top_k,
            with_payload=True,
        )
        return [{"id": str(h.id), "score": h.score, **(h.payload or {})} for h in hits]
