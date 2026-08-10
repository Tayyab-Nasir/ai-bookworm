# AI Bookworm

AI-assisted book publishing SaaS. Monorepo per `docs/MASTER-BUILD-SPEC.txt`; build order per `docs/PLAN.md`.

Architecture rules: Supabase/PostgreSQL is the source of truth; Redis is transient (queues/cache/locks); Qdrant is a derived retrieval index. Originals are immutable; AI produces validated suggestions, never silent overwrites.

## Structure

- `apps/web` — Next.js/React web app (editor shell lands in Step 6)
- `apps/mobile` — Flutter mobile companion (Step 13)
- `services/api` — TypeScript Fastify API/BFF (`/v1`, Step 3)
- `services/ai` — Python FastAPI AI gateway/agents (Step 7)
- `services/document` — Python import/normalization service (Step 5)
- `services/rendering` — Python EPUB/PDF renderer (Step 10)
- `services/publishing` — Python channel adapters (Step 10)
- `workers/{ai,document,render,publishing}` — Python Redis queue consumers (stubs)
- `packages/types` — shared TS types mirroring DB enums/entities
- `packages/validation` — zod schemas (ApiError envelope, error codes)
- `packages/config` — zod typed env loader
- `packages/book-model` — canonical Book Model + document operations (Step 4)
- `packages/api-client` — generated typed API client (Step 3)
- `packages/ui` — shared UI components (Step 6)
- `supabase/{migrations,functions,seed}` — DB migrations/RLS (Step 2)
- `tests/{unit,integration,e2e,security,fixtures,ai-evals}`

## Run

Prereqs: Node 24+, npm 10+, Python 3.12+, Flutter SDK (mobile only). Copy `.env.example` to `.env` and fill values.

```bash
npm install                    # installs TS workspaces

npm run dev -w @bookworm/api   # Fastify API on :3001, GET /health
npm run dev -w @bookworm/web   # Next.js on :3000

# Python services (each): cd services/<name>
pip install -r requirements.txt
python main.py                 # FastAPI /health (ports 8000-8003)

# Workers (stubs, Step 5/7/10): cd workers/<name>; python worker.py

# Mobile: cd apps/mobile; flutter run
```

Checks: `npm run typecheck` and `npm test` at the root run across workspaces. CI: `.github/workflows/ci.yml`.
