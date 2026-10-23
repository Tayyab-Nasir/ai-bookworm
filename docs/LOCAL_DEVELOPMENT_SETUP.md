# AI Bookworm — local web development

The intended local origins are **web `http://localhost:3001`** and
**API `http://127.0.0.1:3002`**. Do not point the web proxy back at itself.
Service availability is a live observation, not a saved "running" badge.

## Environment

Store private settings in the ignored root `.env.local`, never Git or Obsidian.
Use the variable names in `.env.example`. For this project:

- `APP_URL=http://localhost:3001`
- `API_URL=http://127.0.0.1:3002`
- `API_PORT=3002`, `WEB_PORT=3001`
- Supabase public/server keys must refer to `cyhqtwndadlyzpeatxws`.
- Keep service-role keys, OpenAI keys and service tokens server-only.

Google sign-in uses the operator-owned Supabase Google provider. Customers do
not need OAuth credentials. The local redirect is exactly
`http://localhost:3001/auth/callback`; use the canonical localhost origin.

## Start the web and API

From `C:/Users/Asus/ai-bookworm`, use two PowerShell terminals:

```powershell
$env:API_PORT = '3002'
npm run dev -w @bookworm/api
```

```powershell
npm run dev -w @bookworm/web -- --hostname 127.0.0.1 --port 3001
```

Development processes load the repository-local environment. Production needs
an explicit environment/secret store. Stop your own processes with Ctrl+C;
do not terminate another agent's server. Next development may update generated
TypeScript includes; preserve shared `next-env.d.ts`/`tsconfig.json` drafts.
An isolated frozen source directory avoids touching those files.

## What health checks prove

- API `/health`: process liveness only.
- API `/ready`: Supabase read and a real authenticated Redis PING. Missing or
  unreachable configured Redis produces 503. Do not substitute a mock or
  describe liveness as full readiness.
- Neither proves scanner, document/rendering services, workers, OpenAI,
  Storage transfer or retailer export acceptance.

## Hosted migrations

As verified on 2026-10-23, **110 source migrations are applied** to AI-BookWorm.
See [the hosted review](HOSTED_MIGRATION_REVIEW.md) and its evidence receipt.
Do not paste the old combined SQL into the dashboard, replay migrations, or
repair timestamps to match source filenames. Hosted versions are application
timestamps. Refresh history, map names, review drift/recovery, then apply only
newly approved pending migrations.

The private application-only snapshot used for this upgrade is not a full
project backup. Auth/Storage/configuration disaster recovery remains a release
requirement. Never commit the snapshot's customer rows.

## Generation, credits and services

There is **no free production AI fallback**. Missing OpenAI keys or approved
pricing catalogs disable paid generation. Deterministic providers and simulated
credits are confined to explicit tests. Stripe is deferred at the owner's
request; missing Stripe configuration never bypasses credit enforcement.

Manual workspace/book creation and editing do not need OpenAI. Uploads require
the private scanner and healthy malware engine. Import, rendering, publishing
packages and generation require their authenticated services and separately
supervised workers. Next.js alone is not the full stack. See [operations](operations.md).

## Verification

```powershell
npm run test:migrations:inventory
npm run test:db
npm run test:db:upgrade
npm run test:db:crypto
```

These suites use disposable local fixtures, not the hosted project. They do not
prove Google login, native Storage HTTP or funded OpenAI behavior. Use the
[release checklist](release-checklist.md) for remaining acceptance gates.
Mobile work remains parked while the web app is finalized.
