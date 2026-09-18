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

Next: deploy and supervise the audiobook and translation workers, add
mastering/concatenation, loudness and pronunciation QC, then retail-audio
packaging. Native Supabase Storage/scanner/provider acceptance, paid billing
configuration, translation live acceptance, observability/backups, mobile
completion and broader release-checklist gaps remain open.
Do not declare the full product complete from these local fixtures.

## Safety and recovery

Live migrations for the named AI-BookWorm Supabase project and a secret-free
`codex/*` GitHub branch were explicitly authorized; payments, emails, provider
spend and retailer publishing are not authorized by these notes. Never copy secrets. Change fingerprints are recorded
by `node scripts/track-project-changes.mjs --record`; they are not source backups
or proof of authorship. Commits are allowed only on the authorized checkpoint
branch; do not reset or overwrite another agent's work.
