# Canonical search source reader — 2026-10-23

Authors can now open the saved source behind a manuscript search result without
starting AI or changing the manuscript. PostgreSQL full-text search remains the
active retrieval strategy. This is not semantic search or a LightRAG release.

## Implemented behavior

- Explicit **Read cited source** beside manuscript excerpts, separate from
  **Open current chapter** and the existing Book Bible entry action.
- Exact book/chapter/document-version/node/chunk identity, reloaded from
  canonical versions after current membership checks. An old citation reads
  the old version with a visible warning; it never substitutes current text.
- MD5 checks the existing 1,800-character FTS chunk. It is not an authorization
  token. The projection includes text, caption, accessibility text and table
  cells in the same order as PostgreSQL, including empty cell separators.
- 6,000-code-point pages and cited-chunk highlighting. Browser parsing checks
  echoed scope, version, ranges, navigation and shape. Late responses after a
  phrase/book change are ignored; duplicate source clicks are guarded.
- Private/no-store response headers, bounded scrollable passages, keyboard
  access, responsive cards, retryable read errors and escaped text rendering.
- Typed client and OpenAPI contract added. No schema migration, provider call,
  credit reservation or customer purchase is required for source reading.

## Local evidence

- 11 new API checks, 45 with existing Book Memory tests: pass.
- 28 new web parser/client checks: pass.
- 8 mounted React tests in Edge/Chromium: pass, including 320px containment,
  historical reads, Unicode pagination, keyboard scroll, stale responses,
  mismatch/error recovery, duplicate clicks and HTML-as-text behavior.
- Desktop and mobile screenshots inspected at
  `C:/Users/Asus/AppData/Local/Temp/bookworm-search-reader-RzsLCG/`.
- API/web type checks: pass. OpenAPI suite: 19 pass.
- Disposable PostgreSQL: 111 migrations and 75 SQL assertion files pass,
  including the new SQL searchable-projection/Unicode oracle.

The mounted test uses the actual components with a synthetic transport, not a
live author account. Full clean-source and native CI results must be recorded
after they finish; these focused results alone do not establish product completion.

## Continuation boundaries

The latest operator-only provider tests are in `PROVIDER_ACCEPTANCE_2026-10-23.md`.
No fresh hosted source-reader, Google-session, paid generation, retailer or full
disaster-recovery acceptance is claimed. Mobile stays parked, Stripe deferred,
and all funded-AI gates stay intact. See `WEB_APP_ACCEPTANCE_2026-10-23.md`.
