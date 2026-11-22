"""Compare the shared synthetic retrieval fixture with LightRAG + local E5."""
import argparse
import asyncio
import hashlib
import json
import os
import socket
from importlib.metadata import version
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter
from unittest.mock import patch

os.environ["PYTHON_DOTENV_DISABLED"] = "1"

import numpy as np
import onnxruntime as ort
from lightrag import LightRAG, QueryParam
from lightrag.base import DocStatus
from lightrag.utils import EmbeddingFunc, Tokenizer
from tokenizers import Tokenizer as ModelTokenizer

from book_retrieval_nli import LocalEvidenceCheck

class FixtureTokenizer:
    def encode(self, text):
        return list(map(ord, text))

    def decode(self, tokens):
        return "".join(map(chr, tokens))

MODEL_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
MODEL_FILE = "model_qint8_avx512_vnni.onnx"
MODEL_HASHES = {
    MODEL_FILE: "dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88",
    "tokenizer.json": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
}
FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "book-retrieval.json"
LIMIT = 8


class LocalE5:
    def __init__(self, model_dir):
        for filename, expected in MODEL_HASHES.items():
            with (model_dir / filename).open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                    raise ValueError(f"Unexpected model file digest: {filename}")
        self.tokenizer = ModelTokenizer.from_file(str(model_dir / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=512)
        self.tokenizer.enable_padding(pad_id=1, pad_token="<pad>")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(model_dir / MODEL_FILE), sess_options=options, providers=["CPUExecutionProvider"],
        )
        self.input_names = {item.name for item in self.session.get_inputs()}

    async def embed(self, texts, context=None):
        prefix = "query: " if context == "query" else "passage: "
        encoded = self.tokenizer.encode_batch([prefix + text for text in texts])
        mask = np.asarray([item.attention_mask for item in encoded], dtype=np.int64)
        inputs = {
            "input_ids": np.asarray([item.ids for item in encoded], dtype=np.int64),
            "attention_mask": mask,
            "token_type_ids": np.asarray([item.type_ids for item in encoded], dtype=np.int64),
        }
        hidden, *_ = self.session.run(None, {name: inputs[name] for name in self.input_names})
        pooled = (hidden * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1, keepdims=True)
        return (pooled / np.linalg.norm(pooled, axis=1, keepdims=True)).astype(np.float32)


async def empty_extraction(_prompt, **_kwargs):
    # This comparison isolates vector retrieval from graph extraction and generation.
    return "<|COMPLETE|>"


def evaluate_sources(fixture, result, expected):
    data = result.get("data") or {}
    references = {row["reference_id"]: row["file_path"] for row in data.get("references", [])}
    sources = []
    for hit in data.get("chunks", []):
        reference = references[hit["reference_id"]]
        title, original = fixture[reference]
        assert reference == hit["file_path"] and original == hit["content"], "citation mismatch"
        assert hit["chunk_id"], "chunk ID missing"
        sources.append(title)
    return {
        "expected": len(expected),
        "retrieved": len(set(expected).intersection(sources)),
        "candidates": len(sources),
        "first": sources[0] if sources else None,
        "firstRelevant": bool(sources and sources[0] in expected),
    }


async def evaluate(model, root, fixture_path, verifier=None, claims=None):
    raw = fixture_path.read_bytes()
    fixture_hash = hashlib.sha256(raw).hexdigest()
    fixture = json.loads(raw)
    if claims is not None and claims.keys() != {query for _, query, _ in fixture["queries"]}:
        raise ValueError("Claims must cover exactly the evaluation questions")
    background = fixture["background"]
    # Repeated identical background paragraphs share one source per chapter here.
    passages = [*fixture["passages"], *(
        (f"Background {index}", f"{background['paragraph']} {index}.")
        for index in range(1, background["chapters"] + 1)
    )]
    bible = fixture["bible"]
    passages.append(("Bible", "\n".join((bible["name"], bible["description"], "{}"))))
    labels = {f"source-{number:04d}.txt": passage for number, passage in enumerate(passages)}
    async def embed(texts, context=None):
        return await model.embed(texts, context)

    rag = LightRAG(
        working_dir=root,
        workspace="synthetic_comparison",
        kv_storage="JsonKVStorage",
        doc_status_storage="JsonDocStatusStorage",
        graph_storage="NetworkXStorage",
        vector_storage="NanoVectorDBStorage",
        tokenizer=Tokenizer("fixture-character", FixtureTokenizer()),
        embedding_func=EmbeddingFunc(
            embedding_dim=384, max_token_size=512, func=embed,
            model_name="multilingual-e5-small", supports_asymmetric=True,
        ),
        llm_model_func=empty_extraction,
        llm_model_name="fixture-empty-extraction",
        enable_llm_cache=False,
        enable_llm_cache_for_entity_extract=False,
        entity_extract_max_gleaning=0,
        max_parallel_insert=8,
        cosine_better_than_threshold=0.1,
    )
    await rag.initialize_storages()
    try:
        started = perf_counter()
        await rag.ainsert(
            [text for _, text in labels.values()],
            ids=[Path(filename).stem for filename in labels],
            file_paths=list(labels),
        )
        indexed = await rag.doc_status.get_docs_by_statuses([DocStatus.PROCESSED])
        assert len(indexed) == len(labels), "corpus was not fully indexed"
        index_seconds = round(perf_counter() - started, 3)
        rows = []
        evidence_rows = []
        calibration = verifier.calibration() if verifier else None
        for scenario, query, expected in fixture["queries"]:
            started = perf_counter()
            result = await rag.aquery_data(query, param=QueryParam(
                mode="naive", top_k=LIMIT, chunk_top_k=LIMIT, enable_rerank=False,
            ))
            texts = [chunk["content"] for chunk in (result.get("data") or {}).get("chunks", [])[:2]]
            scores = []
            if texts:
                vector = (await model.embed([query], "query"))[0]
                scores = (await model.embed(texts, "document") @ vector).tolist()
            rows.append({
                "scenario": scenario, "query": query,
                "cosine": round(scores[0], 6) if scores else None,
                "margin": round(scores[0] - scores[1], 6) if len(scores) == 2 else None,
                **evaluate_sources(labels, result, expected),
                "queryMs": round((perf_counter() - started) * 1000, 1),
            })
            if verifier:
                retrieved = (result.get("data") or {}).get("chunks", [])
                nli = verifier.classify([hit["content"] for hit in retrieved], claims[query])
                supported = [
                    (labels[hit["file_path"]][0], row["entailment"])
                    for hit, row in zip(retrieved, nli, strict=True)
                    if row["label"] == "entailment" and row["entailment"] > calibration["strictlyAbove"]
                ]
                selected = max(supported, key=lambda item: item[1], default=None)
                evidence_rows.append({
                    "scenario": scenario, "query": query, "expected": expected,
                    "selected": selected[0] if selected else None,
                    "support": round(selected[1], 6) if selected else None,
                    "correct": bool(selected and selected[0] in expected),
                })
        evidence = {}
        if verifier:
            evidence = {
                "evidenceVerification": {
                    "modelRevision": verifier.revision,
                    "calibration": calibration,
                    "correct": sum(row["correct"] for row in evidence_rows),
                    "incorrect": sum(row["selected"] is not None and not row["correct"] for row in evidence_rows),
                    "unsupportedAccepted": sum(not row["expected"] and row["selected"] is not None for row in evidence_rows),
                    "abstained": sum(row["selected"] is None for row in evidence_rows),
                    "rows": evidence_rows,
                }
            }
        return {
            "backend": "lightrag-vector", "modelRevision": MODEL_REVISION, "fixtureHash": fixture_hash,
            "sources": len(labels), "limit": LIMIT, "indexSeconds": index_seconds,
            "expected": sum(row["expected"] for row in rows),
            "retrieved": sum(row["retrieved"] for row in rows),
            "candidates": sum(row["candidates"] for row in rows),
            "firstRelevant": sum(row["firstRelevant"] for row in rows),
            "rows": rows,
            **evidence,
        }
    finally:
        await rag.finalize_storages()


def compare_fallback(lexical_report, vector_report):
    rows = []
    for lexical, semantic in zip(lexical_report["rows"], vector_report["rows"], strict=True):
        assert (lexical["scenario"], lexical["query"], lexical["expected"]) == (
            semantic["scenario"], semantic["query"], semantic["expected"],
        ), "reports use different queries"
        if lexical["candidates"]:
            rows.append({"candidates": lexical["candidates"], "retrieved": lexical["retrieved"]})
        else:
            rows.append({
                "candidates": int(semantic["first"] is not None),
                "retrieved": int(semantic["firstRelevant"]),
            })
    return {
        "policy": "lexical-first, evaluate one vector suggestion after an empty result",
        "expected": vector_report["expected"],
        "retrieved": sum(row["retrieved"] for row in rows),
        "candidates": sum(row["candidates"] for row in rows),
        "emptyTruthWithSuggestions": sum(
            lexical["expected"] == 0 and bool(row["candidates"])
            for lexical, row in zip(lexical_report["rows"], rows, strict=True)
        ),
    }


def fallback_scores(lexical_report, vector_report):
    assert lexical_report["fixtureHash"] == vector_report["fixtureHash"], "fixture bytes differ"
    for lexical, semantic in zip(lexical_report["rows"], vector_report["rows"], strict=True):
        assert lexical["query"] == semantic["query"], "query order differs"
        if not lexical["candidates"]:
            yield semantic


def test_abstention(lexical, vector, calibration):
    assert vector["fixtureHash"] != calibration["fixtureHash"], "held-out fixture must be distinct"
    assert vector["modelRevision"] == calibration["modelRevision"], "model revision differs"
    calibration_rows = calibration["fallbackRows"]
    holdout = list(fallback_scores(lexical, vector))
    metrics = {}
    for score_name in ("cosine", "margin"):
        wrong_scores = [
            row[score_name] for row in calibration_rows
            if not row["firstRelevant"] and row[score_name] is not None
        ]
        assert wrong_scores, f"no calibration negatives for {score_name}"
        threshold = max(wrong_scores)
        accepted = [row for row in holdout if row[score_name] is not None and row[score_name] > threshold]
        metrics[score_name] = {
            "strictlyAbove": threshold,
            "heldOutFallbackQueries": len(holdout),
            "correctSuggestions": sum(row["firstRelevant"] for row in accepted),
            "incorrectSuggestions": sum(not row["firstRelevant"] for row in accepted),
            "unsupportedSuggestions": sum(row["expected"] == 0 for row in accepted),
            "abstentions": len(holdout) - len(accepted),
        }
    return metrics


async def main(model_dir, baseline, fixture, calibration_path, nli_dir, claims_path):
    def reject_connection(*_args, **_kwargs):
        raise AssertionError("Network connection attempted during offline evaluation")

    assert version("lightrag-hku") == "1.5.7"
    with TemporaryDirectory(prefix="bookiewookie-e5-") as root:
        with patch.object(socket.socket, "connect", reject_connection), patch.object(socket.socket, "connect_ex", reject_connection):
            verifier = LocalEvidenceCheck(nli_dir) if nli_dir else None
            claims = json.loads(claims_path.read_text(encoding="utf-8")) if claims_path else None
            stats = await evaluate(LocalE5(model_dir), root, fixture, verifier, claims)
    if baseline:
        lexical = json.loads(baseline.read_text(encoding="utf-8-sig"))
        stats["fallback"] = compare_fallback(lexical, stats)
        stats["fallbackRows"] = list(fallback_scores(lexical, stats))
        if calibration_path:
            calibration = json.loads(calibration_path.read_text(encoding="utf-8-sig"))
            stats["heldOutThresholds"] = test_abstention(lexical, stats, calibration)
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("model_dir", type=Path)
    cli.add_argument("--baseline", type=Path, help="Saved JSON output from the PostgreSQL benchmark")
    cli.add_argument("--fixture", type=Path, default=FIXTURE)
    cli.add_argument("--calibration", type=Path, help="Vector report for a different corpus")
    cli.add_argument("--nli-model", type=Path, help="Pinned local evidence checker directory")
    cli.add_argument("--claims", type=Path, help="Curated claims for the selected synthetic fixture")
    args = cli.parse_args()
    if bool(args.nli_model) != bool(args.claims):
        cli.error("--nli-model and --claims must be supplied together")
    if args.calibration and not args.baseline:
        cli.error("--calibration requires a lexical --baseline")
    asyncio.run(main(args.model_dir, args.baseline, args.fixture, args.calibration, args.nli_model, args.claims))
