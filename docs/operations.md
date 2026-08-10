# Operations Runbook — AI Bookworm (Step 14)

## Health & readiness
- `GET /health` — liveness, no dependencies. Orchestrator restart probe.
- `GET /ready` — checks Supabase (`profiles` select) and Redis (TCP connect
  to `REDIS_URL`). 503 + `{checks}` if any dependency down. Traffic gate.

## Graceful shutdown
- API: SIGTERM/SIGINT → `fastify.close()` drains in-flight requests;
  force-exit after 10s (`SHUTDOWN_TIMEOUT_MS` in `services/api/src/index.ts`).
- Workers: `workers/ops.py GracefulShutdown` sets a flag on SIGTERM/SIGINT;
  the consume loop finishes the current job, then exits between jobs.

## Dead-letter queue
- A job failing after `WORKER_MAX_ATTEMPTS` (default 5) is recorded via
  `workers/ops.py: dead_letter()` and not retried.
- Target store: `public.dead_letter_jobs` (migration 0013). Interim: JSONL
  file at `$DLQ_PATH` until workers get a Supabase client (TODO).
- Payloads in DLQ records must be refs/ids only — never manuscript text.

## Log scrubbing (MASTER-BUILD-SPEC 17)
- Never log manuscript text, tokens, secrets, signed URLs.
- `services/api/src/lib/redact.ts` scrubs keys (text/content/manuscript/
  body/token/secret/authorization/signed urls…) and strings matching signed-
  URL signatures; applied to request logging in `app.ts`.

## Backups (Supabase / Postgres)
- Nightly logical dump, retained 30d:
  `pg_dump "$DATABASE_URL" --format=custom --file=backups/bookworm-$(date +%F).dump`
  Run from cron/GitHub Actions with the service connection string; store in
  versioned object storage outside the DB region.
- PITR: Supabase Pro+ offers point-in-time recovery (WAL); prefer PITR for
  RPO < 24h. Enable it in the project settings before launch.
- Quarterly restore drill (into a scratch project):
  1. `createdb bookworm_restore_test`
  2. `pg_restore --dbname="$RESTORE_URL" backups/<latest>.dump`
  3. Spot-check: counts on profiles/books/chapters; open one book end-to-end.
  4. Drop the scratch DB. Log drill date + RTO in this file.

## DR drill (quarterly)
1. Snapshot config: env var matrix below + Stripe webhook secrets.
2. Restore latest backup to a fresh Supabase project (above).
3. Point API/workers at the restore (env swap), verify `/ready` = 200.
4. Smoke: signup, create book, run one AI job, one render.
5. Fail back, record RTO/RPO achieved vs target.

## Scaling notes
- API: stateless; scale horizontally behind the load balancer on CPU/p99.
- Workers: scale each queue's worker count by queue depth
  (`LLEN jobs.<queue>`): 0 depth → scale to 1 (min), >50 sustained 5min →
  +1 worker, cap per queue at 10. AI jobs are GPU/API-bound — watch provider
  rate limits before raising the cap.
- DLQ growth > 0 should page ops; it means a poison message or an outage.

## Environment variable matrix
| Var | Used by | Required | Notes |
|---|---|---|---|
| SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY | api | yes | service key only on server |
| REDIS_URL | api (/ready), workers | yes | queue + readiness probe |
| QDRANT_URL / QDRANT_API_KEY | api (RAG) | yes | |
| OPENAI_API_KEY / ANTHROPIC_API_KEY / DEFAULT_AI_PROVIDER / DEFAULT_AI_MODEL | ai | one provider | |
| STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PRICE_IDS_JSON | billing | prod | |
| SERVICE_AUTH_TOKEN | api internal routes | prod | credits/referrals qualify |
| ADMIN_USER_IDS | api admin routes | ops | comma-separated user ids |
| API_PORT / WEB_PORT / AI_SERVICE_PORT | services | no | defaults 3001/3000/8000 |
| SENTRY_DSN / OTEL_EXPORTER_OTLP_ENDPOINT | api | no | observability |
| LOG_LEVEL / NODE_ENV | api | no | |
| WORKER_MAX_ATTEMPTS / DLQ_PATH | workers | no | DLQ: 5 attempts, ./dead-letter.jsonl |

## Admin console
- Web: `/admin` (tabs Users/Jobs/Flags/Support/Audit); non-admins get "No
  access" (API returns 403).
- API: `/v1/admin/*` behind `ADMIN_USER_IDS` + service-role client. Every
  mutation writes an `audit_logs` entry (actor, action, entity, after-json —
  ids/status only, never content).
- Feature flags: `feature_flags` keyed by (key, scope_type, scope_id);
  toggle via `PUT /v1/admin/flags/:key`.
