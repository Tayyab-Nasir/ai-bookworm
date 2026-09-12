# AI Bookworm scanning service

Private, authenticated malware scanning over ClamAV's `clamd` TCP `INSTREAM`
protocol. File bytes remain in memory: the service does not write uploads to a
filesystem and does not execute a shell or scanner subprocess.

## Configuration

The clamd destination is fixed by environment configuration and is never read
from a request:

- `SCANNING_SERVICE_TOKEN` (required, 32-512 characters)
- `CLAMD_HOST` (default `clamd`)
- `CLAMD_PORT` (default `3310`)
- `CLAMD_CONNECT_TIMEOUT_SECONDS` (default `2`)
- `CLAMD_READ_TIMEOUT_SECONDS` (default `15`)
- `SCANNING_MAX_FILE_BYTES` (default 25 MiB, hard maximum 100 MiB)
- `SCANNING_MAX_CONCURRENCY` (default `4`, hard maximum `32`)
- `SCANNING_CHUNK_BYTES` (default 64 KiB)

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
