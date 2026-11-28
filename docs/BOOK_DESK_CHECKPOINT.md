# Book desk: saved progress and connected author workflow

The PRD's per-book dashboard now exists at `/books/{bookId}/overview`. Library
cards and the shared book header link to it. Existing editor, plan, Book Bible,
artwork, translation and Publishing Studio routes retain their behavior.
This is the web product; mobile remains parked and Stripe remains deferred.

## Operational truth

The read-only `GET /v1/books/{bookId}/overview` authenticates the caller, verifies
active workspace membership, and uses only that caller's RLS client. It never
uses a service-role client, starts a job, generates content, grants credits or
creates a Storage URL. No migration, queue, dependency or provider is added.

The projection contains saved book/workspace identity, an ordered chapter
ledger, current saved word counts, Book Bible count, listing-field presence,
latest edition settings, historical output counts, and recent safe job summaries.
Current chapter document-version pointers select only version IDs, word counts
and timestamps; revision history is not added to the word total. An unsaved
chapter stays distinguishable from an empty saved version. Unavailable counts,
missing/foreign current versions and invalid rows fail closed, not as zeroes.

The chapter view supports up to 500 rows, matching the existing chapter-order
API bound; larger results are refused rather than silently truncated. The latest
12 editions retain an independently exact total. At most four jobs per pipeline
are shown. Historical successful renders/packages are history, not evidence of
current bytes, current preflight, retailer approval, submission or sales. A saved
cover choice is not represented as scanned, approved or render-ready artwork.
Manuscript text, Bible descriptions, metadata text, private job inputs, raw
errors and provider credentials are never returned by this endpoint.

## Interface and recovery

The editorial book desk retains the black author shell, existing Instrument
Serif display font and local assets. A warm-paper next-action slip, ordered
chapter ledger and four workflow stages connect the book's work without an
invented completion percentage. Suggested actions follow actual saved facts;
Book Bible and artwork are not made mandatory for every kind of book.

The typed client validates exact book/workspace identity, bounded collections,
saved-count arithmetic and safe fields before exposing the response. The desk
also binds it to the signed-in identity, checks the session again before display,
rejects late responses after book changes, discards a failed cached overview,
and rechecks on focus after another-tab account changes. No book data is stored
in browser storage. Errors expose a static retry state, not upstream payloads.
Keyboard focus, read-only access, empty books and long Unicode titles are covered.

## Verification and acceptance boundary

- API route regression checks exercise current pointers versus old revisions,
  tenancy/revocation/authentication, read-only roles, unavailable counts,
  malformed/foreign/missing versions and bounded edition samples.
- Typed-client checks exercise scope, totals, unknown private fields, malformed
  facts and GET-only transport.
- Mounted browser checks exercise the actual component/CSS at desktop and
  320px/390px widths, keyboard focus, retries, identity/book-switch races,
  next-action branches and safe Unicode text. Screenshots are synthetic, not
  customer or deployed acceptance.
- Native author/files acceptance now visits the real production page after
  saved import/edit/Bible/listing work, checks current version counts through
  the real authenticated BFF, then revisits after real saved publishing outputs.
  Inspect that exact-source CI run's terminal result before claiming it passed.

Commands: `npm run typecheck`, `node --import tsx --test
services/api/src/book-overview.test.ts`, `node --import tsx --test
apps/web/tests/book-overview.test.ts`, `node --test
apps/web/tests/book-overview-mounted.mjs`, and the full `npm run verify` on the
reviewed clean export. Full Chromium CI uses `BROWSER_TEST_CHANNEL=chromium`.

This checkpoint is not full product or hosted acceptance. Paid provider quota,
approved model/rate catalogs, funded quality/recovery, private hosted services,
full Supabase/Auth/Storage/settings recovery and actual retailer/print acceptance
remain separate requirements. Do not retry stopped paid work or deploy based
solely on this source checkpoint. Exact-source results and continuation belong
in the current shared Codex handoff, not another agent's private memory.
