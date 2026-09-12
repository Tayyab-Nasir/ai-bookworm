# AI Bookworm project map

This map is the shortest safe entry point for a new human, Codex, Claude, or
Hermes session. It is intentionally a navigation document, not a claim that the
entire product is release-ready.

## Authoritative sources

| Need | Start here | Authority |
| --- | --- | --- |
| Current cross-agent state | `docs/AGENT_HANDOFF.md` | Repository handoff, updated with verified checkpoints only. |
| Shared agent continuity | `C:/Users/Asus/Memory-Ai/Codex Sessions/2026-09/2026-09-12-bookworm-live-rollout.md` | Codex history and next operational gates. |
| Claude context | `C:/Users/Asus/Memory-Ai/Claude Sessions/2026-08/2026-08-31-ai-bookworm-project-final-handoff.md` | Historical UI and project takeover context. |
| Hermes/Codex shared task board | `C:/Users/Asus/Memory-Ai/Hermes Context/active-tasks.md` | Only the AI Bookworm section may be edited by project agents. |
| Product and release gaps | `docs/release-checklist.md` | Release readiness, not deployment authorization. |
| Operations and secret ownership | `docs/operations.md` | Environment-variable matrix, workers, recovery and runbooks. |
| Web hosting | `docs/VERCEL_DEPLOYMENT.md` | Vercel web hosting boundary and pre-deploy procedure. |
| Shared code context | `graphify-out/GRAPH_REPORT.md` and `graphify-out/graph.json` | Local AST graph for code and SQL; refresh it after source changes. |

Read the repository `AGENTS.md`, `docs/AGENT_HANDOFF.md`, vault `AGENTS.md`,
and `git status` before editing. Preserve uncommitted work and never write API
keys, OAuth secrets, service-role keys, tokens, customer manuscript content, or
private signed URLs into Git or the vault.

## Repository layout

```text
apps/web/                  Next.js author experience, auth BFF, dashboard and studio
services/api/              Fastify API, authorization, billing, durable-job orchestration
services/ai/               OpenAI text/retrieval service
services/document/         Manuscript parsing service
services/rendering/        EPUB/PDF/cover rendering and preflight service
services/publishing/       Retailer-package generation service
services/scanning/         ClamAV-backed upload scanning service
workers/                   Long-lived PostgreSQL-lease consumers
  ai/                      AI review consumer
  document/                Import consumer
  publishing/              Render/preflight/package consumer
  audiobook/               OpenAI speech consumer
  translation/             OpenAI chapter-translation consumer
packages/                  Shared validation, types, API client, config, UI and book model
supabase/migrations/       Ordered, append-only schema history
tests/                     SQL assertions, E2E, security, load and AI evaluations
docs/                      Product, operations, release, hosting and agent handoffs
```

## Runtime ownership

| Runtime | What it runs | Deployment rule |
| --- | --- | --- |
| Vercel | `apps/web` only: Next.js UI and server-side BFF routes | No service-role key, worker loop, scanner, renderer, or provider worker belongs here. |
| Persistent API host | `services/api` Fastify process | Provides the private API target configured as Vercel `API_URL`. |
| Persistent worker host | `npm run worker:ai`, `worker:document`, `worker:publishing`, `worker:audiobook`, `worker:translation` | Separate supervised processes; lease-based jobs are not Vercel request handlers. |
| Private service host(s) | AI, document, rendering, publishing, scanning/ClamAV | Not internet-facing; API reaches them through server-only service URLs/tokens. |
| Supabase | Auth, Postgres, RLS, private Storage, durable state | Current authorized project is `cyhqtwndadlyzpeatxws`; apply only additive reviewed migrations. |

## Current Git checkpoint

- Remote: `https://github.com/Tayyab-Nasir/ai-bookworm.git`
- Shared checkpoint branch: `codex/live-platform-checkpoint-20260912`
- Last verified source checkpoint before this map: `2b0710d` (always compare
  with `git ls-remote` before continuing).
- Last source feature checkpoint: `e14c556` — durable audiobook narration.

Use normal Git collaboration: inspect `git status`, branch from the intended
base, make focused commits, push a secret-free `codex/*` branch, and update the
shared vault with the exact commit. Do not assume an older Vercel deployment
matches the branch without inspecting it.

## Commands

```powershell
# Complete local verification
npm run verify

# Isolated web production build (does not disturb local development output)
$env:BOOKWORM_DIST_DIR = '.next-release'
npm run build -w @bookworm/web
Remove-Item Env:BOOKWORM_DIST_DIR

# Durable workers, each in its own supervised process
npm run worker:ai
npm run worker:document
npm run worker:publishing
npm run worker:audiobook
npm run worker:translation
```

The `Remove-Item` line above targets only the named process environment
variable. It does not delete repository content.

## Shared code graph

Graphify is installed for Codex, Claude, Hermes, and generic agents at both
the user and project levels. The committed `graphify-out/graph.json` lets a
new session query the same code-and-SQL structure without rebuilding it. It is
generated locally from source only: it contains no provider-derived document,
image, or customer-content analysis and incurs no API cost.

After source changes, run `graphify update .` from the repository root. The
local cache, cost record, and date-stamped recovery copies are deliberately
ignored; the graph and report are shared through Git. The companion Obsidian
export is linked from `C:/Users/Asus/Memory-Ai/AI Bookworm Graphify Index.md`.
