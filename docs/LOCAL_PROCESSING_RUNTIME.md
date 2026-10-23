# Private local processing runtime

The web app needs authenticated processing services, not only Next.js and the
API. The local launcher runs the existing document, rendering, publishing and
scanning Python applications on **127.0.0.1 only**. It does not start workers,
ClamAV, Redis, OpenAI generation, payments or retailer submission.

## Configure and start

Install the four services' pinned Python requirements into the repository's
`.venv`. Use the matching `services/<role>/requirements.txt` files. The launcher
uses `.venv/Scripts/python.exe` on Windows and `.venv/bin/python` elsewhere;
an explicit `BOOKWORM_PYTHON` must be an absolute executable path.

Create an ignored `.env.processing.local` using
[the configuration template](../ops/local-processing.env.example). Set four
different cryptographically random tokens, at least 32 characters each. The
launcher accepts 32–512 ASCII letters, digits, `.`, `_`, `~` or `-`; the template
placeholders deliberately fail validation. Generate secrets locally or in a
secret manager, never in chat. Do not add `NEXT_PUBLIC_` variants.

Start a real, fresh ClamAV engine separately on `127.0.0.1:3310` (or the explicit
`CLAMD_PORT`). Configure signature updates and supervise that process. The
scanner retains its default 72-hour freshness limit and fails closed when the
engine is missing, stale or unable to return a trustworthy verdict. Do not use
the CI-only test signature database as a real upload scanner.

```powershell
npm run services:local -- --list
npm run services:local -- --config .env.processing.local --check
npm run services:local -- --config .env.processing.local
```

`--check` validates configuration and local entrypoints; it does **not** prove
service availability or dependencies. Startup also checks the four ports and
waits for real HTTP health, including scanner `/ready` and ClamAV metadata.
After startup, a process exit or failed health observation stops the owned
HTTP fleet. There is no hidden respawn. Ctrl+C or `stop` on the launcher's
standard input stops its children. Windows shutdown includes the virtualenv
redirector's actual Python child, not just the wrapper PID.

The launcher passes only an OS-environment allowlist and each service's own
token. It never forwards Supabase credentials, OpenAI keys, Stripe keys,
`SERVICE_AUTH_TOKEN`, arbitrary Python paths or Node preload options. Parser
stderr is not echoed because it can contain document content; generic lifecycle
errors stay visible. For detailed diagnosis, use an explicitly scoped private
service session without sharing its logs.

Configure the API with the same private service URLs/tokens in its server-side
environment. The document worker needs its corresponding server configuration
too. Starting the HTTP fleet does not consume jobs. Inspect pending work and
deliberately supervise the required nonpaid worker separately. Never start all
provider workers as a shortcut, grant credits for testing, or weaken paid gates.

The local Redis-compatible endpoint is also separate. Configure authenticated
`REDIS_URL` only in the API's server environment. An authenticated PING is a
readiness check, not proof of full Redis compatibility or queue recovery;
Bookworm's durable document and publishing jobs are in PostgreSQL.

## Observed local acceptance — 2026-10-23

The operator's existing Google-authenticated browser and real Supabase project
were used with clearly labeled synthetic material, not a disposable database
or mocked HTTP services. Application source was `09ba22b`; the reviewed local
launcher is a separate source change. Retain the private operator receipt in
the ignored tracking directory; do not commit signed URLs or account pixels.

- API `/ready` returned 200 with Supabase and authenticated Redis checks true.
  Unauthenticated and incorrect-password Redis probes failed.
- Official ClamAV 1.5.4, database 28162 dated 2026-10-23, accepted a clean
  synthetic manuscript and detected the standard EICAR test string in memory.
  Incorrect service authentication and a mismatched checksum were rejected.
  No antivirus test file was uploaded to Storage.
- All three processing APIs rejected an incorrect token and accepted their own
  token through input validation. The document service parsed synthetic text.
- A real browser upload of `harbor-synthetic-import.txt` passed integrity and
  malware screening and appeared as a private `source_document` in the library.
- The first background import exposed a real TXT-decoder defect: a valid UTF-8
  em dash was guessed as Windows-1252 and became mojibake. That labeled synthetic
  proof remains unchanged; no existing manuscript was silently rewritten.
- The TXT parser now tries strict UTF-8 before statistical legacy detection,
  rejects malformed explicit UTF-8 BOMs, preserves opening prose before a later
  chapter heading, and rejects NUL bytes beyond the old four-kibibyte prefix.
  Seventeen new fidelity cases cover punctuation, accents, emoji, non-Latin text,
  opening chapters, legacy decoding and empty/binary inputs. Document tests: 88.
- A fresh synthetic Unicode/opening-pages import completed through the real
  document worker with three chapters and no parser warnings. A direct request
  to the restarted service also preserved every original nonblank source line.
  Both one-shot worker runs first verified that only the intended synthetic job
  was claimable; no provider keys or paid consumers were started.
- A saved EPUB and 16-point large-print PDF rendered through the authenticated
  services, were privately stored in Supabase and downloaded in Chrome. Both
  Universal export preflights reported zero errors and warnings.
- The actual EPUB was 3,257 bytes, SHA-256
  `50d155c12c732f098fc6a1af7dd4dd0bb23eee85d61db907f308b6d8435cdb65`.
  Its first ZIP entry was the uncompressed EPUB mimetype; the saved manuscript,
  title/copyright pages and imprint were present. The saved EPUB reader opened.
- The actual PDF was 44,104 bytes, SHA-256
  `5df991f443023dcc1d7dddf74bea3af48d51d628dadbbd900f62b7c40de701ea`.
  Its four pages were 432×648 points (6×9 inches), with 16-point manuscript
  text, embedded fonts for all text runs, preserved Unicode and chapter contents.

The inline PDF viewer appeared blank in this Chrome profile. The downloaded
PDF passed structural/text checks; visual inline-browser proof still needs
diagnosis. Do not describe that blank frame as successful visual acceptance.
No retailer ingestion, funded AI, hosted processing, full disaster recovery or
commercial readiness is established by these local checks.

The local launcher has ten passing tests, including an actual Windows virtualenv
shutdown check. Three labeled synthetic books are retained for review and count
toward the current three-book default allowance; do not raise limits or delete
them behind the operator's back to make another acceptance run possible.

Official native Windows ClamAV, Microsoft Garnet and a private .NET runtime
were downloaded outside tracked source with vendor-published digests verified.
They are local operator dependencies, not bundled product assets or a selected
production hosting architecture. See [scanner operations](SCANNER_RUNTIME.md),
[container operations](PROCESSING_CONTAINERS.md),
[local development](LOCAL_DEVELOPMENT_SETUP.md), and the
[release checklist](release-checklist.md) for the remaining boundaries.
