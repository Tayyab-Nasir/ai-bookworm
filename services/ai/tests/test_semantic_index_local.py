"""Actual local Qdrant adapter acceptance; no network, provider key or model download.

Hash vectors prove indexing/filtering/integrity, NOT semantic recall quality.
"""
import sys
import copy
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from qdrant_client import QdrantClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from rag.embeddings import DeterministicMockEmbedder
from rag.indexer import index_book_version, prepare_book_version, write_prepared_index, chunk_text
from rag.qdrant_client import QdrantRag, QdrantUnavailableError, MissingScopeError

DIM = 8
CHAPTERS = [{"id": "chapter-a", "nodes": [{"id": "node-a", "text": "The lighthouse keeper carried a silver key."}]}]


@pytest.fixture
def native_rag():
    client = QdrantClient(":memory:")
    rag = QdrantRag(client=client, dim=DIM)
    rag.ensure_collections()
    yield rag
    client.close()


def query(rag, embedder, workspace="workspace-a", version="version-a"):
    return rag.search(embedder.embed(["silver key"]).vectors[0], workspace, "book-a",
                      document_version_ids=[version], embedding_model=embedder.model)


def test_real_local_client_queries_exact_current_version(native_rag):
    embedder = DeterministicMockEmbedder(dim=DIM)
    result = index_book_version(native_rag, embedder, "workspace-a", "book-a", "version-a", CHAPTERS)
    assert result.points_upserted == 1
    assert result.embedding_receipt.provider == "mock"
    hits = query(native_rag, embedder)
    assert len(hits) == 1 and hits[0]["document_version_id"] == "version-a"
    assert query(native_rag, embedder, version="version-b") == []


def test_equal_book_node_text_never_collides_across_workspaces(native_rag):
    embedder = DeterministicMockEmbedder(dim=DIM)
    for workspace in ["workspace-a", "workspace-b"]:
        index_book_version(native_rag, embedder, workspace, "book-a", "version-a", CHAPTERS)
    assert len(query(native_rag, embedder, "workspace-a")) == 1
    assert len(query(native_rag, embedder, "workspace-b")) == 1


def test_identical_repeated_chunks_remain_distinct(native_rag):
    embedder = DeterministicMockEmbedder(dim=DIM)
    index_book_version(native_rag, embedder, "workspace-a", "book-a", "version-a",
                       [{"id": "chapter-a", "nodes": [{"id": "node-a", "text": "a" * 4000}]}])
    hits = query(native_rag, embedder)
    assert len(hits) == 2
    assert {hit["chunk_index"] for hit in hits} == {0, 1}


def test_failed_embedding_does_not_remove_previous_index(native_rag):
    embedder = DeterministicMockEmbedder(dim=DIM)
    index_book_version(native_rag, embedder, "workspace-a", "book-a", "version-a", CHAPTERS)

    class FailingEmbedder:
        name = "mock"
        dim, model = DIM, embedder.model

        def embed(self, _texts):
            raise RuntimeError("Synthetic provider failure")

    with pytest.raises(RuntimeError):
        index_book_version(native_rag, FailingEmbedder(), "workspace-a", "book-a", "version-b",
                           CHAPTERS, previous_version_id="version-a")
    assert len(query(native_rag, embedder)) == 1


def test_old_index_job_cannot_overwrite_current_version(native_rag):
    embedder = DeterministicMockEmbedder(dim=DIM)
    index_book_version(native_rag, embedder, "workspace-a", "book-a", "version-b", CHAPTERS)
    # A delayed older task can add obsolete derived points, but not replace vB.
    index_book_version(native_rag, embedder, "workspace-a", "book-a", "version-a", CHAPTERS)
    current = query(native_rag, embedder, version="version-b")
    assert len(current) == 1 and current[0]["document_version_id"] == "version-b"


def test_committed_upsert_lost_reply_retries_vectors_without_embedding_again(native_rag, monkeypatch):
    class CountingEmbedder(DeterministicMockEmbedder):
        calls = 0

        def embed(self, texts):
            self.calls += 1
            return super().embed(texts)

    embedder = CountingEmbedder(dim=DIM)
    index_book_version(native_rag, embedder, "workspace-a", "book-a", "version-a", CHAPTERS)
    prepared = prepare_book_version(embedder, "workspace-a", "book-a", "version-b", CHAPTERS,
                                    previous_version_id="version-a")
    assert embedder.calls == 2
    original = native_rag._client.upsert
    writes = []

    def uncertain(**kwargs):
        writes.append(kwargs)
        result = original(**kwargs)
        if len(writes) == 1:
            raise TimeoutError("Synthetic reply lost after committed derived write")
        return result

    monkeypatch.setattr(native_rag._client, "upsert", uncertain)
    with pytest.raises(QdrantUnavailableError):
        write_prepared_index(native_rag, prepared)
    assert embedder.calls == 2
    # Both snapshots coexist after ambiguity. Current-version reads select vB.
    assert len(query(native_rag, DeterministicMockEmbedder(dim=DIM))) == 1
    assert len(query(native_rag, DeterministicMockEmbedder(dim=DIM), version="version-b")) == 1
    recovered = write_prepared_index(native_rag, prepared)
    assert recovered.embedding_receipt == prepared.embedding_receipt
    assert embedder.calls == 2 and len(writes) == 2
    assert writes[0]["points"] == writes[1]["points"]
    assert query(native_rag, DeterministicMockEmbedder(dim=DIM)) == []


def test_failed_cleanup_is_safe_to_repeat_without_regenerating(native_rag, monkeypatch):
    embedder = DeterministicMockEmbedder(dim=DIM)
    index_book_version(native_rag, embedder, "workspace-a", "book-a", "version-a", CHAPTERS)
    prepared = prepare_book_version(embedder, "workspace-a", "book-a", "version-b", CHAPTERS,
                                    previous_version_id="version-a")
    original = native_rag._client.delete
    monkeypatch.setattr(native_rag._client, "delete", lambda **_kwargs: (_ for _ in ()).throw(TimeoutError("synthetic")))
    with pytest.raises(QdrantUnavailableError):
        write_prepared_index(native_rag, prepared)
    assert len(query(native_rag, embedder, version="version-b")) == 1
    monkeypatch.setattr(native_rag._client, "delete", original)
    write_prepared_index(native_rag, prepared)
    assert query(native_rag, embedder) == []
    assert len(query(native_rag, embedder, version="version-b")) == 1


@pytest.mark.parametrize("change", [
    lambda p: replace(p, dimensions=9),
    lambda p: replace(p, previous_version_id=p.version_id),
    lambda p: replace(p, embedding_receipt=replace(p.embedding_receipt, input_sha256="f" * 64)),
    lambda p: replace(p, points=p.points + p.points),
    lambda p: replace(p, points=({**p.points[0], "vector": [float("nan")] * DIM},)),
    lambda p: replace(p, points=({**p.points[0], "id": "forged"},)),
    lambda p: replace(p, points=({**p.points[0], "payload": {**p.points[0]["payload"], "workspace_id": "foreign"}},)),
])
def test_invalid_prepared_retry_changes_nothing(native_rag, change):
    embedder = DeterministicMockEmbedder(dim=DIM)
    index_book_version(native_rag, embedder, "workspace-a", "book-a", "version-a", CHAPTERS)
    prepared = prepare_book_version(embedder, "workspace-a", "book-a", "version-b", CHAPTERS,
                                    previous_version_id="version-a")
    with pytest.raises(ValueError):
        write_prepared_index(native_rag, change(prepared))
    assert len(query(native_rag, embedder)) == 1
    assert query(native_rag, embedder, version="version-b") == []


@pytest.mark.parametrize("changes", [{"document_version_ids": None}, {"document_version_ids": []},
    {"document_version_ids": [""]}, {"embedding_model": None}, {"top_k": 0}, {"top_k": True},
    {"top_k": 21}, {"collection": "untrusted"}, {"query_vector": [0.0] * DIM}])
def test_query_requires_bounded_scope_model_and_current_versions(native_rag, changes):
    args = {"query_vector": [0.1] * DIM, "workspace_id": "workspace-a", "book_id": "book-a",
            "document_version_ids": ["version-a"], "embedding_model": "deterministic-mock-v1"}
    with pytest.raises(ValueError):
        native_rag.search(**{**args, **changes})


@pytest.mark.parametrize("scope", ["", " workspace-a", "workspace-a\n", "work\x00space", None])
def test_invalid_scope_rejected_before_embedding(native_rag, scope):
    class NeverEmbed:
        name, dim, model = "mock", DIM, "deterministic-mock-v1"

        def embed(self, _texts):
            pytest.fail("Invalid scope dispatched an embedding")

    with pytest.raises(MissingScopeError):
        index_book_version(native_rag, NeverEmbed(), scope, "book-a", "version-a", CHAPTERS)


def test_model_and_chapter_identity_do_not_collide(native_rag):
    embedder = DeterministicMockEmbedder(dim=DIM)
    chapters = copy.deepcopy(CHAPTERS)
    chapters.append({**copy.deepcopy(CHAPTERS[0]), "id": "chapter-b"})
    index_book_version(native_rag, embedder, "workspace-a", "book-a", "version-a", chapters)
    hits = query(native_rag, embedder)
    assert {h["chapter_id"] for h in hits} == {"chapter-a", "chapter-b"}
    assert native_rag.search([0.1] * DIM, "workspace-a", "book-a", document_version_ids=["version-a"],
                             embedding_model="other-model") == []


def test_incompatible_existing_collection_not_recreated(native_rag):
    incompatible = QdrantRag(client=native_rag._client, dim=16)
    with pytest.raises(ValueError, match="incompatible"):
        incompatible.ensure_collections()
    assert native_rag._client.get_collection("book_chunks").config.params.vectors.size == DIM


@pytest.mark.parametrize("size", [0, -1, True, 2001])
def test_chunk_size_cannot_hang_or_escape_bound(size):
    with pytest.raises(ValueError):
        chunk_text("text", size)


def test_empty_version_retires_only_the_explicit_previous_version(native_rag):
    embedder = DeterministicMockEmbedder(dim=DIM)
    index_book_version(native_rag, embedder, "workspace-a", "book-a", "version-a", CHAPTERS)
    index_book_version(native_rag, embedder, "workspace-b", "book-a", "version-a", CHAPTERS)
    result = index_book_version(native_rag, embedder, "workspace-a", "book-a", "version-b", [],
                                previous_version_id="version-a")
    assert result.points_upserted == 0 and result.embedding_receipt is None
    assert query(native_rag, embedder) == []
    assert len(query(native_rag, embedder, workspace="workspace-b")) == 1
    with pytest.raises(MissingScopeError):
        native_rag.delete_by_version("book_chunks", "workspace-b", "book-a")


@pytest.mark.parametrize("field,value", [("dim", 0), ("dim", True), ("dim", 65_537), ("model", "")])
def test_invalid_configuration_rejected_before_embedding(field, value):
    embedder = DeterministicMockEmbedder(dim=DIM)
    setattr(embedder, field, value)
    calls = []
    embedder.embed = lambda texts: calls.append(texts)
    with pytest.raises(ValueError):
        prepare_book_version(embedder, "workspace-a", "book-a", "version-a", CHAPTERS)
    assert calls == []


@pytest.mark.parametrize("status", ["acknowledged", "unknown", None])
def test_unconfirmed_upsert_cannot_retire_previous_version(native_rag, monkeypatch, status):
    embedder = DeterministicMockEmbedder(dim=DIM)
    index_book_version(native_rag, embedder, "workspace-a", "book-a", "version-a", CHAPTERS)
    prepared = prepare_book_version(embedder, "workspace-a", "book-a", "version-b", CHAPTERS,
                                    previous_version_id="version-a")
    monkeypatch.setattr(native_rag._client, "upsert", lambda **_kwargs: SimpleNamespace(status=status))
    with pytest.raises(QdrantUnavailableError, match="not confirmed"):
        write_prepared_index(native_rag, prepared)
    assert len(query(native_rag, embedder)) == 1


def test_unconfirmed_cleanup_is_not_reported_complete(native_rag, monkeypatch):
    embedder = DeterministicMockEmbedder(dim=DIM)
    index_book_version(native_rag, embedder, "workspace-a", "book-a", "version-a", CHAPTERS)
    prepared = prepare_book_version(embedder, "workspace-a", "book-a", "version-b", CHAPTERS,
                                    previous_version_id="version-a")
    monkeypatch.setattr(native_rag._client, "delete", lambda **_kwargs: SimpleNamespace(status="acknowledged"))
    with pytest.raises(QdrantUnavailableError, match="not confirmed"):
        write_prepared_index(native_rag, prepared)
    assert len(query(native_rag, embedder)) == len(query(native_rag, embedder, version="version-b")) == 1


@pytest.mark.parametrize("change", [
    lambda r: r.points[0].payload.update(workspace_id="foreign"),
    lambda r: r.points[0].payload.update(book_id="foreign"),
    lambda r: r.points[0].payload.update(document_version_id="stale"),
    lambda r: r.points[0].payload.update(embedding_model="unexpected"),
    lambda r: r.points[0].payload.update(node_id=None),
    lambda r: r.points[0].payload.update(chunk_index=True),
    lambda r: r.points[0].payload.update(text="Tampered source"),
    lambda r: r.points[0].payload.update(text_hash="f" * 64),
    lambda r: setattr(r.points[0], "id", "forged"),
    lambda r: setattr(r.points[0], "score", float("nan")),
    lambda r: setattr(r.points[0], "score", float("inf")),
    lambda r: setattr(r.points[0], "score", True),
    lambda r: setattr(r.points[0], "score", 1.01),
    lambda r: r.points.append(r.points[0]),
    lambda r: setattr(r, "points", r.points * 6),
    lambda r: setattr(r, "points", None),
])
def test_untrusted_index_evidence_rejected(native_rag, monkeypatch, change):
    embedder = DeterministicMockEmbedder(dim=DIM)
    prepared = prepare_book_version(embedder, "workspace-a", "book-a", "version-a", CHAPTERS)
    point = prepared.points[0]
    result = SimpleNamespace(points=[SimpleNamespace(id=point["id"], score=0.8, payload=copy.deepcopy(point["payload"]))])
    change(result)
    monkeypatch.setattr(native_rag._client, "query_points", lambda **_kwargs: result)
    with pytest.raises(QdrantUnavailableError, match="invalid scoped evidence"):
        query(native_rag, embedder)


def test_payload_cannot_spoof_transport_identity_or_score(native_rag, monkeypatch):
    embedder = DeterministicMockEmbedder(dim=DIM)
    prepared = prepare_book_version(embedder, "workspace-a", "book-a", "version-a", CHAPTERS)
    point = prepared.points[0]
    payload = {**point["payload"], "id": "spoofed", "score": 999, "extra": "untrusted"}
    result = SimpleNamespace(points=[SimpleNamespace(id=point["id"], score=0.8, payload=payload)])
    monkeypatch.setattr(native_rag._client, "query_points", lambda **_kwargs: result)
    hit = query(native_rag, embedder)[0]
    assert hit["id"] == point["id"] and hit["score"] == 0.8 and "extra" not in hit


def test_vector_transport_exception_is_redacted(native_rag, monkeypatch):
    def uncertain(**_kwargs):
        raise TimeoutError("Sensitive source text and credential-bearing URL")

    monkeypatch.setattr(native_rag._client, "query_points", uncertain)
    with pytest.raises(QdrantUnavailableError) as error:
        query(native_rag, DeterministicMockEmbedder(dim=DIM))
    assert "Sensitive" not in str(error.value) and error.value.__suppress_context__ is True
