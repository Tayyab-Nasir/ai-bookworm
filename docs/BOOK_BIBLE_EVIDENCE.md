# Book Bible manuscript evidence

Book Bible entries are author-approved records, not automatically verified
facts. Their optional `sourceRefs` can point to a chapter or to a node in a
saved chapter version. The API checks every cited chapter belongs to the book
and every supplied version belongs to that chapter.

For node-level citations, the API now reads the saved document version and
requires the node to exist in it. If no version ID was supplied, it resolves
and stores the chapter's current saved version at the time of approval. It
stores the SHA-256 hash of the complete canonical node text when present; a
supplied hash must match exactly. An invented node, stale hash, unsupported
saved chapter format, or missing current version prevents the entry from
being saved. Editing an entry with a pinned historical source continues to
check that historical version, even if the current chapter has changed.

Chapter-only references remain valid for human notes but do not prove a
specific passage. A verified source citation proves a saved node and text
existed at that version; it does not prove the entry's interpretation of the
passage. The author must still review AI-proposed facts and images. No
manuscript text is copied into the Book Bible source reference.

These checks are locally verified only. Hosted Auth/PostgREST/Storage
acceptance and the broader publishing release gates remain separate.

The additive `20260924180000_book_bible_evidence.sql` migration extends the
same boundary to direct authenticated table writes through PostgREST. A
trigger rejects fabricated chapters, mismatched versions, missing nodes and
incorrect hashes; textual node citations must carry a pinned version and
the full canonical text hash. Its disposable database test covers direct
insert/update bypass attempts. The migration is **source-only**, not applied
to the hosted Supabase project. Existing Book Bible rows are not rewritten or
retroactively certified; audit them before any claim of universal provenance.

## AI extraction boundary (source checkpoint)

The `book_bible` agent's v2 prompt and structured output now require each
candidate to cite a selected manuscript node with exact chapter ID, saved
document-version ID, node ID, and full-node text hash. Unknown, stale, or
unversioned references fail the whole response. Candidates are bounded to ten
per call, and their fields match the canonical Book Bible's storage limits.
An empty candidate list is valid when the manuscript supports no entity.
Related search and existing Book Bible context cannot be cited as new
manuscript evidence. The agent returns suggestions only; it cannot write to
`book_bible_items`.

The author-facing source workflow now includes a paid API request, saved
candidate history, read-only result recovery, and a review shelf in the Book
Bible screen. The request reserves one operational `ai_credits` unit before
dispatch, builds full-node citations from saved manuscript versions, and
blocks another extraction while its original result is unresolved. The AI
service uses a source-only private Book Bible result receipt, and a separate
source-only completion function atomically stores bounded candidates, the AI
run, and one operational AI-credit event without writing canon. The function
rechecks each citation against both the job's trusted input and the full
saved document node. The author can copy a candidate into an unsaved form,
edit it, and explicitly Save through the citation-checking Book Bible API.
One active request per author/book is enforced in the disposable database.
These migrations are **not installed hosted**; this source workflow is not
live production acceptance or an approved retail token-pricing catalog.
The citation validates source identity, not semantic truth; author review
remains required before any generated detail becomes canon.

Candidate cards provide an on-demand source passage reader. It checks book
membership, chapter/version ownership, node identity and the full saved-text
hash before returning private, no-store text. Historical versions remain
readable and are identified when the chapter has moved on. Responses cap
display text at 24,000 UTF-16 units per section, without splitting Unicode
code points. Next/previous controls reach the full saved node. Every section
rechecks book/version ownership and the full-node hash; invalid offsets fail
closed. The viewer validates returned positions, retains the current text on
navigation failure, and resets section scroll after successful navigation.
Reading does not generate content, spend credits or save canonical entries.

Authors can select up to three saved chapters from anywhere in the book.
Free reading-plan preparation now divides all nonempty text nodes into
bounded, gap-free batches, including excerpts of a single long node without
splitting Unicode code points. Citation hashes continue to identify full saved
nodes; explicit offsets record which excerpt each batch read. JSON escaping
and provenance overhead count against the conservative input budget. Plans
are capped at 8 MB of selected text. Rich content without text is excluded,
and at most ten candidates per batch is not exhaustive entity discovery.

The UI prepares/resumes a plan, selects the first unfinished batch and shows
completed batches. Each new batch requires an explicit one-operational-credit
generation; no automatic chain spends credits. A fingerprint binds versions,
node hashes, ranges and budget. Stale plans are rejected before reservation.
Completed results reopen without credits, even if the current allowance is
exhausted. A source-only unique index prevents concurrent active/completed
purchases of the same author/book/plan/page. Existing request-key recovery
still handles uncertain responses. Legacy generation without a plan accepts
only one-batch selections and otherwise directs the author to prepare a plan.

Checkpoint: 32 focused API/planner tests, API/web types, 103 web tests, 80
disposable migrations/57 SQL suites, OpenAPI parsing and native Edge fixture
journey pass. The browser verifies plan preparation and resumed progress;
API tests verify actual gap-free planning, stale versions and no regeneration.
The unique index is not installed hosted. Source passage section navigation
now reaches beyond the initial display cap; direct jumps/highlighting from a
batch's stored excerpt ranges are a further review-UX improvement. No live
provider call. Pagination follow-up passes 31 Book Memory API tests, API/web
types, 103 web tests and the expanded native Edge fixture journey (failed
next-section fetch, retained current text, retry, next/previous and final-page
disable). Hosted services and multi-connection races remain separate gates.

## Reviewed no-result hold release — source checkpoint

The admin console and `POST /v1/admin/jobs/ai/{id}/release-bible-hold` now
call a service-only atomic release function. A platform admin supplies an
incident reference and explicit private-receipt/provider-review attestations.
Only a running Book Bible request at least 15 minutes old is eligible; a
recent receipt reservation, active lease, any saved receipt result (including
malformed output), canonical job output, suggestion, AI run or usage event
blocks release. An absent receipt is allowed after operator review. Age is
only a guard, not proof that the provider failed or cost nothing.

Release records the incident and actor in the audit log, ends the job as
`book_bible_hold_released`, makes no canonical writes and adds no customer
debit. The existing completion function rejects late completion of that
failed job. A late private receipt may still be retained for investigation.
The original idempotency key remains terminal; any author-requested future
generation is a separate paid request. Saved valid results use author
recovery; malformed saved results still require a separate reviewed
disposition workflow and cannot be discarded with this action.

Migration `20260924232000_book_bible_manual_hold_release.sql` is tested only
in disposable PostgreSQL, not installed hosted. All 79 migrations and 57 SQL
suites pass; 21 focused admin API tests, API/web TypeScript, the 102-test web
suite and the added client transport test pass. Native admin-form acceptance
and multi-connection races remain unverified.

## Native browser checkpoint — 2026-09-24

`node tests/e2e/book-bible-browser.mjs` passes in headless Microsoft Edge
against an isolated Next dev app on port 4398 and
`node tests/e2e/auth-browser-fixture.mjs` on port 4399. It exercises real
login cookies, rendered controls, and BFF canonical saving; AI job history,
generation/recovery and evidence responses are browser fixtures, and storage
is fixture memory. This is not hosted Auth, provider, database, or credit-ledger
acceptance.

Verified: maximum-three chapter selection, selecting a later chapter, empty
selection blocking, pending request blocking, recovery with exactly one
generation attempt, source-read failure/retry, historical-version warning,
cached passage reopening, zero canonical writes before explicit Save, one
save through the BFF, persistence across reload, no page errors, and 390px
containment including the expanded candidate/source card.

For the isolated Next process, set `SUPABASE_URL` and `API_URL` to
`http://127.0.0.1:4399`, both `SUPABASE_PUBLISHABLE_KEY` and
`SUPABASE_ANON_KEY` to `fixture-key`, `APP_URL` to `http://127.0.0.1:4398`,
and `BOOKWORM_DIST_DIR` to `.next-codex-bible-browser`. Run
`node node_modules/next/dist/bin/next dev apps/web --hostname 127.0.0.1 --port 4398`.
Use a fresh fixture process for each test run; stop only these owned test
processes afterward. Do not point this harness at production.
