# AI Bookworm shared-agent handoff

## Read first

This is the full AI-native publishing application, not only its landing page.
Shared vault: `C:/Users/Asus/Memory-Ai`.

- Current detailed Codex handoff:
  `Codex Sessions/2026-08/2026-08-31-ai-bookworm-codex-handoff.md`.
- Latest supplemental checkpoint:
  `Codex Sessions/2026-09/2026-09-12-bookworm-atomic-community.md`.
- Latest live/Git checkpoint:
  `Codex Sessions/2026-09/2026-09-12-bookworm-live-rollout.md`.
- Claude handoff:
  `Claude Sessions/2026-08/2026-08-31-ai-bookworm-project-final-handoff.md`.
- Shared board: `Hermes Context/active-tasks.md`.
- Repository navigation and deployment boundaries: `docs/PROJECT_MAP.md` and
  `docs/VERCEL_DEPLOYMENT.md`.
- Read vault `AGENTS.md` and `CLAUDE.md` before writing. Do not edit other
  agents' private memory or the generated startup briefing.
- Read git status before edits. Preserve shared uncommitted work. Saved
  completion claims require current code and behavioral verification.

## Current checkpoint: 2026-09-12

### 2026-09-19 durable quote-counting worker

Source 4712d6d adds --prepare-quotes: bounded leased chapter counting, saved
count recovery, no automatic recount after expired lease, atomic ready proposal.
238 API tests, workspace TypeScript, 62 migrations/43 SQL suites pass locally.
No live calls. Proposal GET and quote-review UI remain next. Shared note:
Codex Sessions/2026-09/2026-09-19-bookworm-quote-counting-worker.md.

### 2026-09-19 durable quote preparation queue

Source 92ec9ae adds private immutable request snapshots, one active/book and
three/hour limits, explicit consent API and payer-only recovery/progress client.
236 API tests, workspace TypeScript, 61 migrations/43 SQL suites pass locally.
No debit/generation at request time. Counting worker/proposal GET/UI remain next;
queue is not yet operational end to end. Shared note:
Codex Sessions/2026-09/2026-09-19-bookworm-quote-preparation-queue.md.

### 2026-09-19 durable proposal acceptance

Sources 3d3254f (DB), 8db8005 (API/client): private immutable saved offers,
atomic all-chapter job+hold acceptance, same-proposal replay, payer/access/expiry/
source checks. Local 60 migrations/42 SQL suites and native CI 35420563579 pass;
234 API tests pass. No live changes. Creation service/proposal GET/UI remain next.
Shared: Codex Sessions/2026-09/2026-09-19-bookworm-proposal-acceptance.md.

### 2026-09-19 token-counted translation proposals

Source aa25927 adds internal proposal preparation using exact provider input-token
count and full generation hash. No fallback estimates/retries; expiry rechecked.
233 API tests and API TypeScript pass; no live provider calls. Proposal persistence,
authenticated quote endpoint/atomic acceptance/UI remain next. Shared note:
Codex Sessions/2026-09/2026-09-19-bookworm-token-counted-quotes.md.

### 2026-09-19 server-owned translation catalog

Source 4ff8f0f validates optional approved/versioned/expiring server catalog and
exposes authenticated model choices. Internal quote helper pins rates/bounds and
clips expiry. No real offers activated; 229 API tests and API TypeScript pass.
Trusted token counting, quote persistence/acceptance and UI remain next. Shared:
Codex Sessions/2026-09/2026-09-19-bookworm-translation-catalog.md.

### 2026-09-19 private translation billing summary

Source a6e5829 adds payer-only credit totals endpoint/client/UI: held, charged,
returned and review counts, without exposing private quotes or receipts. Missing
or inconsistent accounting is unavailable, not zero. 225 API/69 web tests and
workspace TypeScript pass. No live changes or browser acceptance. Catalog and
quoted public enqueue remain next. Latest shared note:
Codex Sessions/2026-09/2026-09-19-bookworm-billing-summary.md.

### 2026-09-19 quoted translation cancellation

Source 1fb778a adds creator-only pre-dispatch cancellation, one-time held-credit
release and UI confirmation. Local 222 API/68 web tests, TypeScript and 59
migrations/41 SQL suites pass. Native CI 35419700447 succeeded (16 race cases).
No live changes. Quoted public enqueue/catalog and browser acceptance remain open.
Latest shared note: Codex Sessions/2026-09/2026-09-19-bookworm-quoted-cancellation.md.

### 2026-09-19 quoted translation worker integration

Source 8ea4597 adds opt-in --quoted worker: exact request hash/model/output limit,
funded dispatch, durable measured receipt, atomic settlement+completion, no second
operational charge. Missing/uncertain usage cannot redispatch; overrun retains hold.
221 API tests, TypeScript, 58 migrations/41 SQL suites and native CI 35419141932
(16 races) pass. No live calls. Approved catalog, quoted enqueue/UI and review/
cancellation still next. Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-quoted-worker.md.

### 2026-09-19 quoted translation queue isolation

Migration 20260919120000 adds immutable billing_mode, translator-only quoted
enqueue, funded-hold running guard and separate quoted claim RPC. Legacy claims
skip quoted jobs. 57 migrations/41 SQL suites and native CI 35418711607 (16 races)
pass, source 6ed37a5 pushed. Quoted worker/provider/receipt integration remains next.
No live changes. Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-quoted-queue.md.

### 2026-09-19 one-time funded dispatch

Migration 20260919110000 and claimPricedDispatch authorize one provider call
against a held quote and live lease; replay denies redispatch. Quote/dispatch
identity is immutable and pre-dispatch settlement is blocked. 216 API tests,
TypeScript, 56 migrations/40 SQL suites and native CI 35418456271 (16 races) pass.
Source 750e3f7 pushed. Worker and quote-required enqueue integration remain next.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-funded-dispatch.md.

### 2026-09-19 funded pricing adapter

funded-usage.ts connects validated saved quotes to reservation and calculated
settlement. 215 API tests and TypeScript pass, source 3af3fad pushed. Worker
dispatch gating and authenticated provider receipt normalization are still next;
a reserve replay is NOT permission to dispatch. No live changes.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-funded-adapter.md.

### 2026-09-19 persistent funded quotes (local only)

Migration 20260919100000 persists service-owned quotes with atomic ledger holds,
one-time settlement/release and review retention. Legacy and quoted debits cannot
both charge a job. Source 81ea1ec; 55 migrations/40 SQL suites and native CI
35418020168 (15 races) pass. Service calculator/receipt adapter and generation UI
integration remain next; SQL does not authenticate provider receipts or price math.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-funded-quotes.md.

### 2026-09-19 versioned usage pricing math

usage-pricing.ts adds exact version-pinned quote/settlement math; 210 API tests
and API TypeScript pass. Synthetic test rates only. Not wired to generation,
funded reservations or charges. Persist server-owned quotes next; checksums and
approval flags are not authentication. No live changes.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-usage-pricing.md.

### 2026-09-19 atomic service credit deduction (local only)

Migration 20260919090000 makes legacy credits/deduct usage+ledger+receipt atomic.
Same request replays; changed request or historical debit without receipt conflicts.
54 migrations/39 SQL suites, 205 API tests, API TypeScript and native CI
35417527844 (14 concurrency cases) pass. Source e603477, type fix 26dfeb4 pushed.
No live migration. Versioned retail pricing and provider provenance remain open.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-atomic-deduction.md.

### 2026-09-19 accepted media request immutability (local only)

Migration 20260919080000 prevents narrator/translator input and billing-identity
mutation across statuses. Regression reproduced before fixing. Native CI run
35417274720 passed for source 755c5f7: 53 migrations, 38 SQL suites and 12 races.
Normal lifecycle updates remain allowed. No live migration or paid generation.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-media-immutability.md.

### 2026-09-19 media completion accounting (local migration only)

Migration 20260919070000 serializes audio/translation/image usage insertion with
organization-locked reservations. Native CI run 35417114024 succeeded for source
3a4ce5c: 52 migrations, 37 SQL suites and 12 concurrency cases across four meters.
No live changes. Next audit: active audio/translation input_ref.creditUnits
mutation, then versioned retail conversion and broad product acceptance.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-media-accounting.md.

### 2026-09-19 native concurrency acceptance harness

Added tests/security/run-native-postgres.mjs and a dedicated PostgreSQL 16 CI
workflow. Uses separate psql connections and pg_stat_activity lock assertions
for competing reservations, completion accounting and rollback release. Only
loopback port 55439/test user, a generated disposable database and synthetic
fixtures are used; no application credentials or live migrations. Syntax and
51 migrations/36 SQL suites pass locally. Native GitHub Actions run 35416935051
completed successfully for source aed4094, including all three concurrency cases.
Latest continuation: Codex Sessions/2026-09/2026-09-19-bookworm-native-ci.md.

### 2026-09-19 shared text funding (local only)

Migration 20260919060000 replaces the metadata-only reservation trigger with one
shared guard for metadata, writer, proofreader, copyeditor, consistency and
bookbible jobs. It counts all their active holds under the organization lock.
ai_credits usage insertion acquires that same lock through commit so completion
cannot race the consumed/pending reads. Text enqueue maps capacity/role errors;
accepted request replay now precedes quota checking and validates book/agent.
205 API tests, API TypeScript, 51 migrations and 36 SQL suites pass locally.
NOT applied live. Native multi-connection proof and token-based retail conversion
are still open; tests are not a claim of full billing or product readiness.

### 2026-09-19 metadata funding reservation (local only)

Migration 20260919050000 reserves one current operational ai_credits unit when
metadata jobs enter queued/running. It locks the organization, requires editing
membership and explicit allowance, and counts monthly usage plus pending metadata
across its workspaces. Queued-to-running retains a hold; reactivation rechecks.
API quota/role conflicts stop before the provider. 204 API tests, API TypeScript,
50 local migrations and 35 SQL assertion files pass. NOT applied live.
This does not approve retail pricing or finish usage-based conversion. Reservation
coordination with other text-generation workflows sharing ai_credits remains a
launch gate, along with token-cost quoting/reconciliation and native race tests.

### 2026-09-19 durable metadata receipts (local only)

New metadata_service_receipts table is service-only/RLS-enabled, linked to the
AI job with cascade deletion and a bounded result object. Production metadata
requires a saved job ID, service token and Supabase service credentials. It
reserves a request fingerprint before provider execution, saves the result before
success, and reads persisted results after process-cache loss. Unknown reserved
outcomes never regenerate; changed fingerprints conflict. Mock-only tests can
opt into durable storage with AI_RESULT_STORE=supabase. No new dependencies.
This migration has NOT been applied live. Worker restarts are covered with an
HTTP storage simulation; actual deployed PostgREST/multi-worker acceptance stays
open. A crash between provider completion and receipt persistence can still leave
an unknown outcome requiring reconciliation, not automatic retry spending.

### 2026-09-19 metadata result recovery

Lost AI-service responses and uncertain completion persistence no longer mark
metadata jobs failed/release their active slot. New author-scoped recovery POST
reads the existing AI-service job with GET only, validates job/book/workspace/
agent identity and pinned source refs, then uses the idempotent completion RPC.
The editor exposes Recover existing result with original-credit settlement copy.
Missing, foreign or unverifiable receipts keep the request pending; no age-based
failure or new provider generation. The AI service currently retains results in
process memory only, so a service restart can still require manual reconciliation.
203 API and 68 web tests pass. Native PostgreSQL CLI/container tooling was absent,
so native two-connection race testing remains unverified. No live actions.

### 2026-09-19 metadata concurrency constraint (local only)

Migration 20260919030000 enforces one queued/running metadata job per author/book
with a partial unique index. API insert conflicts return the existing active ID
before any provider call; UI requires status refresh. Terminal jobs free the slot.
Existing duplicate active rows make migration fail; no cancellation/deletion is
performed. Reconcile real provider state before resolving such duplicates.
Verified 201 API/68 web tests and 48 local migrations/33 SQL assertion files.
Includes concurrent API requests against a stateful constraint fake and real SQL
constraint/slot-release assertions. Native multi-connection race test remains.
NOT applied live. Deployment must include this migration before relying on it.

### 2026-09-19 pending metadata visibility

Metadata history also returns safe id/time/status fields for the current user's
queued/running metadata jobs in this book. The editor checks history on load and
blocks new generation while status is unknown or pending; refresh is read-only.
Failed reads fail closed, and terminal jobs disappear from pending results.
No prompt/key exposure, stale-age cancellation, or automatic retry spending.
This is a UI recovery guard, not a database concurrency lock across tabs.
200 API and 68 web tests pass; API/web TypeScript passed. Browser acceptance
and stuck-job operational reconciliation still require work.

### 2026-09-19 saved metadata draft recovery

GET /books/:bookId/metadata/drafts returns the latest 20 successful metadata
jobs as validated candidates after book membership checks. Private prompts,
request keys and job diagnostics are not returned. No provider or billing calls.
BookMemoryClient can load/open these drafts after a reload without overwriting
the form; explicit Use draft and Save metadata remain required. The UI warns
that drafts may refer to older manuscript versions. Malformed saved candidates
are omitted, not presented as valid. Pending-job recovery remains separate.

### 2026-09-19 metadata retry safety

BookMemoryClient now locks tone/audience while an unresolved metadata generation
key exists. Editing previously discarded the key after a lost response, allowing
another paid generation. Network/5xx/running and incomplete-success responses
retain the key; confirmed failed jobs and pre-generation validation failures
allow correction. This is tab-local recovery, not cross-session persistence.
67 web tests passed; full product/release gates remain open.

### 2026-09-18 fixed EPUB layout controls

EPUB 1.8.0 honors saved fixed_layout trim, margins and typography. Publishing
Studio reuses print controls, preserves settings across flow changes, and hides
print-only bleed/page numbering for EPUB. Legacy fixed defaults remain 6x9/Vera;
legacy print defaults are preserved. New editions default to Vera. RTL fixed
layout is blocked in the UI with a reflowable alternative, matching the worker.
Verified 298 services, 197 API, 66 web, 12 E2E, TypeScript and production build.
Native tests check actual PNG geometry, altered output and save/reload behavior.
No browser/retailer-reader acceptance or live changes claimed.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-fixed-layout-controls.md`.

### 2026-09-18 raster fixed-layout EPUB

EPUB 1.7.0 stops ignoring flow=fixed. It paginates through the embedded-font
6x9 PDF renderer, converts actual pages using local Poppler, and packages
viewport-sized XHTML images with pre-paginated metadata, chapter navigation,
cover/front landmarks and text alternatives. Optional title page is honored.
Reflowable contents navigation uses an explicit spine layout override.
No selectable text: UI and operations docs explain rasterization, fixed default
typography/trim and inherited script limitations. This is a working fixed-page
path, not full fixed-layout/accessibility/retailer certification.
Verified 296 services, 12 E2E, 65 web, all workspace TypeScript and production
build. Native tests used Poppler 26.07.0 with no skips. Converter failure/missing
dependency stops with actionable errors and cleans temporary files. No live work.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-fixed-epub.md`.

### 2026-09-18 contents visual stress fix

PDF 1.12.0 fixes a reproduced LayoutError with 20pt contents text, narrow trim,
long chapter titles and Roman numbering starting at 9999. Wide labels now
stack below titles instead of reserving most of the title width. Contents rows
may split within a page-spanning entry. Standard layout remains unchanged.
New scripts/preview-print-contents.py creates synthetic PDFs and PNG previews
using local pdftoppm, no network or real manuscripts. Standard/stress pages
were visually inspected. Verified 291 services and 8 E2E; nine focused TOC
tests include the stress regression and deterministic output. No live work.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-contents-visual-check.md`.

### 2026-09-18 print contents pages

PDF 1.11.0 adds opt-in include_table_of_contents, saved through Studio/API/client
and Python edition config. Multi-pass layout resolves actual chapter pages;
contents links and PDF bookmarks use chapter destinations. Arabic/Roman labels
follow starting-number settings; hidden numbering omits labels. Title wrapping
reserves space for page labels, and core 1.0.8 validates contents-font glyphs.
Eight new actual-PDF tests cover 65-chapter/multi-page TOCs, exact label-title
pairs, destinations, font repagination, wrapping, opt-out and determinism.
Verified 290 services, 196 API, 65 web, all workspace TypeScript, production
build and 8 E2E. Print retailer journeys now have 36 pages including contents,
and exact cover/interior bytes survive preflight/packaging. Browser assertions
added but not run (previous fixture startup policy denial remains). No live work.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-print-contents.md`.

### 2026-09-18 EPUB navigation settings

EPUB 1.6.0 now honors saved navigation: toc inserts a readable contents page
after front matter; toc+landmarks also emits section links to available cover,
title/copyright, contents and first chapter; none keeps mandatory reader TOC
but omits the contents page from the spine. UI labels explain this distinction.
Navigation title honors metadata overrides, escapes text and retains direction.
Verified 282 services, 8 E2E, 65 web tests and web TypeScript. Six new cases
check every nav target/fragment, mode/front-matter combination and determinism;
existing import roundtrips remain green. No live/paid operations.
Print TOC remains a separate unimplemented feature, not covered by this change.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-epub-navigation.md`.

### 2026-09-18 cross-service export acceptance

Broad verification found three stale print E2E fixtures (too short/no full
cover). They now import 32 chapters, render 34-page interiors with copyright
and embedded fonts, compose covers, run actual channel preflight, and preserve
exact PDF/cover bytes in ZIPs. Lulu uses all-edge bleed; KDP/B&N use outer.
Corrected stale core-1.0.6 assertions left after the front-matter version bump.
Verified: all 8 E2E, 276 service and 30 Python security tests. These tests do
not cover live providers, database orchestration, native storage or retailer
submission. Release checklist records the corrected evidence and open gates.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-export-acceptance.md`.

### 2026-09-18 relevant illustration memory

Illustrations now reuse book-scoped PostgreSQL full-text search to prioritize
matching bible entries ahead of the first 100 fallback rows. Matches are
rehydrated from current bible rows with book scope checked again and duplicates
removed. Existing text budget, prompt fingerprints, reference checks and credit
reservation remain intact. Search errors stop before provider/credit work.
Context version is image-book-context-2. This is keyword retrieval, not semantic
search; manuscript hits can share the top-20 search budget.
Verified: 196 API tests, API TypeScript, all 47 migrations and 33 SQL assertion
files in disposable PostgreSQL. New cases cover a character beyond 100 entries,
foreign match exclusion and missing retrieval migration. No live operations.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-image-retrieval.md`.

### 2026-09-18 illustration source fingerprints

Image jobs now record a SHA-256 of the exact effective provider prompt plus
ordered reference asset IDs/checksums and a context format version. No prompt
text, manuscript facts, storage paths or image bytes are added to job metadata.
Existing public history continues to omit input_ref. Book-bible retrieval is
ordered by ID before its 100-row bound, and attribute keys are sorted before
their bound, avoiding context changes caused only by database/key order.
Verified: 194 API tests and API TypeScript, including actual route/provider
prompt hash equality, reference checksums and unchanged safety checks.
This is provenance, not a guarantee of visual consistency or a stored prompt
snapshot. No paid provider call, migration or deployment occurred.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-image-provenance.md`.

### 2026-09-18 edition front matter

Publishing Studio now saves bounded publisher/imprint and exact copyright
notice text for print and EPUB. Print title pages include subtitle and author;
EPUB title pages are opt-in to preserve existing manuscript/import behavior.
A copyright page appears only when notice or publisher is supplied; no legal
claims or ISBNs are invented. Saved ISBN is included when present. EPUB uses
edition metadata overrides and registers pages in manifest/spine, plus rights
and publisher metadata. PDF `1.10.0`, EPUB `1.5.0`, core rules `1.0.7`.
Print font checks cover these new strings with located findings.

Verified: 276 service tests, 193 API tests, 65 web tests, workspace TypeScript,
production build; 34 focused rendering tests rerun after rule version bump.
New browser save/reload assertions are written but not run: the tool policy
rejected startup of the isolated fixture web server. No live operations.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-front-matter.md`.

### 2026-09-18 print page-number layout

PDF `1.9.0` places the entire numbering font box at least 0.5in inside finished
trim and keeps a 6pt gap from the body frame. Outer numbers align their outer
edge with the mirrored margin, rather than centering on that boundary. Small
top/bottom margins that cannot fit numbering produce a located preflight
finding and a render 422; authors can increase that margin, move the numbers,
or disable numbering. Core rules `1.0.6` also reject margins leaving no body
area. Starting numbers now match the API's 1-10000 range. Publishing Studio
shows the recommended 0.75in margin on the selected numbering edge.

Verified: 268 services and workspace TypeScript. Twenty-five pagination tests
include dense actual PDFs across three positions, two font paths, three bleed
settings, mirrored alignment, HTTP error/recovery, long Roman labels and input
bounds. pypdf's multiline visitor coordinates were unreliable; the geometry
fixtures use short lines with explicit text matrices. This does not certify
all imported text/image boundaries or old artifacts. No live operations.
Current note: `Codex Sessions/2026-09/2026-09-18-bookworm-page-number-layout.md`.

### 2026-09-18 KDP rendering and preflight consistency

Supersedes the odd-page blocking behavior in the checkpoint below. Cover
renderer `paperback-cover-1.1.0` uses KDP's even manufacturing page count
automatically; a 25-page manuscript receives a spine calculated for 26 pages.
KDP `1.4.0` reports this as information, so authors can package the book without
manually adding a blank page. Custom printer templates still require their
exact supplied count. Cover generation and preflight share the same stock/trim
page ranges, including standard-color minimums and letter-size maxima.
Preflight's parsed page-count cache is now confined to one evaluation.

Verified: 243 service tests and all workspace TypeScript checks. An actual
25-page book goes through rendering HTTP, preflight HTTP and deterministic ZIP
packaging, with exact interior/cover bytes preserved and the expected spine
width measured from the PDF. Regression tests reject stale odd-count covers
and check all eight supported KDP profile/regular-or-letter combinations.
Shared note: `Codex Sessions/2026-09/2026-09-18-bookworm-kdp-render-consistency.md`.
No production build or browser test rerun was needed for the single UI copy
change; the previous build is historical. No live operations occurred.

### 2026-09-18 local retailer page and margin update

KDP `1.3.0`, B&N `1.2.0`, and Lulu `1.3.0` now evaluate the actual rendered
PDF. KDP uses trim plus saved ink/paper profile for current min/max pages,
applies its page-count-dependent gutter and outside margins, and blocks an odd
interior when KDP's even-page rounding would invalidate the generated cover
spine. B&N enforces 18-800 pages and its 0.75in inner/0.5in other margins.
Lulu enforces the 32-800 perfect-bound range and reports its documented
safe-area/gutter recommendations as warnings. B&N now receives the same actual
geometry validation already used by KDP/Lulu.

Focused tests use real PDFs; the full rendering suite passes 101 tests. Final
workspace, Git, graph and shared-vault evidence belongs in the current session
note after checkpointing. This is deterministic local preflight, not live
retailer acceptance or physical printer proof. No deployment, migration,
provider call, customer-data operation or retailer submission was performed.

### 2026-09-18 local full-bleed illustration update

Manuscript artwork can now be saved as an inline image or a dedicated
full-bleed print page with horizontal/vertical crop focus. `pdf-1.8.0` paints
that image across the physical PDF page, suppresses the page number, preserves
inline ebook behavior, and fails instead of silently substituting an inline
layout. Core rules `1.0.5` require print bleed and enough source pixels for a
300-DPI page after crop. Print normalization retains the minimum useful raster
instead of reducing every image to the old 2400-pixel width.

Verified: 221 service, 192 API and 64 web tests; workspace TypeScript; a real
PDF has a dedicated full-page image between the surrounding text pages;
isolated browser acceptance saves/reloads focus controls and fits at 390px.
No live service, migration, provider, customer-data or deployment operation.
Production build and the final Git/graph evidence are recorded in the current
vault session note after checkpointing. Physical printer proof and automated
safe-zone/contrast review remain required.

### 2026-09-18 local media finishing update

Completed chapter narration can now be downloaded as one private MP3 from
Publishing Studio. Caller-scoped RLS reads verify segment order, exact private
paths, sizes and checksums before native decoding/assembly. This reuses saved
audio without new OpenAI calls or generation credits. `chapter-audio-1.0.0`
uses a bounded FFmpeg subprocess, not byte concatenation. It is not loudness
mastering, pronunciation QC or retailer-audio certification.

`cover-1.3.0` fits measured title/subtitle/author/QR-label bounds, prevents
footer collisions and preserves integer QR modules/quiet zones. `pdf-1.7.0`
embeds every used font when both body and heading choose Vera, including
vendored licensed DejaVu Sans Mono for code. Legacy font settings remain
unchanged; RTL shaping is still unsupported. Source licenses/checksums are
retained in `services/rendering/fonts/`.

Verified: TypeScript checks, isolated Next production build, 217 service,
192 API and 64 web tests; browser publishing and audio
failure/retry/download/mobile acceptance. Native tests inspect actual audio
duration/order/format and PDF font streams, while browser/API transports use
fixtures. Final build/Git evidence and exact next steps are in
`Codex Sessions/2026-09/2026-09-18-bookworm-media-finishing.md` in the vault.
No live deployment, migration, paid generation or customer data operation.

### 2026-09-18 local interior geometry update

`pdf-1.6.0` adds saved `bleed_edges` (`outer` for KDP, `all` for Lulu),
corrects mirrored frame cycling after page two, and anchors page numbering to
the finished trim area. Existing editions without the field keep their old
all-edge setting; new UI drafts default to outer edges. KDP/Lulu rule versions
are now `1.2.0`: they reject wrong printer bleed and inspect actual PDF page
dimensions/crop/rotation. Margins are measured from the trim edge. This does
not yet place illustrations into the bleed area or certify printer acceptance.
See `Codex Sessions/2026-09/2026-09-18-bookworm-interior-geometry.md` in the
shared vault for final test/Git evidence and remaining work.

### 2026-09-18 local full paperback cover update

Publishing Studio now saves back/spine text, colors, paper profile and custom
template dimensions. `paperback-cover-1.0.0` composes one CMYK back/spine/front
PDF from the actual rendered interior page count. The raster front is composed
at 300 DPI; back/spine fonts embed. Custom templates must match the page count;
text overflow, unsupported glyphs, narrow spine text and stale PDF geometry are
rejected. This reserves barcode space; it does not issue an ISBN or barcode.
API render paths and private package transport preserve `cover.pdf`. Core rules
`core-1.0.4` require full covers for print retailer packages and recheck their
geometry. Existing ebook PNG covers remain supported.

Current evidence: workspace TypeScript checks, an isolated Next production
build, 175 service, 188 API and 63 web tests; Publishing Studio
browser acceptance includes save/reload, paper settings, font choice, package
history and 390px containment. Browser bytes are fixtures; actual PDFs and ZIPs
are checked separately in service tests. No live deployment or migration.
Printer proof/acceptance, full interior bleed/font coverage, RTL and hardcover
remain unfinished. See the shared vault note
`Codex Sessions/2026-09/2026-09-18-bookworm-paperback-cover.md` for final build
and Git evidence and exact next steps.

### 2026-09-18 local print typography update

Publishing Studio, edition API validation and the API client now accept
`BookwormVera` / `BookwormVera-Bold` for print body and headings. The
`pdf-1.5.0` renderer embeds ReportLab's bundled regular/bold/italic/bold-italic
Vera fonts. Core preflight `core-1.0.3` and direct rendering check actual
printed text against the chosen font, including marks, tables and captions;
unsupported characters produce located errors before output. Existing font
settings remain compatible. Coverage is limited Latin; RTL shaping, other
scripts and complete font embedding for code/page numbers remain open.

Verified in this slice: workspace TypeScript checks, 165 service tests, 62 web
tests, and four edition API tests. Generated PDF inspection verifies four font
streams, Unicode text extraction, and deterministic bytes. No production build,
native browser acceptance, live migration, provider call or deployment was run
for this slice. See `Codex Sessions/2026-09/2026-09-18-bookworm-print-fonts.md`
in the shared vault. The older full verification snapshot below is historical.

The authorized live initialization is now complete on Supabase project
`cyhqtwndadlyzpeatxws`: all then-current 45 repository migrations are installed. The newest
migrations create a safe profile row for every Auth identity, enforce zero
text/image/audio generation allowance without an explicit paid entitlement,
default commercial plans to unpublished, and add the durable audiobook queue.
The live definitions were read back and confirm default-deny plan/audio access. No seed
plans, test users, payments, provider calls, publishing submissions or customer
content were created. Remaining advisor notices are the public `citext`
extension plus intentionally private no-policy service tables and nine
authenticated, internally-authorized SECURITY DEFINER RPCs; review before any
change rather than revoking them blindly.

OpenAI is now the only production-default generator. Text uses the Responses
API with `gpt-6-astra`; images default to `gpt-image-2.5-sunburst`; audiobook
configuration targets `gpt-4o-mini-tts`. Current official model-specific text
and image estimates replace the stale generic GPT rate. Mock remains explicit
for tests. No OpenAI key is configured, so no live generation or spend was
performed.

Audiobook chapter narration is now a durable, paid-only workflow. Authors can
create an audiobook edition in Publishing Studio, choose a saved chapter,
acknowledge the AI-voice disclosure, queue version-pinned segments, refresh
progress, preview private MP3s, and download short-lived links. Segments are at
most 4,096 Unicode characters; queue records hold source ranges/hashes rather
than copied manuscript text. The leased worker (`npm run worker:audiobook`)
uses private recovery receipts and atomically creates trusted assets, AI run
telemetry, and `audio_credits` usage. Missing plan allowance is zero. Speech
cost is explicitly a word-rate estimate until reconciled against OpenAI usage.
Mastering/concatenation, loudness and pronunciation QC, retail audio packaging,
and live-provider acceptance remain open; segment MP3s are not retail-ready.

Translation is now implemented and locally verified, but its additive
`20260912180000_translation_workflow.sql` migration is deliberately **not yet
applied** to the live project. It queues one paid, version-pinned chapter job
per saved chapter and records source pointers/hashes rather than manuscript
text. The `npm run worker:translation` consumer uses the server-only OpenAI
Responses API (`OPENAI_TRANSLATION_MODEL`, default `gpt-6-astra`), fenced
leases, and private completion receipts. A completed project is reviewable and
can create a separate text-only draft only by explicit author action; it never
overwrites or publishes the source. One credit covers each started 1,000 source
characters, with missing `translation_credits_monthly` allowance defaulting to
zero. No key, provider call, spend, or live migration was made by this work.
Before live use: approve/apply that migration, set real plan entitlement,
configure and supervise the worker, and perform live quality/cost acceptance.

The author dashboard now uses one tenant-scoped aggregate endpoint instead of
demo counters or one browser request per book. It shows real books, live asset
and cover/illustration counts, open/failed jobs, ready retailer packages, recent
allowlisted job/activity rows, ledger balance, and all four paid generation
meters. Local source now includes member-readable, role-gated retailer CSV
report imports with database-derived source identity, replay-safe immutable
reconciliation, active source/period overlap protection, source-only activity,
and currency-safe totals; package creation is never reported as a sale. The
additive `20260912190000_retailer_sales_imports.sql` migration is not installed
live, so that environment still truthfully reports sales as `not_connected`.
Billing and dashboard share zero-default text, image, audio, and translation
entitlements.

Google OAuth code and callback regression coverage pass, and the live Auth
profile trigger is installed. Google sign-in remains unavailable because the
Supabase Google provider is disabled until the operator creates one Web OAuth
client and stores its ID/secret in Supabase. Exact setup is in
`docs/GOOGLE_OAUTH_SETUP.md`; customers use their normal Google accounts and do
not create credentials.

The full shared tree is committed and pushed to
`codex/live-platform-checkpoint-20260912`; durable audiobook implementation is
saved at `e14c556`. The local remote no
longer embeds a credential. The current local full `npm run verify` passes: 186
API, 61 web, 47 migrations/33 SQL suites, 156 services, 8 E2E, 30 security,
load smoke and mock evals; the isolated production web build passes with the
translation and analytics routes. This is a
checkpoint, not market-readiness: Google/OpenAI credentials, paid plan pricing,
native Storage/scanner/provider acceptance, observability/backups, audio mastering,
translation, mobile completion and author beta remain open.

Graphify is now available to Codex, Claude, Hermes, and generic project
agents. Its committed code-and-SQL graph is `graphify-out/graph.json`; query
it before broad code searches and refresh it with `graphify update .` after
source edits. The shared vault entry point is
`C:/Users/Asus/Memory-Ai/AI Bookworm Graphify Index.md`. The graph is a local
AST index only, with no customer files, secrets, or provider-backed semantic
analysis.

Next: finish local mastering, loudness and pronunciation QC, then retail-audio
packaging. Native Supabase Storage/scanner/provider acceptance, paid billing
configuration, translation live acceptance, observability/backups, mobile
completion and broader release-checklist gaps remain open.
Deploy and supervise workers only after the requested build and release gates.
Do not declare the full product complete from these local fixtures.

## Safety and recovery

Live migrations for the named AI-BookWorm Supabase project and a secret-free
`codex/*` GitHub branch were explicitly authorized; payments, emails, provider
spend and retailer publishing are not authorized by these notes. Never copy secrets. Change fingerprints are recorded
by `node scripts/track-project-changes.mjs --record`; they are not source backups
or proof of authorship. Commits are allowed only on the authorized checkpoint
branch; do not reset or overwrite another agent's work.
