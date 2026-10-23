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
  `C:/Users/Asus/AppData/Local/Temp/bookworm-search-reader-OfeePW/`.
- API/web type checks: pass. OpenAPI suite: 19 pass.
- Disposable PostgreSQL: 111 migrations and 75 SQL assertion files pass,
  including the new SQL searchable-projection/Unicode oracle.

Full clean-source `npm run verify` passed on application commit
`f8e59fe1be3f4bfd0444160107c74d8e05c048fc` at 17:12:28 UTC: 942 API, 441 web,
840 service, 18 E2E, 51 security (+2 subtests), 111 migrations/75 SQL assertion
files, populated 45-to-111 upgrade, crypto, synthetic load and deterministic
evaluation checks. Native Python and EPUBCheck were explicitly configured;
provider keys were not passed. Frozen source integrity was verified.
The isolated production Next build passed at 17:17:59 UTC on the same source.
Local receipts are `.git/bookworm-tracking/source-reader-verify-20261023.json`
and `source-reader-build-20261023.json`.

[Native database CI](https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/39992577938)
passed on that exact commit. The first native author run failed an immediate
post-PageDown scroll assertion; subsequent build/native package steps did not run.
Test/doc-only follow-up `eca8d2af06a52ea2b747a2444bf1877011b8d212` preserves
application source and verifies focus/overflow before waiting for actual native
keyboard scrolling. Its eight local mounted tests pass.
[Native author rerun](https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/39993697760)
passed on `eca8d2a` at 17:24:11 UTC, including all eight source-reader tests in
full Chromium, production author build, private scanner/document/rendering/
publishing container builds, native authoring, saved proofs and private retailer
packages. Git confirms only the browser test and provider-test documentation
differ from the full-suite application source `f8e59fe`.

The mounted test uses the actual components with a synthetic transport, not a
live author account. Full local verification is not hosted product acceptance.

## Continuation boundaries

The latest operator-only provider tests are in `PROVIDER_ACCEPTANCE_2026-10-23.md`.
No fresh hosted source-reader, Google-session, paid generation, retailer or full
disaster-recovery acceptance is claimed. Mobile stays parked, Stripe deferred,
and all funded-AI gates stay intact. See `WEB_APP_ACCEPTANCE_2026-10-23.md`.
The existing loopback web/API were not restarted and remain on older frozen
`a22a4aa`; do not claim this reader is available there until the runtime is refreshed.
