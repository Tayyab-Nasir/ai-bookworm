# MVP Release Checklist

PRD Appendix B rendered as a checklist. Statuses are honest: `DONE` = verifiable locally with fixtures/code tests; `PENDING-INFRA` = needs live Supabase/Stripe/Flutter/production env (exact verify steps given). Nothing is marked DONE on faith.

Legend: DONE = verified locally | PENDING-INFRA = blocked on live infra, steps below | PARTIAL = partially verifiable locally

| # | Item | Status | Evidence / verify steps |
|---|------|--------|-------------------------|
| 1 | Production domain/TLS and WAF configured | PENDING-INFRA | Requires production env. Verify: `curl -sf https://<prod-domain>/v1/health` returns 200 with valid TLS (`openssl s_client -connect <domain>:443 -servername <domain>` shows a trusted chain); WAF rule set attached at CDN. |
| 2 | Supabase production project configured | PENDING-INFRA | Verify: `supabase link --project-ref <prod-ref> && supabase db push --dry-run` shows no drift; `psql "$PROD_DB_URL" -c "select 1"` connects; migrations 0001-0009 all present in `supabase_migrations.schema_migrations`. |
| 3 | RLS verified with automated isolation tests | PARTIAL | DONE locally: static contract test `npm run test:security` -> `tests/security/test_tenant_isolation_static.py` (26 tests). PENDING-INFRA live run: `psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f tests/security/tenant-isolation.test.sql` must print `TENANT ISOLATION: ALL CHECKS PASSED` and exit 0. |
| 4 | Redis and Qdrant production configurations verified | PENDING-INFRA | Verify: `redis-cli -u "$REDIS_URL" ping` -> PONG, eviction policy `allkeys-lru`, persistence per spec; `curl -sf "$QDRANT_URL/healthz"` and collections `book_chunks, book_bible, style_memory, community_posts` exist with workspace/book payload indexes. |
| 5 | AI provider keys stored securely | PENDING-INFRA | Verify: keys only in env/secret manager, never in repo (`git grep -i "sk-ant\|sk-proj" -- . ':!node_modules'` returns nothing); `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` set in prod secret store, not `.env` committed. |
| 6 | Upload scanning and limits enabled | DONE | `services/document/parsers/__init__.py`: `MAX_FILE_BYTES=100MB`, `MAX_ZIP_ENTRIES=10_000`, zip-slip guard; path-safety validator in `services/document/main.py`. Tested in `services/document/tests/test_parsers.py` (13 tests, `npm run test:services`). |
| 7 | Import fixtures passing | DONE | DOCX/EPUB/TXT/PDF parser tests: `npm run test:services` -> `services/document` 13 tests green. |
| 8 | EPUB/PDF fixtures passing | DONE | `npm run test:services` -> `services/rendering` 8 tests green (deterministic sha256, reproducible artifacts); E2E render reproducibility asserted in `tests/e2e/test_critical_journey.py`. |
| 9 | Preflight rules tested | DONE | `npm run test:services` -> rendering/publishing suites green; `services/rendering/rules/{core,kdp,apple,bn,lulu}_v1.py` versioned rule sets; preflight E2E in `tests/e2e`. |
| 10 | Billing/webhooks tested | PARTIAL | DONE locally: `services/api/src/step11.test.ts` (credit ledger, meters, webhook sig verification) green in `npm run test:unit`. PENDING-INFRA live: `stripe listen --forward-to <api>/v1/webhooks/stripe` then `stripe trigger checkout.session.completed` -> ledger row appears; confirm signature rejection with a tampered payload (expect 400). |
| 11 | Referral ledger tested | DONE | `services/api/src/step12.test.ts` green (`npm run test:unit`): attributed->qualified->rewarded state machine, idempotent ledger transactions, anti-fraud reversal entries. |
| 12 | Community moderation tested | DONE | `services/api/src/step12.test.ts` green: reports -> moderation queue -> approve/remove actions, rate controls. |
| 13 | Flutter beta builds tested | PENDING-INFRA | Flutter SDK absent on this machine. Verify on a machine with Flutter: `cd apps/mobile && flutter pub get && flutter analyze && flutter test && flutter build apk --release`; install on a device and walk auth -> books -> reader -> AI review. |
| 14 | Monitoring/alerting/backups enabled | PENDING-INFRA | Verify: Sentry DSN set (`SENTRY_DSN`), OTel exporter endpoint reachable; Supabase PITR enabled (`supabase projects api-usage --project-ref <ref>` / dashboard); alert rules firing on queue depth + 5xx rate. |
| 15 | Disaster recovery tested | PENDING-INFRA | Verify: restore latest PITR snapshot to a staging project (`supabase db restore`), point staging API at it, run `npm run verify` against staging; confirm RPO/RTO recorded. |
| 16 | Privacy/terms/support processes prepared | PENDING-INFRA | Legal/ops artifact, not code. Verify: privacy policy + ToS pages published, support mailbox routed, data-deletion runbook exercised on staging. |
| 17 | Beta authors completed | PENDING-INFRA | Requires production launch. Verify: N beta authors complete signup -> import -> edit -> AI -> preflight -> export without a P0/P1 bug. |

## Summary

- DONE locally: 6, 7, 8, 9, 11, 12 (fixtures/code tests, all green under `npm run verify`)
- PARTIAL (local done, live pending): 3, 10
- PENDING-INFRA: 1, 2, 4, 5, 13, 14, 15, 16, 17

## Local verification matrix (all green at commit time)

| Suite | Command | Result |
|-------|---------|--------|
| Typecheck all workspaces | `npm run typecheck` | pass |
| Unit (packages + API, 83 tests) | `npm run test:unit` | pass |
| Python services (67 tests) | `npm run test:services` | pass |
| E2E P0 journey (2 tests) | `npm run test:e2e` | pass |
| Security (26 tests) | `npm run test:security` | pass |
| Load smoke (50 concurrent) | `npm run test:load` | pass, 0 5xx |
| AI evals (golden proofreader) | `npm run evals` | PASS, must-find 5/5, 0 false positives |

Not run locally (no infra): live RLS SQL, Stripe live webhook round-trip, Flutter, backups/DR, production WAF/TLS.
