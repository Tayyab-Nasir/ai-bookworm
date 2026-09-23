# Hosting AI Bookworm on Vercel

Persistent worker launcher and Linux supervision setup: [Worker runtime](WORKER_RUNTIME.md).

Vercel is an appropriate host for the Next.js author application in
`apps/web`. It is not, by itself, the production host for Bookworm's durable
Fastify API, continuous workers, renderer, document parser, ClamAV scanner, or
retailer-package services.

## Current project state

- Linked Vercel project: `ai-bookworm` (`prj_diBXN02eBjjzQF9lmrvBcd5sBdba`).
- Existing production deployment: `dpl_GKiU1nugV2KqztjgMezhBQ4j9Mb8`, created
  2026-08-14, status `Ready`.
- Deployment URL:
  `https://ai-bookworm-9hwg6lcvu-tayyabnasir007-gmailcoms-projects.vercel.app`.
- Aliases: `https://ai-bookworm.vercel.app` and
  `https://ai-bookworm-tayyabnasir007-gmailcoms-projects.vercel.app`.
- Deployment protection is enabled. Unauthenticated requests are redirected to
  Vercel SSO; this has intentionally not been changed.

The current deployment predates the verified `2b0710d` Git checkpoint. Treat
it as an older protected preview of the web experience, not proof that the
current complete workflow is publicly deployed.

## Deployment topology

```text
Browser
  -> Vercel / Next.js (apps/web)
       -> server-side BFF (/api/backend/*) -> persistent Fastify API
                                                  -> Supabase / private Storage
                                                  -> private AI, parser, renderer,
                                                     packager and scanning services
                                                  -> PostgreSQL-lease workers
```

The browser must never receive `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`,
Stripe secret keys, service-auth tokens, scanner tokens, or provider keys.
Those belong to the persistent API/worker/service hosts.

## Vercel configuration

The repository is already linked through `.vercel/project.json` (ignored by
Git) and `vercel.json` currently points the Vercel build at `apps/web`.

Set these production variables in the Vercel project settings:

| Variable | Required | Value shape / purpose |
| --- | --- | --- |
| `APP_URL` | yes | Final public HTTPS browser origin, for example `https://app.example.com`. |
| `SUPABASE_URL` | yes | Authorized Supabase project URL. |
| `SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_ANON_KEY` | yes | Browser-safe Supabase public key. |
| `API_URL` | yes | Private/server-reachable HTTPS URL of the persistent Fastify API; used only by Next.js BFF routes. |
| `NODE_ENV` | Vercel-managed | `production`. |

Do **not** put `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, Stripe secret
keys, service tokens, or `ADMIN_USER_IDS` in Vercel for the web-only deployment.

Set equivalent server-only variables on the persistent API/worker hosts; the
complete authoritative list is in `docs/operations.md`.

## Before public production

1. Decide the canonical application domain and set `APP_URL` consistently on
   Vercel and the API host.
2. Add the domain and each approved preview URL to Supabase Auth redirect URLs.
3. Create the Google OAuth Web client once and configure Supabase's Google
   provider. Customers then sign in with their normal Google accounts; they do
   not create OAuth credentials.
4. Deploy and supervise the Fastify API, workers and private services before
   directing live browser traffic to the API.
5. Configure the Vercel environment variables above without placing secrets in
   source control.
6. Run a Vercel preview from the current Git checkpoint, then execute the
   signed-in author journey before promoting it.
7. Configure owner-approved plan prices and Stripe before enabling paid
   generation. Do not make an unfunded public AI endpoint available.

## Safe deployment sequence

From the repository root, after the project configuration is reviewed:

```powershell
# Read-only status checks
npx vercel inspect https://ai-bookworm-9hwg6lcvu-tayyabnasir007-gmailcoms-projects.vercel.app
npx vercel curl / --deployment https://ai-bookworm-9hwg6lcvu-tayyabnasir007-gmailcoms-projects.vercel.app -I

# Preview first. This creates a deployment; do not run it until variables and
# the persistent API are ready.
npx vercel deploy

# Promote a verified preview without rebuilding.
npx vercel promote <preview-url>
```

`npx vercel build --prod` requires a local Vercel settings/environment pull.
Do not pull production secrets to a developer machine solely for a build check;
the repository's isolated Next.js build plus the Vercel preview is the safer
review path.

## Git-driven deployments

Connect the GitHub repository to the Vercel project, retain deployment
protection for previews, and make the intended production branch explicit in
Vercel. The current verified source is on
`codex/live-platform-checkpoint-20260912`; choose a protected release branch
before making automatic production deployments. Every release needs a matching
Git commit, migration record, and vault handoff entry.

## What has not been changed

No public deployment protection, environment variable, OAuth setting, domain,
production alias, Vercel build configuration, or Vercel deployment was changed
while creating this runbook.
