"""Offline storage contract smoke with lightrag-hku==1.5.7.

Install the pinned SDK in a separate virtual environment and run this file with
that environment's Python. Requires no network or model credentials at runtime.
"""
import asyncio
import hashlib
import json
import os
import re
import socket
import sqlite3
import sys
from contextlib import closing
from importlib.metadata import version
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

os.environ["PYTHON_DOTENV_DISABLED"] = "1"

import numpy as np
from lightrag import LightRAG, QueryParam
from lightrag.utils import EmbeddingFunc, Tokenizer


class FixtureTokenizer:
    """Character tokenizer keeps the small synthetic test offline."""

    def encode(self, text):
        return [ord(char) for char in text]

    def decode(self, tokens):
        return "".join(map(chr, tokens))


async def fixture_embeddings(texts):
    vectors = np.zeros((len(texts), 256), dtype=np.float32)
    for row, text in zip(vectors, texts, strict=True):
        for word in re.findall(r"\w+", text.casefold()):
            index = hashlib.sha256(word.encode()).digest()[0]
            row[index] += 1
    return vectors


async def fixture_extraction(prompt, **_kwargs):
    for subject, item in (("Elara", "silver compass"), ("Elara", "amber lantern"), ("Mira", "cobalt atlas")):
        article = "an" if item == "amber lantern" else "a"
        fact = f"{subject} carries {article} {item}."
        if fact in prompt:
            separator = "<|#|>"
            records = (
                ("entity", subject, "Person", f"A character named {subject}."),
                ("entity", item, "Artifact", f"The {item}."),
                ("relation", subject, item, "carries", fact),
            )
            return "\n".join(separator.join(record) for record in records) + "\n<|COMPLETE|>"
    raise AssertionError("Unexpected LLM input for the deterministic extraction fixture")


def new_scope(root, workspace):
    return LightRAG(
        working_dir=str(root),
        workspace=workspace,
        kv_storage="JsonKVStorage",
        doc_status_storage="JsonDocStatusStorage",
        graph_storage="NetworkXStorage",
        vector_storage="NanoVectorDBStorage",
        tokenizer=Tokenizer("fixture-character", FixtureTokenizer()),
        embedding_func=EmbeddingFunc(embedding_dim=256, max_token_size=1000, func=fixture_embeddings, model_name="fixture-lexical"),
        llm_model_func=fixture_extraction,
        llm_model_name="fixture-graph-extraction",
        enable_llm_cache=False,
        enable_llm_cache_for_entity_extract=False,
        entity_extract_max_gleaning=0,
        cosine_better_than_threshold=0.1,
    )


async def chunks(client, text):
    response = await client.aquery_data(
        text,
        param=QueryParam(mode="naive", top_k=8, chunk_top_k=8, enable_rerank=False),
    )
    return response.get("data", {}).get("chunks", [])


async def assert_one(client, text, path, expected_text):
    result = await chunks(client, text)
    assert len(result) == 1, (text, result)
    hit = result[0]
    assert (hit["file_path"], hit["content"]) == (path, expected_text), hit
    assert hit["reference_id"] and hit["chunk_id"]


async def exercise(root):
    first = new_scope(root, "fixture_book_a")
    second = new_scope(root, "fixture_book_b")
    old = "Elara carries a silver compass."
    replacement = "Elara carries an amber lantern."
    other = "Mira carries a cobalt atlas."
    await first.initialize_storages()
    await second.initialize_storages()
    try:
        await first.ainsert(old, ids="chapter-one", file_paths="book-a/v1/book-a-v1-chapter-one.txt")
        await second.ainsert(other, ids="chapter-one", file_paths="book-b-v1-chapter-one.txt")
        await assert_one(first, "silver compass", "book-a-v1-chapter-one.txt", old)
        await assert_one(second, "cobalt atlas", "book-b-v1-chapter-one.txt", other)
        assert await chunks(first, "cobalt atlas") == []
        assert await chunks(second, "silver compass") == []
        local = QueryParam(mode="local", top_k=8, chunk_top_k=8, ll_keywords=["silver compass"],
                           hl_keywords=["carries"], enable_rerank=False)
        graph_result = (await first.aquery_data("silver compass", param=local))["data"]
        assert any(row["entity_name"].casefold() == "silver compass" for row in graph_result["entities"]), graph_result
        assert any(row["file_path"] == "book-a-v1-chapter-one.txt" for row in graph_result["chunks"]), graph_result
        assert await first.chunk_entity_relation_graph.has_edge("Elara", "silver compass")
        assert not await second.chunk_entity_relation_graph.has_node("silver compass")

        deletion = await first.adelete_by_doc_id("chapter-one")
        assert deletion.status == "success", deletion
        assert await chunks(first, "silver compass") == []
        assert not await first.chunk_entity_relation_graph.has_node("silver compass")
        assert not await first.chunk_entity_relation_graph.has_edge("Elara", "silver compass")
        assert await second.chunk_entity_relation_graph.has_edge("Mira", "cobalt atlas")
        await first.ainsert(replacement, ids="chapter-two", file_paths="book-a-v2-chapter-one.txt")
        await assert_one(first, "amber lantern", "book-a-v2-chapter-one.txt", replacement)
        assert await chunks(first, "silver compass") == []
        await assert_one(second, "cobalt atlas", "book-b-v1-chapter-one.txt", other)
    finally:
        await second.finalize_storages()
        await first.finalize_storages()

    reopened = new_scope(root, "fixture_book_a")
    await reopened.initialize_storages()
    try:
        await assert_one(reopened, "amber lantern", "book-a-v2-chapter-one.txt", replacement)
        assert await chunks(reopened, "silver compass") == []
        assert await chunks(reopened, "cobalt atlas") == []
        assert await reopened.chunk_entity_relation_graph.has_edge("Elara", "amber lantern")
        assert not await reopened.chunk_entity_relation_graph.has_node("silver compass")
    finally:
        await reopened.finalize_storages()


async def exercise_repeated_content(root):
    client = new_scope(root, "fixture_book_repeated")
    passage = "Elara carries a silver compass."
    await client.initialize_storages()
    try:
        await client.ainsert(passage, ids="chapter-a", file_paths="opaque-a.txt")
        await client.ainsert(passage, ids="chapter-b", file_paths="opaque-b.txt")
        before = await chunks(client, "silver compass")
        deletion = await client.adelete_by_doc_id("chapter-a")
        assert deletion.status == "success", deletion
        remaining = await chunks(client, "silver compass")
        # Record the current behavior of the pinned version. A single surviving
        # citation here would require rechecking the duplicate-content policy.
        assert [row["file_path"] for row in before] == ["opaque-a.txt"], before
        assert remaining == [], remaining
    finally:
        await client.finalize_storages()


def opaque_passage_name(scope, passage):
    digest = hashlib.sha256(f"{scope}\0{passage}".encode()).hexdigest()
    return f"{digest}.txt"


def resolve_current_occurrences(scope, hits, current_chapters):
    """Resolve hints using a fresh, authorized snapshot of canonical sources."""
    candidates = {(row["file_path"], row["content"]) for row in hits}
    return sorted(
        (chapter, revision) for chapter, (revision, text) in current_chapters.items()
        if (opaque_passage_name(scope, text), text) in candidates
    )


async def exercise_occurrence_binding(root):
    passage = "Elara carries a silver compass."
    changed = "Elara carries an amber lantern."
    for removed, survivor in (("a", "b"), ("b", "a")):
        scope = f"fixture_book_bind_{removed}"
        client = new_scope(root, scope)
        name = opaque_passage_name(scope, passage)
        index_id = name.removesuffix(".txt")
        current = {"a": ("a-v1", passage), "b": ("b-v1", passage)}
        await client.initialize_storages()
        try:
            await client.ainsert(passage, ids=index_id, file_paths=name)
            candidates = await chunks(client, "silver compass")
            assert len(candidates) == 1
            assert resolve_current_occurrences(scope, candidates, current) == [("a", "a-v1"), ("b", "b-v1")]
            assert resolve_current_occurrences("other_book", candidates, current) == []
            altered = [{**candidates[0], "content": changed}]
            assert resolve_current_occurrences(scope, altered, current) == []

            # The index entry belongs to the content, not the first chapter.
            del current[removed]
            candidates = await chunks(client, "silver compass")
            assert resolve_current_occurrences(scope, candidates, current) == [(survivor, f"{survivor}-v1")]

            # A late response from before the update cannot cite an older revision.
            current[survivor] = (f"{survivor}-v2", changed)
            assert resolve_current_occurrences(scope, candidates, current) == []
            assert (await client.adelete_by_doc_id(index_id)).status == "success"
            assert await chunks(client, "silver compass") == []

            # Even a slow writer repopulating the index cannot restore authority.
            await client.ainsert(passage, ids=index_id, file_paths=name)
            stale = await chunks(client, "silver compass")
            assert len(stale) == 1
            assert resolve_current_occurrences(scope, stale, current) == []
            assert (await client.adelete_by_doc_id(index_id)).status == "success"
        finally:
            await client.finalize_storages()


async def reconcile_fixture_passage(client, book_lock, latest, passage, filename):
    """Apply current desired state under the single fixture writer's book lock."""
    index_id = filename.removesuffix(".txt")
    async with book_lock:
        for _ in range(4):
            generation, occurrences = latest()
            if occurrences:
                await client.ainsert(passage, ids=index_id, file_paths=filename)
            else:
                result = await client.adelete_by_doc_id(index_id)
                if result.status not in {"success", "not_found"}:
                    raise RuntimeError("Passage cleanup needs reconciliation")
            if latest()[0] == generation:
                return generation
        raise RuntimeError("Passage changed during reconciliation")


async def exercise_index_cleanup(root):
    scope = "fixture_book_worker_order"
    client = new_scope(root, scope)
    passage = "Elara carries a silver compass."
    filename = opaque_passage_name(scope, passage)
    lock = asyncio.Lock()
    state = (1, frozenset({"chapter-a", "chapter-b"}))

    def latest():
        return state

    async def reconcile():
        return await reconcile_fixture_passage(client, lock, latest, passage, filename)

    await client.initialize_storages()
    try:
        await reconcile()
        state = (2, frozenset({"chapter-b"}))
        await reconcile()
        await assert_one(client, "silver compass", filename, passage)

        # Simulate a missing index during repair so the paused write really inserts.
        assert (await client.adelete_by_doc_id(filename.removesuffix(".txt"))).status == "success"
        insert = client.ainsert
        started = asyncio.Event()
        resume = asyncio.Event()

        async def slow_insert(*args, **kwargs):
            started.set()
            await resume.wait()
            await insert(*args, **kwargs)
            await assert_one(client, "silver compass", filename, passage)

        with patch.object(client, "ainsert", slow_insert):
            async with asyncio.TaskGroup() as tasks:
                slow = tasks.create_task(reconcile())
                await asyncio.wait_for(started.wait(), timeout=5)
                state = (3, frozenset())
                cleanup = tasks.create_task(reconcile())
                resume.set()
            assert slow.result() == cleanup.result() == 3
        assert await chunks(client, "silver compass") == []
        assert not await client.chunk_entity_relation_graph.has_edge("Elara", "silver compass")

        # A delete whose acknowledgement was lost remains safe to retry.
        state = (4, frozenset({"chapter-c"}))
        await reconcile()
        state = (5, frozenset())
        delete = client.adelete_by_doc_id

        async def lose_delete_reply(index_id):
            assert (await delete(index_id)).status == "success"
            raise ConnectionError("Fixture lost a completed deletion reply")

        with patch.object(client, "adelete_by_doc_id", lose_delete_reply):
            try:
                await reconcile()
            except ConnectionError:
                pass
            else:
                raise AssertionError("An unconfirmed deletion must stay pending")
        assert await reconcile() == 5
    finally:
        await client.finalize_storages()

    reopened = new_scope(root, scope)
    await reopened.initialize_storages()
    try:
        assert await chunks(reopened, "silver compass") == []
        assert not await reopened.chunk_entity_relation_graph.has_edge("Elara", "silver compass")
    finally:
        await reopened.finalize_storages()


def reject_connection(*_args, **_kwargs):
    raise AssertionError("Network connection attempted during LightRAG fixture")


def authority_row(root):
    with closing(sqlite3.connect(root / "authority.sqlite")) as database:
        return database.execute("select generation, occurrences, applied from desired").fetchone()


async def failover_writer(root, first):
    disposable = root.name == "process-failover" and root.parent.name.startswith("bookiewookie-lightrag-")
    if not disposable or not (root / "authority.sqlite").is_file():
        raise RuntimeError("Failover writer requires an initialized disposable fixture")
    scope = "fixture_book_failover"
    passage = "Elara carries a silver compass."
    filename = opaque_passage_name(scope, passage)
    client = new_scope(root, scope)
    # The fixture's lock and desired state use separate files so an author can
    # commit removal while the index owner still holds its independent lock.
    with closing(sqlite3.connect(root / "book-lock.sqlite", timeout=0)) as ownership:
        if first:
            ownership.execute("begin immediate")
        else:
            try:
                ownership.execute("begin immediate")
            except sqlite3.OperationalError as error:
                if error.sqlite_errorcode != sqlite3.SQLITE_BUSY:
                    raise
                (root / "takeover-waiting").touch()
                ownership.execute("pragma busy_timeout=10000")
                ownership.execute("begin immediate")
            else:
                raise AssertionError("Successor acquired the book while the first writer still owned it")

        await client.initialize_storages()
        try:
            if first:
                assert authority_row(root) == (1, 1, 0)
                await client.ainsert(passage, ids=filename.removesuffix(".txt"), file_paths=filename)
                await assert_one(client, "silver compass", filename, passage)
            else:
                assert authority_row(root) == (2, 0, 0)
                await assert_one(client, "silver compass", filename, passage)
                result = await client.adelete_by_doc_id(filename.removesuffix(".txt"))
                assert result.status == "success", result
        finally:
            await client.finalize_storages()

        if first:
            (root / "first-write-durable").touch()
            await asyncio.sleep(20)
            raise AssertionError("The fixture parent did not stop the first writer")

        with closing(sqlite3.connect(root / "authority.sqlite")) as database, database:
            changed = database.execute("update desired set applied=2 where generation=2 and occurrences=0")
            assert changed.rowcount == 1
        ownership.commit()


async def exercise_process_failover(root):
    root.mkdir()
    with closing(sqlite3.connect(root / "authority.sqlite")) as database, database:
        database.execute("create table desired(generation int, occurrences int, applied int)")
        database.execute("insert into desired values(1,1,0)")

    async def start(mode):
        with (root / f"{mode}.log").open("wb") as log:
            return await asyncio.create_subprocess_exec(
                sys.executable, str(Path(__file__).resolve()), "--failover-writer", str(root), mode,
                stdout=log, stderr=log,
            )

    async def wait_for_marker(path, worker, mode):
        async with asyncio.timeout(12):
            while not path.exists():
                assert worker.returncode is None, (root / f"{mode}.log").read_text(encoding="utf-8")
                await asyncio.sleep(0.025)

    first = await start("first")
    successor = None
    try:
        await wait_for_marker(root / "first-write-durable", first, "first")
        assert authority_row(root) == (1, 1, 0)
        with closing(sqlite3.connect(root / "authority.sqlite")) as database, database:
            database.execute("update desired set generation=2, occurrences=0")
        successor = await start("successor")
        await wait_for_marker(root / "takeover-waiting", successor, "successor")
        assert authority_row(root) == (2, 0, 0)
        first.kill()
        assert await asyncio.wait_for(first.wait(), timeout=5) != 0
        assert await asyncio.wait_for(successor.wait(), timeout=12) == 0, (
            root / "successor.log"
        ).read_text(encoding="utf-8")
        assert authority_row(root) == (2, 0, 2)
    finally:
        for worker in (first, successor):
            if worker is not None and worker.returncode is None:
                worker.kill()
                await worker.wait()

    reopened = new_scope(root, "fixture_book_failover")
    await reopened.initialize_storages()
    try:
        assert await chunks(reopened, "silver compass") == []
        assert not await reopened.chunk_entity_relation_graph.has_edge("Elara", "silver compass")
    finally:
        await reopened.finalize_storages()


async def main():
    assert version("lightrag-hku") == "1.5.7"
    with TemporaryDirectory(prefix="bookiewookie-lightrag-") as root:
        with patch.object(socket.socket, "connect", reject_connection), patch.object(socket.socket, "connect_ex", reject_connection):
            await exercise(Path(root))
            await exercise_repeated_content(Path(root))
            await exercise_occurrence_binding(Path(root))
            await exercise_index_cleanup(Path(root))
            await exercise_process_failover(Path(root) / "process-failover")
    print(json.dumps({
        "lightrag": version("lightrag-hku"),
        "modes": ["naive", "local"],
        "two_workspaces_same_document_id": "passed",
        "exact_chunk_and_reference": "passed",
        "reference_uses_filename": "confirmed",
        "graph_relation_lifecycle": "passed",
        "delete_replace_and_reopen": "passed",
        "repeated_content": "second source omitted; no citation remains after first is deleted",
        "occurrence_binding": "either occurrence survives independently; stale and foreign hints rejected",
        "index_cleanup": "single-writer late insertion converges; lost deletion reply retries and stays removed",
        "process_failover": "new owner waited for crashed writer and applied the newest generation",
    }))


async def isolated_failover_writer(root, first):
    assert version("lightrag-hku") == "1.5.7"
    with patch.object(socket.socket, "connect", reject_connection), patch.object(socket.socket, "connect_ex", reject_connection):
        await failover_writer(root, first)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--failover-writer" and sys.argv[3] in {"first", "successor"}:
        asyncio.run(isolated_failover_writer(Path(sys.argv[2]), sys.argv[3] == "first"))
    else:
        asyncio.run(main())
