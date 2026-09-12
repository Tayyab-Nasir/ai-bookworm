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

Community creation now uses caller-authenticated `create_community_with_owner`
to save community and owner membership atomically. Migration
`20260912120000_community_creation.sql` and its SQL test cover validation,
anonymous/missing-JWT denial, duplicate slug and injected last-insert rollback.
40 migrations/27 SQL suites,12 community/referral API tests and API TypeScript
pass locally. No live migration. This is atomicity, not durable retry replay.

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
