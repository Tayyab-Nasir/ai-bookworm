"""Step 8 tests: Qdrant wrapper scoping, indexing idempotency, reindex deletion,
embedder determinism, Book Bible candidate validation, consistency diagnostics."""
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agents.bookbible import TOOL_NAME, BookBibleAgent
from agents.consistency import ConsistencyAgent
from agents.copyeditor import get_agent
from gateway import MockProvider
from rag.embeddings import DeterministicMockEmbedder, text_hash
from rag.indexer import chunk_text, index_book_version, point_id
from rag.qdrant_client import COLLECTIONS, MissingScopeError, QdrantRag, QdrantUnavailableError
from tools import InMemoryExecutor

DIM = 8


class FakeQdrantClient:
    """In-memory stand-in implementing the methods QdrantRag uses."""

    def __init__(self):
        self.collections: dict[str, dict] = {}

    def collection_exists(self, name):
        return name in self.collections

    def create_collection(self, name, vectors_config):
        self.collections[name] = {"config": vectors_config, "points": {}}

    def upsert(self, collection_name, points):
        self.collections[collection_name]["points"].update({p.id: p for p in points})

    def delete(self, collection_name, points_selector):
        conds = {c.key: c.match.value for c in points_selector.filter.must}
        pts = self.collections[collection_name]["points"]
        for pid in [pid for pid, p in pts.items() if all(p.payload.get(k) == v for k, v in conds.items())]:
            del pts[pid]

    def search(self, collection_name, query_vector, query_filter, limit, with_payload):
        conds = {c.key: c.match.value for c in query_filter.must}
        pts = self.collections[collection_name]["points"].values()
        hits = [p for p in pts if all(p.payload.get(k) == v for k, v in conds.items())]
        return [SimpleNamespace(id=p.id, score=1.0, payload=p.payload) for p in hits[:limit]]


@pytest.fixture
def rag():
    r = QdrantRag(client=FakeQdrantClient(), dim=DIM)
    r.ensure_collections()
    return r


@pytest.fixture
def embedder():
    return DeterministicMockEmbedder(dim=DIM)


# ---- collections + scoping ----

def test_ensure_collections_creates_all_four(rag):
    assert set(COLLECTIONS) == set(rag._client.collections)
    cfg = rag._client.collections["book_chunks"]["config"]
    assert cfg.size == DIM and str(cfg.distance).lower().endswith("cosine")


@pytest.mark.parametrize("ws,bk", [(None, "b1"), ("w1", None), ("", "b1"), (None, None)])
def test_search_requires_workspace_and_book(rag, ws, bk):
    with pytest.raises(MissingScopeError):
        rag.search([0.1] * DIM, ws, bk)


def test_delete_requires_workspace_and_book(rag):
    with pytest.raises(MissingScopeError):
        rag.delete_by_version("book_chunks", None, "b1", "v1")


def test_search_returns_only_matching_tenant(rag, embedder):
    chapters = [{"id": "c1", "nodes": [{"id": "n1", "text": "alpha text"}]}]
    index_book_version(rag, embedder, "w1", "b1", "v1", chapters)
    index_book_version(rag, embedder, "w1", "b2", "v1", chapters)
    hits = rag.search(embedder.embed(["alpha"])[0], "w1", "b1")
    assert len(hits) == 1 and hits[0]["book_id"] == "b1"


def test_qdrant_down_raises_clear_error(rag):
    def boom(*a, **k):
        raise ConnectionRefusedError("refused")

    rag._client.collection_exists = boom
    with pytest.raises(QdrantUnavailableError, match="qdrant call failed"):
        rag.ensure_collections()


# ---- indexing ----

CHAPTERS = [
    {"id": "c1", "nodes": [{"id": "n1", "text": "First para.\n\nSecond para."}]},
    {"id": "c2", "nodes": [{"id": "n9", "text": "Another node."}]},
]


def test_index_upserts_full_payload(rag, embedder):
    n = index_book_version(rag, embedder, "w1", "b1", "v1", CHAPTERS)
    assert n == 2  # n1's short paragraphs pack into 1 chunk + 1 node in c2
    pt = next(iter(rag._client.collections["book_chunks"]["points"].values()))
    for key in ("workspace_id", "book_id", "chapter_id", "node_id", "document_version_id", "text_hash", "language", "text"):
        assert key in pt.payload
    assert pt.payload["text_hash"] == text_hash(pt.payload["text"])
    assert len(pt.vector) == DIM


def test_point_ids_stable_across_reruns(rag, embedder):
    index_book_version(rag, embedder, "w1", "b1", "v1", CHAPTERS)
    ids_first = set(rag._client.collections["book_chunks"]["points"])
    index_book_version(rag, embedder, "w1", "b1", "v1", CHAPTERS)  # rerun, no delete
    assert ids_first == set(rag._client.collections["book_chunks"]["points"])
    assert point_id("b1", "n1", text_hash("First para.")) == point_id("b1", "n1", text_hash("First para."))


def test_reindex_removes_old_version_points(rag, embedder):
    index_book_version(rag, embedder, "w1", "b1", "v1", CHAPTERS)
    index_book_version(rag, embedder, "w1", "b1", "v2", CHAPTERS[:1], previous_version_id="v1")
    pts = rag._client.collections["book_chunks"]["points"].values()
    assert pts and all(p.payload["document_version_id"] == "v2" for p in pts)


def test_chunk_text_keeps_paragraphs_and_splits_long(embedder):
    assert chunk_text("a\n\nb", size=100) == ["a\n\nb"]
    long = "x" * 5000
    chunks = chunk_text(long, size=2000)
    assert len(chunks) == 3 and "".join(chunks) == long


def test_embedder_deterministic_unit_vectors(embedder):
    v1, v2 = embedder.embed(["hello"])[0], DeterministicMockEmbedder(dim=DIM).embed(["hello"])[0]
    assert v1 == v2
    assert abs(sum(x * x for x in v1) ** 0.5 - 1.0) < 1e-9
    assert len(v1) == DIM


# ---- Book Bible agent ----

CID = "00000000-0000-0000-0000-000000000001"
VID = "00000000-0000-0000-0000-000000000002"
NODE_HASH = "a" * 64
CANDIDATE = {
    "type": "character",
    "name": "Mara",
    "description": "protagonist",
    "attributes": {"eyes": "blue"},
    "sourceRefs": [{"chapterId": CID, "documentVersionId": VID, "nodeId": "n1", "textHash": NODE_HASH}],
    "confidence": 0.8,
}


def make_bookbible_agent(response: dict) -> BookBibleAgent:
    executor = InMemoryExecutor(chapters={CID: {"id": CID, "documentVersionId": VID, "nodes": [{"id": "n1", "text": "Mara had blue eyes.", "textHash": NODE_HASH}]}})
    return BookBibleAgent(MockProvider([response]), executor, "mock-1")


def test_bookbible_emits_candidates_as_suggestions():
    agent = make_bookbible_agent({"toolCalls": [{"name": TOOL_NAME, "input": {"candidates": [CANDIDATE]}}]})
    result = agent.run({"chapterIds": [CID]})
    assert result.status == "succeeded"
    assert result.suggestions == [{**CANDIDATE, "suggestionKind": "book_bible_candidate", "status": "pending"}]
    assert result.diagnostics == []


@pytest.mark.parametrize("mutate", [
    lambda c: c.pop("sourceRefs"),
    lambda c: c.update(type="dragon"),
    lambda c: c.update(confidence=2),
    lambda c: c.update(sourceRefs=[]),
    lambda c: c.update(name=""),
    lambda c: c.update(extra=1),
    lambda c: c["sourceRefs"][0].update(nodeId="invented"),
    lambda c: c["sourceRefs"][0].update(documentVersionId="00000000-0000-0000-0000-000000000003"),
    lambda c: c["sourceRefs"][0].update(textHash="b" * 64),
    lambda c: c.update(name="Mara "),
    lambda c: c.update(attributes={"__proto__": {"admin": True}}),
    lambda c: c.update(attributes={"backstory": "x" * 24001}),
    lambda c: c.update(attributes={"x" * 81: "value"}),
])
def test_bookbible_malformed_candidate_rejected(mutate):
    import copy

    bad = copy.deepcopy(CANDIDATE)
    mutate(bad)
    agent = make_bookbible_agent({"toolCalls": [{"name": TOOL_NAME, "input": {"candidates": [bad]}}]})
    result = agent.run({"chapterIds": [CID]})
    assert result.status == "failed" and "validation" in result.error
    assert result.suggestions == []  # no partial writes


def test_bookbible_rejects_unversioned_manuscript_before_provider_call():
    agent = make_bookbible_agent({"toolCalls": [{"name": TOOL_NAME, "input": {"candidates": [CANDIDATE]}}]})
    del agent.executor.chapters[CID]["documentVersionId"]
    result = agent.run({"chapterIds": [CID]})
    assert result.status == "failed" and "versioned" in result.error
    assert agent.provider.calls == []


def test_bookbible_rejects_unbounded_candidate_batch():
    agent = make_bookbible_agent({"toolCalls": [{"name": TOOL_NAME, "input": {"candidates": [CANDIDATE] * 11}}]})
    result = agent.run({"chapterIds": [CID]})
    assert result.status == "failed" and result.suggestions == []


def test_bookbible_can_report_no_supported_candidates():
    agent = make_bookbible_agent({"toolCalls": [{"name": TOOL_NAME, "input": {"candidates": []}}]})
    result = agent.run({"chapterIds": [CID]})
    assert result.status == "succeeded" and result.suggestions == []


# ---- consistency agent ----

BIBLE = [{"type": "character", "name": "Mara", "attributes": {"eyes": "blue"}, "sourceRefs": [{"chapterId": CID, "nodeId": "n1"}]}]


def make_consistency_agent(response: dict) -> ConsistencyAgent:
    executor = InMemoryExecutor(
        chapters={CID: {"id": CID, "nodes": [{"id": "n1", "text": "Mara blinked her brown eyes."}]}},
        bible=BIBLE,
    )
    return ConsistencyAgent(MockProvider([response]), executor, "mock-1")


def test_consistency_flags_seeded_contradiction():
    diag = {
        "severity": "error",
        "code": "character.eye_color",
        "message": "ch3 says brown eyes; Book Bible says blue",
        "location": {"chapterId": CID, "nodeId": "n1"},
    }
    agent = make_consistency_agent({"toolCalls": [{"name": "create_diagnostic", "input": diag}]})
    result = agent.run({"chapterIds": [CID]})
    assert result.status == "succeeded"
    assert result.diagnostics == [diag]
    # bible was actually in the prompt
    user_msg = agent.provider.calls[0]["messages"][1]["content"]
    assert "blue" in user_msg and "brown" in user_msg


def test_consistency_no_conflict_no_diagnostics():
    agent = make_consistency_agent({"toolCalls": []})
    result = agent.run({"chapterIds": [CID]})
    assert result.status == "succeeded" and result.diagnostics == []


# ---- registry ----

def test_registry_includes_new_agents():
    executor = InMemoryExecutor()
    for t in ("book_bible", "consistency"):
        assert get_agent(t, MockProvider(), executor, "mock-1").agent_type == t
