# Book Retrieval Decision

Status: accepted for the current product build (2026-09-06)

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
