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
