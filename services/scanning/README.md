# AI Bookworm scanning service

Private, authenticated malware scanning over ClamAV's `clamd` TCP `INSTREAM`
protocol. File bytes remain in memory: the service does not write uploads to a
filesystem and does not execute a shell or scanner subprocess.

## Configuration

The clamd destination is fixed by environment configuration and is never read
from a request:

- `SCANNING_SERVICE_TOKEN` (32-512 characters), or `SCANNING_SERVICE_TOKEN_FILE`
  pointing to a readable secret file; configuring both refuses startup. A single
  trailing newline is accepted in the file. Secrets are never returned by HTTP.
- `CLAMD_HOST` (default `clamd`)
- `CLAMD_PORT` (default `3310`)
- `CLAMD_CONNECT_TIMEOUT_SECONDS` (default `2`)
- `CLAMD_READ_TIMEOUT_SECONDS` (default `15`)
- `SCANNING_MAX_FILE_BYTES` (default 25 MiB, hard maximum 100 MiB)
- `SCANNING_MAX_CONCURRENCY` (default `4`, hard maximum `32`)
- `SCANNING_CHUNK_BYTES` (default 64 KiB)
- `SCANNING_MAX_DATABASE_AGE_HOURS` (default 72, bounded 1-168; cannot disable)

Run the **clamd daemon with `TZ=UTC`**. Its VERSION timestamp is timezone-free
ctime; Bookworm interprets it as UTC and rejects invalid dates, timestamps more
than five minutes in the future, and databases older than the configured limit.
Freshness is checked on readiness and before sending each file to INSTREAM.
Successful engine metadata includes `databaseDate` in UTC. Stale readiness/scan
returns 503 with `scanner_database_stale`, never a clean verdict; liveness stays
available. Alert on this code and repair FreshClam updates/engine reload, not by
disabling the gate. This age policy is Bookworm's operator-configurable policy,
not a ClamAV certification of coverage or a guarantee that every signature set
is up to date. Keep daemon/scanner clocks synchronized.

The native acceptance image runs FreshClam during image preparation to update
its preloaded official databases. Preparation requires the official signature
distribution network; update failure fails the build. Runtime tests remain on
an internal Docker network. This one-shot CI update is not a production updater:
production needs persistent databases, supervised updates/reloads and alerts.

Set clamd's `StreamMaxLength` to at least `SCANNING_MAX_FILE_BYTES`. Restrict
clamd TCP access to the scanner service network; clamd has no authentication.
Run the application container with a read-only root filesystem and no added
Linux capabilities.

## HTTP contract

`GET /health` is a process liveness check. `GET /ready` verifies clamd `PING`
and `VERSION`; it returns 503 when no trustworthy engine is reachable.

`POST /v1/scan` requires `Authorization: Bearer <SCANNING_SERVICE_TOKEN>` and
supports either:

1. `Content-Type: application/octet-stream`, with `X-Content-Sha256` and
   `X-Content-Mime` headers; or
2. `Content-Type: application/json` containing strict `contentBase64`,
   `sha256`, and `mimeType` fields.

Successful responses have a `clean` or `infected` verdict, the verified hash,
declared MIME type, byte size, signature (when infected), and ClamAV engine/
database versions. Hash mismatches and invalid envelopes are rejected before
scanning. Scanner timeouts, outages, malformed replies, and clamd errors return
503 and therefore cannot be interpreted as clean.

Run locally with:

```sh
uvicorn scanning_service.main:app --host 127.0.0.1 --port 8004
```

## Native container acceptance

`.github/workflows/scanner-runtime.yml` builds this service and a **test-only**
ClamAV image from `ops/scanner-test`. The engine uses the official preloaded
signature databases plus an exact-byte signature for a harmless binary fixture.
The fixture is not malware; the test proves the real INSTREAM detection path,
not protection against all malware or freshness of production signatures.

Run `python3 scripts/test-scanner-containers.py` after building images named
`bookworm-ci-scanner` and `bookworm-ci-clamd` from those two contexts. The script
uses an internal Docker network with no published ports or host data mounts,
checks clean/infected verdicts and integrity/size/auth rejection, stops the engine
to prove readiness/scan fail closed, then restarts it and checks recovery. It
removes only its own temporary containers, anonymous volumes and network.
The engine has a 4 GiB limit; the service has a 256 MiB limit for small fixtures.

Do not deploy the test image/signature. Production requires approved image
digests, current official database updates, refresh/reload monitoring and
capacity testing. CI runs FreshClam during image preparation and checks the
loaded database age; it does not prove production periodic updates.
See `docs/SCANNER_RUNTIME.md` for the separate persistent-volume runtime template.
References: [official container guidance](https://docs.clamav.net/manual/Installing/Docker.html),
[hash signature format](https://docs.clamav.net/manual/Signatures/HashSignatures.html),
[signature update management](https://docs.clamav.net/manual/Usage/SignatureManagement.html).
