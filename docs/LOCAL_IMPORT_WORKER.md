# Supervised local manuscript imports

The web app durably enqueues manuscript imports. A persistent document consumer
is required to scan, parse and commit them without operator-invoked one-shot
jobs. This launcher supervises that existing consumer; it does not introduce a
second queue, change import transactions or run any AI/payment role.

## Inspect and start

```sh
npm run imports:local -- --check
npm run test:local-import-worker
npm run typecheck:workers
# Start private HTTP processors and a real, fresh ClamAV scanner first.
npm run services:local -- --config .env.local
# In another terminal; this begins real processing in the configured project:
npm run imports:local -- --config .env.local
```

`--check` checks source entrypoint presence only. It reads no app configuration,
opens no network connection and starts no worker. It does not validate service
readiness. `--config` reads an explicitly named private environment file, limited
to 64 KiB. `ops/local-import-worker.env.example` lists required values. The
existing ignored `.env.local` may also be used; unrelated keys are not forwarded.
Never commit a real configuration file or put credentials in Obsidian.

**Starting the consumer processes all eligible imports in that Supabase project,
not just one book.** Review queued/running jobs and the project origin before
activation. Do not point an acceptance run at customer data or start unreviewed
paid consumers. Keep the current user's entitlement limits unchanged.

## Credentials and dependencies

Only Supabase URL/public/server credentials and the document/scanner URL/token
pairs reach the child, plus an allowlisted OS environment. Use distinct role
tokens. OpenAI, Stripe, generic service tokens, rendering/publishing credentials,
pricing/purchase flags, proxies and Node loader overrides are excluded. Common
Redis/Qdrant fields use unauthenticated loopback placeholders because this
consumer uses neither dependency. `NODE_ENV=production` prevents implicit
loading of a developer environment file in the child.

Document/scanner endpoints must be distinct loopback HTTP origins. The existing
bounded health probe checks the document health and scanner readiness, including
a real ClamAV engine/database report, before a consumer starts. Dependency loss
stops the consumer; repair the services and restart deliberately. A started PID
or healthy HTTP service alone is not proof that imports are completing.

## Supervision, shutdown and recovery

Unexpected exits restart after five seconds, limited to five starts per minute.
The launcher never changes roles or enables paid generation while recovering.
It forwards only known status/job-ID fields and opaque unavailability events;
raw stderr, connection strings, parser data and unexpected JSON are not echoed.
Known dependency failures remain visible as an opaque unavailability event.
Observe the API job and saved import receipt, not only process liveness.

Type `stop` plus Return or send SIGINT/SIGTERM to the launcher. A private IPC
handshake prevents activation if shutdown arrives while the TypeScript loader
is still initializing. The consumer finishes an already claimed operation and
stops future claims; idle/backoff waits wake immediately. Loss of the owning
IPC channel also stops the consumer after its current operation. A stubborn
owned process is force-stopped after six minutes, never by executable name or
an arbitrary input PID. Existing fenced leases, atomic import receipts and
retry rules remain authoritative after a crash or forced stop.

Normal standalone/systemd workers have no IPC channel and start as before.
An IPC-owning caller must wait for `document_worker_control_ready`, then send
exactly `{command: "start"}` or `{command: "stop"}`. Disconnecting means stop,
not permission to continue as an unowned daemon.

This is a local developer/operator launcher. Linux production supervision remains
the reviewed systemd setup in `WORKER_RUNTIME.md`; these files do not provision
hosting, install alerts or authorize deployment. The API, private processors and
scanner remain independently supervised. A local terminal ending is not a
hosted-availability guarantee.

## Acceptance

`tests/local-import-worker.test.mjs` exercises the actual document loop with
synthetic operations in owned child processes: startup cancellation, graceful
idle/active shutdown, owner loss, service loss, bounded crash recovery, forced
shutdown, restart cancellation and credential/log filtering.
The root TypeScript check now also checks every worker entrypoint, using its
explicit ESM package scope and the API's existing Fastify declarations. Runtime
loader checks remain separate; successful transpilation is not type checking.

Native author/files CI starts the real persistent consumer before enqueueing a
DOCX import through the actual API. It waits for that exact job's success and
then verifies its saved chapters, table, scanned private image, immutable original
bytes and tenant isolation. No direct `runOneDocumentJob()` call processes that
import. The native project and credentials are disposable and guarded; no
provider keys or customer uploads enter this acceptance run. Check its
source-pinned terminal result before claiming native acceptance.
