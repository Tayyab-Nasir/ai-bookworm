# Book Retrieval Decision

Status: accepted for the current product build (2026-09-06)

2026-09-24 local extension: the canonical-version index also extracts visible
table cells, captions and image alt text. Superseded versions are removed by
the same chapter trigger; the SQL suite checks source-node citations, exact
excerpt hashes, tenant isolation and stale-version removal. This work did not
apply the migration to Supabase; the live migration listing timed out during
this review, so its hosted installation status is unverified.

## Decision

Use tenant-scoped PostgreSQL full-text search for the first production retrieval
path. The canonical source remains the current immutable document version and
Book Bible record. Database triggers refresh bounded chunks, and row-level
security plus explicit book authorization protect every read.

The product exposes the result honestly as source search, not semantic or graph
reasoning. Every result carries its source type, chapter or Bible item, document
version, node, chunk index, and text hash. AI writer and consistency jobs can use
the same cited excerpts as untrusted context, within their prompt budget.

## Why this is the current fit

- It adds no second tenant store, embedding provider, or deletion pipeline.
- Version changes remove stale manuscript chunks transactionally.
- Exact names, places, terminology, and quoted phrases are the most important
  near-term consistency lookups and work without model spend.
- Existing PostgreSQL backup, access-control, and audit boundaries apply.

This is deliberately not described as semantic retrieval. Stemming and
multilingual recall are limited by the current `simple` text-search
configuration, and cross-chapter inference remains an AI task over retrieved
evidence.

## LightRAG evaluation gate

LightRAG is a phase-two candidate behind the retrieval interface, not a current
runtime dependency. Evaluate it with a private, PostgreSQL-backed deployment and
per-book/workspace isolation only when the Bookworm evaluation set includes
enough long manuscripts to measure:

1. factual and relationship recall against the PostgreSQL baseline;
2. citation accuracy and stale-version/deletion behavior;
3. multilingual recall;
4. ingestion and query latency at realistic book sizes;
5. embedding, graph extraction, storage, and operational cost;
6. resistance to prompt injection contained in manuscript text.

Adopt it only if the measured recall improvement is material enough to justify
the additional LLM extraction cost and operational surface. The user-visible
citation contract, current-version checks, RLS authorization, deletion rules,
and bounded prompt assembly remain mandatory regardless of backend.

Qdrant configuration already present in the repository is likewise optional and
does not represent the active author-facing search path.

The 2026-10-23 private-adapter checkpoint repairs Qdrant client compatibility,
version/tenant point identity, embedding response validation and index-only
recovery. See `SEMANTIC_RETRIEVAL_CHECKPOINT.md` for tests and remaining gates.
It adds no author endpoint, funded embedding jobs or semantic-quality claim;
PostgreSQL FTS remains the production implementation of this decision.

As of the September 2026 upstream review, LightRAG recommends its REST server
for integrations and PostgreSQL for production storage; its default local-file
stores are not production storage. These are deployment characteristics, not
proof that its workspace model satisfies Bookworm's book-level authorization
or deletion rules. Keep it out of the author request path until a private
adapter proves those invariants and improves the measured citation/recall
baseline. [Official LightRAG repository](https://github.com/HKUDS/LightRAG).

## Offline LightRAG smoke

The optional synthetic check pins LightRAG 1.5.7. Install it in a dedicated
Python environment with `pip install lightrag-hku==1.5.7`, then run
`python tests/ai-evals/evals/book-retrieval-lightrag-smoke.py`.
It exercises two file-backed workspaces using the same document ID, confirms
returned excerpts and citation IDs, and verifies chunk and graph removal,
replacement, and reopen. The smoke uses deterministic extraction and embeddings
and denies socket connections during execution.

For citations, LightRAG normalizes the supplied source path to its basename.
Use an opaque source token resolved to BookieWookie's authorized document
version if building an adapter. Never treat the returned path or extracted
relationship as authorization. The smoke provides local lifecycle evidence.
A representative semantic recall comparison, PostgreSQL storage behavior and
live application authorization still require independent verification.

The smoke also indexes identical passages under two chapter IDs and two opaque
filenames in a single LightRAG workspace. Version 1.5.7 returned only the first
source. Deleting it removed the result even though the second chapter still
exists in the fixture's book. BookieWookie therefore needs an authoritative
mapping from each indexed passage to every authorized current chapter version.
An adapter must preserve the remaining citation after one occurrence is removed
and withhold the passage when the final occurrence is gone. The file-backed
probe uses synthetic inputs and establishes a requirement for adapter design.

The follow-up probe indexes one opaque passage token per book and resolves the
result against the current chapter-version snapshot. In both deletion orders,
the other occurrence remains citable. Resolution also rejects a foreign book,
changed excerpt bytes, an old result after a chapter edit, and a delayed
index write after the final occurrence was removed. The index still requires
cleanup after the last occurrence. The probe uses file-backed storage and an
in-memory authority fixture. Transactional source binding, PostgreSQL-backed
storage and authorization in the app still require independent proof.

The PostgreSQL baseline now exercises the citation lookup with BookieWookie's
actual migration chain in disposable PostgreSQL/WASM. The lookup runs under
the authenticated role and matches both the opaque filename and the exact
excerpt to a canonical current version. It returns distinct citations for
repeated text, retains the other citation after an ordinary authoring edit,
and rejects a stale derived row even when it still exists. A viewer sees both
sources while their membership is active and neither after revocation.
This tests database filtering without a hosted database or app route. Worker
concurrency and index cleanup still need verification.

Set `BOOKWORM_RETRIEVAL_MEASURE=1` on either lexical benchmark command to
compare the original citation lookup with a staged match and a disposable
`(book_id, text_hash)` index. The existing MD5 hash narrows candidates.
The exact excerpt, SHA-256 token, workspace policy and current revision
remain required for a citation. The runner checks identical ordered rows
and records nine warmed EXPLAIN ANALYZE execution times per query.

In a local PostgreSQL/WASM run, the 1,830- and 3,806-chunk books each had
100 chapters. The original median execution times were 79 ms and 155 ms.
Indexed medians were 1.21 ms and 0.86 ms, respectively. PostgreSQL used the
composite index for each hint, then read the matching rows by primary key.
These timings exclude network, retrieval and embedding time. The compound
index is created and dropped within the disposable benchmark. Native
PostgreSQL latency, index write cost and concurrency remain unmeasured.

## Offline index cleanup ordering

The single-writer smoke now pauses an actual LightRAG insertion while an
authoritative fixture removes the final source. Reconciliation reads desired
state under a book-scoped lock and rechecks the generation after each writer
operation. It removed the late chunk and graph relation. It also recovered
from a lost deletion reply, then verified absence after reopening storage.
When one of two duplicate sources remains, the shared entry stays indexed.

This proof covers one process and file-backed storage. Production still needs
durable writer ownership and restart reconciliation. All index writes must
pass through the same owner, including cleanup after uncertain completions.
The current-version lookup remains the publication boundary for citations
while physical index reconciliation is pending.

## Local multilingual retrieval comparison

Both evaluators read the same synthetic manuscript facts and queries from
`tests/ai-evals/fixtures/book-retrieval.json`. For the vector comparison, use
LightRAG 1.5.7, ONNX Runtime 1.32.0, and Tokenizers 0.23.3 in a separate Python
environment. Download the pinned quantized model and tokenizer from the
[model repository](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3/onnx).
The runner verifies both file digests before inference.

Run the PostgreSQL baseline with
`node tests/ai-evals/evals/book-retrieval-baseline.mjs` and save stdout as JSON.
Run `python tests/ai-evals/evals/book-retrieval-semantic.py MODEL_DIR --baseline BASELINE_JSON`
with the separate experiment interpreter. The vector index keeps one copy per
source of the repeated background paragraphs. It uses CPU embeddings and
skips graph extraction to isolate the vector search comparison.

The 13 synthetic queries contained 11 expected sources, including three
queries with zero expected sources. PostgreSQL found 7 of 11 in seven returned
candidates. LightRAG vector search found 8 of 11 in 104 candidates, recovering
a translated query and an accentless query while missing an exact phrase.
An evaluated fallback retained the lexical result when present, then tried one
vector candidate when it was empty. It found 9 of 11 in 14 candidates and
suggested irrelevant sources for all three queries with no expected source.
The fallback is experimental. Additional evaluation must measure whether it
can abstain reliably on unrelated questions.

The held-out fixture in `tests/ai-evals/fixtures/book-retrieval-held-out.json`
uses different passages and 16 queries, including eight without a supported
answer. Several negative queries closely resemble real manuscript facts while
changing a person, object, place, or action. The second argument to the
PostgreSQL runner selects this fixture. For LightRAG, pass its path in
`--fixture`, the matching PostgreSQL report in `--baseline`, and the first
fixture's vector report in `--calibration`. The runner rejects identical
calibration and held-out fixture digests.

For each confidence measure, the experiment places the cutoff immediately above
the highest incorrect calibration suggestion. On the held-out keyword misses,
cosine accepted five correct suggestions and eight incorrect ones. The
first-to-second score margin accepted four correct and seven incorrect
suggestions. Seven and six of those incorrect suggestions, respectively, were
for queries with no answer. Similarity and ranking separation alone could not
identify whether the manuscript supported the queried detail.

## Local passage-to-claim verification

The held-out fixture also has manually written claims. Each claim is checked
against the eight retrieved source excerpts. The input claims are curated;
this evaluation does not generate questions, produce an answer, or rewrite a
reader's prompt. A separate 12-pair fixture calibrates the acceptance cutoff
above the highest entailment score for an unsupported calibration claim.

Pass `--claims tests/ai-evals/fixtures/book-retrieval-held-out-claims.json`
and `--nli-model MODEL_DIRECTORY` to the semantic runner with the held-out
fixture. Supported artifact manifests are pinned in
`tests/ai-evals/evals/book_retrieval_nli.py`. The models were
[multilingual MiniLMv2](https://huggingface.co/onnx-community/multilingual-MiniLMv2-L6-mnli-xnli-ONNX/tree/ca5daf3d11b6c4b3143b1f4602a2edfb64c3ad7e)
and
[multilingual mDeBERTa](https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7/tree/b5113eb38ab63efdd7f280f8c144ea8b13f978ce).
Each model directory contains its quantized ONNX file, config and tokenizer.
The evaluator verifies all three digests before running locally.

MiniLMv2 selected a correct excerpt for one of eight supported claims and
accepted no unsupported claims. mDeBERTa selected four correct excerpts and
accepted two of eight unsupported claims. Similar actors and objects still
produced false support, including an incorrect occupation and a missing
destination. These results do not justify automatic factual acceptance.
