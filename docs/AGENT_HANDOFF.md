# AI Bookworm shared-agent handoff

## Read first

This is the full AI-native publishing application, not only its landing page.
Shared vault: `C:/Users/Asus/Memory-Ai`.

- Current detailed Codex handoff:
  `Codex Sessions/2026-08/2026-08-31-ai-bookworm-codex-handoff.md`.
- Latest supplemental checkpoint:
  `Codex Sessions/2026-09/2026-09-12-bookworm-atomic-community.md`.
- Claude handoff:
  `Claude Sessions/2026-08/2026-08-31-ai-bookworm-project-final-handoff.md`.
- Shared board: `Hermes Context/active-tasks.md`.
- Read vault `AGENTS.md` and `CLAUDE.md` before writing. Do not edit other
  agents' private memory or the generated startup briefing.
- Read git status before edits. Preserve shared uncommitted work. Saved
  completion claims require current code and behavioral verification.

## Current checkpoint: 2026-09-12

The authorized live initialization is now complete on Supabase project
`cyhqtwndadlyzpeatxws`: all 42 repository migrations are installed. The newest
two migrations create a safe profile row for every Auth identity, harden an
advisor-reported function search path, remove a duplicate index, and enforce
zero text/image generation allowance without an explicit paid entitlement.
The live function definitions were read back and confirm zero fallback. No seed
plans, test users, payments, provider calls, publishing submissions or customer
content were created. Remaining advisor notices are the public `citext`
extension plus intentionally private no-policy service tables and eight
authenticated, internally-authorized SECURITY DEFINER RPCs; review before any
change rather than revoking them blindly.

OpenAI is now the only production-default generator. Text uses the Responses
API with `gpt-6-astra`; images default to `gpt-image-2.5-sunburst`; audiobook
configuration targets `gpt-4o-mini-tts`. Current official model-specific text
and image estimates replace the stale generic GPT rate. Mock remains explicit
for tests. No OpenAI key is configured, so no live generation or spend was
performed. Audiobook synthesis is configured but not yet implemented as a
durable product workflow.

Google OAuth code and callback regression coverage pass, and the live Auth
profile trigger is installed. Google sign-in remains unavailable because the
Supabase Google provider is disabled until the operator creates one Web OAuth
client and stores its ID/secret in Supabase. Exact setup is in
`docs/GOOGLE_OAUTH_SETUP.md`; customers use their normal Google accounts and do
not create credentials.

The full shared tree is committed and pushed to
`codex/live-platform-checkpoint-20260912` at `5038791`. The local remote no
longer embeds a credential. Full `npm run verify` passes: 171 API, 54 web, 42
migrations/29 SQL suites, 156 services, 8 E2E, 30 security, load smoke and mock
evals; the isolated production web build passes with 27 routes. This is a
checkpoint, not market-readiness: Google/OpenAI credentials, paid plan pricing,
native Storage/scanner/provider acceptance, observability/backups, audiobook,
translation, mobile completion and author beta remain open.

Community creation now uses caller-authenticated `create_community_with_owner`
to save community and owner membership atomically. Migration
`20260912120000_community_creation.sql` and its SQL test cover validation,
anonymous/missing-JWT denial, duplicate slug and injected last-insert rollback.
42 migrations/29 SQL suites, community/referral API tests and API TypeScript
pass locally. The migration is live. This is atomicity, not durable retry replay.

Community directory and discussion UI have been upgraded. Discussion browser
passed before final stale-moderator-state cleanup; latest TypeScript passes.
Final browser rerun and production build remain disk-blocked. Temporary test
servers4398/4399 are stopped; user app3001 untouched. No live community writes.

Next: durable community creation/post/comment retry receipts, creation UI,
then final browser acceptance when disk has headroom. Native Supabase, Storage,
provider, billing, concurrency and broader release-checklist gaps remain open.
Do not declare the full product complete from these local fixtures.

## Safety and recovery

No live deployment, migration, payments, emails or retailer publishing is
authorized by these notes. Never copy secrets. Change fingerprints are recorded
by `node scripts/track-project-changes.mjs --record`; they are not source backups
or proof of authorship. No commits/staging/reset performed.

Disk exhaustion interrupted a handoff write and left this file empty. It was
rebuilt as this compact entry point. Historical checkpoints remain in the
intact detailed Codex vault handoff; consult that file for previous image,
import, rendering, publishing, retrieval and recovery work. Current vault
append must be verified separately; do not assume the interrupted write saved it.
