# Semantic retrieval adapter — 2026-10-23

## Status and scope

PostgreSQL full-text search is still the active author-facing retrieval path.
This checkpoint repairs the dormant Python embedding/Qdrant adapter; it does
not enable semantic search, install LightRAG, or prove semantic recall quality.
No live database changes, provider calls, billing, deployments or model downloads
were performed for this checkpoint. The prior 111-migration checkpoint stands.

The original PRD includes semantic Book Bible retrieval. The dormant adapter
was not sufficient: it called `QdrantClient.search`, absent from the installed
1.19.0 client; point IDs omitted workspace, chapter, version and chunk ordinal;
and reindexing removed the prior index before an embedding call could fail.
There are currently no non-test callers of this adapter. The live FTS route
and its canonical-source authorization remain unchanged.

## Implemented boundary

- The Qdrant dependency is pinned to the exercised client version, 1.19.0.
  Reads use `query_points` with workspace, book, model and explicit current
  document-version filters. Returned scope, identity, source hash, count and
  finite cosine score are checked again; unexpected payload fields are stripped.
- Version-two IDs include workspace, book, document version, chapter, node,
  chunk ordinal, text digest and embedding model. Identical repeated text and
  delayed old-version writes cannot overwrite another point's identity.
- Embedding preparation and index writes are separate operations. A prepared
  batch includes vectors and a model/input-bound usage receipt. An index-only
  retry cannot call an embedder. The old version is retired only after a
  synchronous, confirmed completed upsert; ambiguous or unconfirmed writes do
  not delete it. Cleanup is scoped to one explicitly supplied old version.
- Paid embedding configuration has no implicit model, dimensions, provider or
  key-triggered fallback. `EMBEDDING_API_ENABLED=false` is the documented default.
  `get_embedder("mock")` is test-only. The convenience combined index function
  refuses paid embedders; real callers must persist preparation before writing.
- OpenAI dispatch disables SDK retries and checks response model, indices,
  dimensions, finite/nonzero vectors and token usage. Results are restored to
  input order. A possibly dispatched failure produces a redacted uncertain
  outcome, never automatic redispatch or refund. Merely setting the enable flag
  is NOT a funding/entitlement mechanism.
- Input bounds are checked before dispatch: at most 128 chunks, 8,000 UTF-8 bytes
  per input and 200,000 bytes per batch. Large books must be partitioned before
  funding; they are rejected, not silently truncated. Byte bounds are not a
  customer token quote. Invalid chunk sizes cannot create an infinite loop.
- An incompatible existing collection is rejected, never automatically replaced.
  These are new version-two IDs/payloads, not an in-place legacy index migration.

The embedding request/usage contract was checked against the
[official OpenAI embeddings API](https://developers.openai.com/api/reference/python/resources/embeddings/methods/create).
The query interface matches the
[official Qdrant query documentation](https://qdrant.tech/documentation/search/hybrid-queries/).
No approved model/rate catalog is implied by a fixture model name.

## Verification

- 136 focused cases pass across `test_rag.py`, `test_semantic_index_local.py`
  and `test_embedding_boundaries.py`.
- The actual local, in-memory Qdrant client exercises version/tenant filters,
  point identity, repeated chunks, collection compatibility, cleanup and retry
  after a committed write with a lost response. No Qdrant server was deployed.
- Real OpenAI SDK requests are intercepted by a local HTTP mock transport.
  Serialization, response reordering and single-dispatch behavior on 429/500
  are tested. No request reaches OpenAI and no real key is used.
- Failure-first tests reproduced seven missing dimension/write-confirmation
  checks before the fixes. Malformed/foreign/stale evidence and raw upstream
  errors are rejected without exposing manuscript text or credentials.
- Exact-source GitHub workflow
  [39986187160](https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/39986187160)
  passed all 136 focused cases on commit
  `1490402d96d03a7288c08d7b6558ac5acfd7fd31`. It installed OpenAI SDK 3.37.0;
  local checks also passed with 3.6.0. Qdrant client was 1.19.0 in both.
- Full `npm run verify` passed at **16:27:28 UTC** on a clean exported copy of
  that Git source: 931 API, 412 web, 840 service, 18 E2E, 50 security cases plus
  two subtests; 111 migrations/74 SQL assertion files; populated 45-to-111
  upgrade/crypto, synthetic handler load and deterministic evaluation gates.
  Source hashes remained unchanged. Live provider evaluation was skipped
  without a key; unrelated shared uncommitted billing tests were excluded.
- Read-only hosted recheck still reports 111 migrations. The previous private
  application-backup manifest is unchanged and its through-111 restore receipt
  remains valid; full Supabase/Auth/Storage/settings recovery is still unproven.

Hash-vector fixtures demonstrate structural correctness only. They are not
evidence of language understanding, multilingual recall, factual accuracy,
production Qdrant durability or distributed race behavior.

## Required before author-facing enablement

1. An approved embedding model/dimension and price catalog; funded ingestion and
   query quotes integrated with the existing durable dispatch/credit ledger.
2. Durable prepared-vector/usage storage and explicit recovery for an unknown
   provider outcome. The dataclasses in this adapter are not that storage.
3. A trusted loader of current authorized PostgreSQL versions, followed by
   canonical text rehydration before citations or AI context are returned.
   Index filters/hashes alone do not establish access or source authenticity.
4. Bounded, restartable full-book partitioning; canonical rich-node and Book
   Bible coverage; per-source freshness and deletion/retention propagation.
   The current adapter accepts simple chapter/node text snapshots only.
5. Private Qdrant supervision, TLS/access control, backups and native server
   recovery/isolation acceptance; an explicit legacy reindex/cleanup plan.
6. A funded semantic/citation/multilingual evaluation against working FTS,
   including stale content, tenant isolation and manuscript prompt injection.

LightRAG remains evaluation-gated under `BOOK_RETRIEVAL_DECISION.md`. The
[upstream repository](https://github.com/HKUDS/LightRAG), reviewed again on
2026-10-23, recommends its REST server and production PostgreSQL storage.
Those deployment recommendations do not establish Bookworm authorization,
deletion correctness or a measured improvement, and graph extraction adds
separate model cost. Do not label this adapter repair a LightRAG integration.

Mobile stays parked, Stripe stays deferred, and existing paid-AI/credit and
retailer gates remain intact. Full web-product acceptance is still open.
