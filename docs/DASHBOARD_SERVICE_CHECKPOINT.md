# Dashboard service routing checkpoint

## Fixed failure

The web app and Fastify API are separate processes. The local Google sign-in
preview used web port 3001 but had no `API_URL`. The backend proxy consequently
requested `/v1/workspaces` from the web server on that same port. A read-only
request reproduced HTTP 404 with `text/html`; the client displayed an unreadable
response error. This was not an OAuth credential failure.

Production now requires a server-side `API_URL`. The proxy rejects a web-server
target, including localhost, IPv4 and IPv6 loopback aliases on the same port,
before forwarding a session token. Development retains its API-port fallback
when the web and API ports differ. Unexpected upstream content becomes a private,
no-store JSON dependency error. Valid JSON, MP3 and audiobook ZIP responses keep
their existing handling. A malformed successful JSON result now throws instead
of masquerading as a saved operation.

## Local configuration

Use one consistent browser origin throughout Google login:

```dotenv
APP_URL=http://localhost:3001
WEB_PORT=3001
API_PORT=3002
API_URL=http://127.0.0.1:3002
```

`API_URL` belongs only in the web server environment, not a `NEXT_PUBLIC_*`
variable. Start the web and API processes separately; changing environment
variables requires restarting the existing web process. Authentication and
workspace access still use verified server-managed sessions. No service-role
key, provider key or caller-supplied bearer token is forwarded to the browser.

In production, use the actual HTTPS backend origin, not the Vercel frontend
origin or a loopback URL. Hosting the Next.js frontend alone does not start
Fastify, document/AI/rendering services, Redis or background workers.

## Native verification boundaries

The user completed Google login and reached `/dashboard`. On 2026-10-06, a
read-only named-project database query found one recently signed-in Google
identity and one matching profile, plus the installed transactional workspace
onboarding RPC. This aggregate check is not proof of a second account,
returning-user identity linking, logout or all dashboard workflows.

The same query still found 45 live migrations and absent retailer-sales tables.
Local source has 105 migration files. Do not silently hide missing analytics,
fabricate sales, grant free generation credits, or apply the remaining live
migrations based on this note. Review backups, dependency order, grants/RLS and
explicit live-operation authority first.

Targeted regressions observed four failures before implementation, then 33/33
Auth/BFF/client tests passed afterward. Full isolated verification, exact
candidate build/browser results, Git identity and current process ownership are
recorded in the dated Codex Obsidian handoff. None of this checkpoint claims a
deployed, commercially accepted or fully completed product.
