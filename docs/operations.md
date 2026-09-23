# Operations Runbook — AI Bookworm (Step 14)

## Health & readiness
- `GET /health` — liveness, no dependencies. Orchestrator restart probe.
- `GET /ready` — checks Supabase (`profiles` select) and only opens a TCP
  connection to the configured Redis host. It does not authenticate or issue
  Redis `PING`, and does not cover Qdrant/Storage/provider services; expand this
  before treating it as a production traffic gate.

## Graceful shutdown
- API: SIGTERM/SIGINT → `fastify.close()` drains in-flight requests;
  force-exit after 10s (`SHUTDOWN_TIMEOUT_MS` in `services/api/src/index.ts`).
- The publishing worker handles SIGTERM/SIGINT, stops claiming work, lets the
  active operation finish, and exits. Run all actions with
  `npm run worker:publishing`; use `-- --actions=render,validate` or
  `-- --actions=export_package` to split worker pools.
- Text AI review uses `npm run worker:ai` (or `npm run worker:ai -- --once`).
  The author request creates a durable job containing canonical chapter versions,
  context policy and a private instruction; the service-role worker claims it
  with a renewable fence, rehydrates source context server-side, calls the
  provider and completes credits/suggestions atomically. It has five bounded
  attempts, exponential backoff and a database DLQ. The legacy Python AI worker
  is not deployable. Reviewed metadata generation remains synchronous.
  `GET /v1/ai/jobs?bookId=...` returns private/no-store summaries and never
  exposes raw drafting instructions, idempotency keys, provider input or
  retrieved passage text.

## Upload quarantine and malware scanning
- User uploads are created as `pending`. The API verifies the stored byte count,
  recomputes SHA-256, sniffs the allowed content type, and sends the exact bytes
  to the private scanning service. Only a `clean` verdict promotes the version
  to the active asset. `infected` is terminal; scanner/integrity errors remain
  quarantined and may be retried with the same confirmation endpoint.
- Pending, infected, and error versions are not readable through the authenticated
  Storage policy and are rejected by manuscript import, referenced-asset
  assembly, preflight, render, package, and API download paths. The API service
  role performs the pending-object read only after workspace editor authorization.
- The scanner uses authenticated `POST /v1/scan` and clamd's bounded `INSTREAM`
  protocol. It writes no uploaded file to disk and executes no shell process.
  `/health` is process liveness; scanner `/ready` probes clamd `PING` and version.
- Keep the scanning service private. Give it a dedicated 32-512 character token,
  restrict egress to clamd, update signatures continuously, and configure clamd
  `StreamMaxLength` at least as large as `SCANNING_MAX_FILE_BYTES`. The API and
  scanner limits must agree (maximum 100 MiB) or uploads fail closed.
- Before staging traffic, exercise a clean fixture, EICAR detection, scanner
  timeout/outage recovery, and direct Storage reads for pending/infected objects.
  Alert on repeated `scanner_unavailable`, scan errors, and signature-update age.

## Dead-letter queue
- Publishing jobs use PostgreSQL leases and database-owned attempt limits.
  `fail_leased_publishing_job` schedules bounded exponential retry and writes
  terminal failures to `public.dead_letter_jobs` without manuscript text.
- Operators may retry a terminal publishing job from `/admin`; the database
  resets its schedule and records the action in `audit_logs` atomically.
- `workers/ops.py` and its JSONL dead-letter helper are legacy test seams, not
  the active publishing transport.

## Log scrubbing (MASTER-BUILD-SPEC 17)
- Never log manuscript text, tokens, secrets, signed URLs.
- `services/api/src/lib/redact.ts` scrubs keys (text/content/manuscript/
  body/token/secret/authorization/signed urls…) and strings matching signed-
  URL signatures; applied to request logging in `app.ts`.

## Proposed backups (not yet enabled)
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

## Proposed DR drill (not yet executed)
1. Snapshot config: env var matrix below + Stripe webhook secrets.
2. Restore latest backup to a fresh Supabase project (above).
3. Point API/workers at the restore (env swap), verify `/ready` = 200.
4. Smoke: signup, create book, run one AI job, one render.
5. Fail back, record RTO/RPO achieved vs target.

## Scaling notes
- The API is not fully stateless yet: request idempotency and community rate
  limiting include process-local maps. Replace them with a shared store before
  horizontal replicas are expected to behave identically.
- Scale publishing worker pools by queued rows whose `available_at` has passed.
  Claims use `FOR UPDATE SKIP LOCKED`, so multiple workers can safely compete;
  keep service/provider concurrency limits below upstream quotas.
- A lease heartbeat fences stale workers. Alert on expired-lease reclaims,
  repeated retries, and any dead-letter insertion.
- DLQ growth > 0 should page ops; it means a poison message or an outage.

## Environment variable matrix
| Var | Used by | Required | Notes |
|---|---|---|---|
| SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY | api | yes | service key only on server |
| REDIS_URL | api (/ready) | current config | Readiness compatibility only; the publishing queue is PostgreSQL-backed. |
| QDRANT_URL / QDRANT_API_KEY | optional retrieval experiments | no | The author-facing book search uses PostgreSQL full-text retrieval. |
| OPENAI_API_KEY / DEFAULT_AI_PROVIDER / DEFAULT_AI_MODEL | AI text and translation | yes | Keep the key server-only. Production defaults to OpenAI and fails closed without a key. |
| STORY_BLUEPRINT_PRICING_CATALOG_JSON | Paid Story Blueprint proposal quote catalog | no | Server-only approved model/rate/policy snapshot. Blank or invalid disables the paid Blueprint proposal UI; do not use `NEXT_PUBLIC_*`. |
| OPENAI_TRANSLATION_MODEL | translation worker | no | Defaults to `DEFAULT_AI_MODEL`, then `gpt-6-astra`; never expose it or the API key to the browser. |
| OPENAI_IMAGE_MODEL | API image generation | no | Defaults to `gpt-image-2.5-sunburst`. |
| OPENAI_TTS_MODEL | audiobook speech generation | no | Defaults to `gpt-4o-mini-tts`; the audiobook worker remains a release gap. |
| AI_SERVICE_URL / AI_SERVICE_TOKEN | api -> ai | prod | Private service URL and shared server-only token. |
| RENDERING_SERVICE_URL / RENDERING_SERVICE_TOKEN | api -> rendering | prod | Private renderer URL and dedicated shared token; falls back to `SERVICE_AUTH_TOKEN`. |
| PUBLISHING_SERVICE_URL / PUBLISHING_SERVICE_TOKEN | api -> publishing | prod | Private export packager URL and dedicated shared token; falls back to `SERVICE_AUTH_TOKEN`. Package history remains in Postgres/private Storage. |
| SCANNING_SERVICE_URL / SCANNING_SERVICE_TOKEN / SCANNING_SERVICE_TIMEOUT_MS | api -> scanner | prod uploads | Private scanner origin, dedicated shared token, and bounded request timeout. No fallback token. |
| CLAMD_HOST / CLAMD_PORT | scanner -> clamd | prod uploads | Fixed deployment configuration; never supplied by a request. |
| SCANNING_MAX_FILE_BYTES / SCANNING_MAX_CONCURRENCY / SCANNING_CHUNK_BYTES | scanner | prod uploads | Must remain within service validation and clamd stream limits. |
| STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PRICE_IDS_JSON | billing | prod | |
| SERVICE_AUTH_TOKEN | api internal routes | prod | credits/referrals qualify |
| ADMIN_USER_IDS | api admin routes | ops | comma-separated user ids |
| APP_URL | web auth + api browser links | prod | Canonical browser origin; required in production and enforced for Stripe return URLs and workspace invitation links. |
| API_PORT / WEB_PORT / AI_SERVICE_PORT / RENDERING_SERVICE_PORT / PUBLISHING_SERVICE_PORT / SCANNING_SERVICE_PORT | services | no | defaults 3001/3000/8000/8002/8003/8004 |
| SENTRY_DSN / OTEL_EXPORTER_OTLP_ENDPOINT | future observability | no | Config is parsed/documented; SDK/export wiring is not implemented. |
| LOG_LEVEL / NODE_ENV | api | no | |
Publishing worker pool selection is a command-line setting, not an environment
variable: `--actions=render,validate,export_package`. Lease duration and poll
interval currently use conservative code defaults; make them explicit settings
before production tuning.

## Paid Story Blueprint proposal workers

- Run at least one separately supervised `npm run worker:story-blueprint -- --prepare-quotes`
  process to count exact frozen quote inputs. Run
  `npm run worker:story-blueprint -- --quoted` for proposals that customers
  explicitly accepted and funded. These are separate queue modes; never start
  proposal generation from quote preparation.
- Both modes require server-only Supabase service credentials and the private
  AI service URL/token. Configure an approved, dated
  `STORY_BLUEPRINT_PRICING_CATALOG_JSON`; an empty or invalid catalog disables
  quote models. Do not place this catalog or OpenAI credentials in browser
  environment variables.
- Quote counting leases have bounded retries. If a count may have reached
  OpenAI and the worker loses the result, the request becomes
  `counting_outcome_unknown`; it is not automatically recounted. The author must
  explicitly prepare another quote. This request never reserves credits.
- After explicit credit confirmation, the generation worker performs a
  hash-bound provider call, saves a private measured receipt and candidate,
  then settles the hold. Unknown dispatch outcomes retain the full hold for
  financial review and cannot be redispatched automatically. Only settled
  completed candidates are visible; applying one requires a separate revision
  check and author action.
- The migration and local PostgreSQL tests do not configure or supervise these
  production processes. Confirm queue age, failed quote counts, held credits,
  and `requires_review` outcomes in deployment monitoring before enabling the
  commercial workflow.

## Admin console
- The web console is available at `/admin`; both the page and `/v1/admin/*`
  require membership in `ADMIN_USER_IDS`.
- Feature-flag updates and publishing-job retries use database transactions
  that include the audit record. Other admin mutations still use best-effort
  audit writes and are not yet compliance-grade controls.
- Feature flags: `feature_flags` keyed by (key, scope_type, scope_id);
  toggle via `PUT /v1/admin/flags/:key`.

## Book retrieval
- `/v1/books/:bookId/search` searches only current manuscript versions and
  current Book Bible entries visible to the authenticated book member.
- Results are verbatim excerpts with source/version/hash citations. The search
  endpoint does not synthesize an answer. Writer and consistency jobs may use
  the same bounded evidence as untrusted context.
- Operational and phase-two LightRAG criteria are recorded in
  `docs/BOOK_RETRIEVAL_DECISION.md`.

## Document import service boundary

- Configure the same private `DOCUMENT_SERVICE_TOKEN` on the API, document
  worker (if used), and document service; `SERVICE_AUTH_TOKEN` is a fallback.
  `/parse` rejects calls without a matching token. Missing service credentials
  fail closed with 503; the API preserves the uploaded original for retry.
- The normal manuscript flow verifies and scans the private upload, downloads
  it through the API's scoped Storage client, and sends `contentBase64` to the
  private `DOCUMENT_SERVICE_URL`. The browser never sees a service credential.
- Legacy worker path imports are disabled unless `DOCUMENT_IMPORT_ROOT` is set
  on the document host. Only relative paths resolved inside that folder are
  accepted; absolute paths, traversal and symlink escapes are rejected. Do not
  configure a home directory, repository root or secrets directory as this root.
- Author setup now queues imports in PostgreSQL through `manuscript_import_jobs`.
  Run `npm run worker:document` as a separately supervised process, or add
  `-- --once` for one claim. The worker uses 30–900 second renewable leases,
  row locking/skip-locked claims, at most five attempts, exponential retry,
  terminal DLQ records and stable non-secret error codes. Browser/API tokens and
  manuscript contents are never stored in the job row.
- Queue creation revalidates editor membership plus the source workspace,
  extension, 20 MiB size, checksum and current clean scan. One book/source pair
  has one job; a prior receipt makes it immediately succeeded. Completion calls
  the same atomic chapter/image/receipt transaction under the lease. A lost
  completion response is resolved through authoritative job state; stale workers
  cannot complete or fail another lease.
- Members can read up to 50 safe job statuses; checksum and lease fields have no
  authenticated SELECT grant and are excluded from API responses. Only editors
  can queue/retry. Manual retry requires a failed job plus the unchanged clean
  original and writes an audit event. The setup page polls every five seconds,
  survives reload/tab closure, explains queued/running/failed states and restores
  the durable report on success.
- Platform administrators can select Manuscript imports in `/admin`. The list is
  independently allowlisted and the aggregate health call reports ready/running,
  expired-lease and dead-letter counts plus oldest active timestamps. It never
  returns source checksums, lease tokens, manuscripts or provider payloads.
- The platform-admin AI-job list is also operational-only. It returns identity,
  state, attempts, bounded errors, model and usage, never stored prompts,
  idempotency keys, provider input or output references.
  Worker retries are automatic; platform-admin manual retry remains deliberately
  unavailable. Alerting and process supervision still need deployment-specific
  configuration.
- The legacy synchronous import endpoint remains for backward compatibility and
  trusted internal callers, but the author setup uses the durable queue. The old
  Python `workers/document/worker.py` is only an unwired parser-adapter seam;
  production operations must use the TypeScript `worker:document` command.
- Required production controls remain: deploy/supervise at least one worker,
  measure queue depth/oldest age/retry/DLQ alerts, test crash/reclaim with native
  multi-connection PostgreSQL, and prove Storage/ClamAV/document-service behavior.
  Unknown Storage PUT outcomes can still leave private orphans; use the safe
  reference-proving reconciliation process below, never deletion by age alone.

## Private Storage reconciliation

- Image credit reservation migration `20260912110000_image_credit_reservations.sql`
  must accompany the API change. Pending queued/running image jobs reserve one
  organization-wide credit before provider execution, including across workspaces.
  Success transfers the slot to recorded monthly usage; a failed job releases it.
  Unresolved jobs retain capacity indefinitely. Do not manually fail or delete a
  job merely to free credits: first reconcile provider outcome, stored bytes and
  completion receipt. Finalize preserved images instead of regenerating them.
  This is not provider-side billing idempotency: ambiguous provider failures can
  still incur external cost. Native concurrent acceptance remains required.
- Image completion receipts are protected references, including while an image
  job is awaiting finalization. The inventory reads these receipts in pages
  and stops if they are unavailable or malformed; it never treats missing
  receipt-query evidence as permission to classify images as orphan candidates.
  Apply the image receipt migration before using the updated inventory.

- `npm run storage:orphan-report -- --grace-hours=168` is a service-role,
  read-only inventory of `book-assets/workspaces`. It joins both current asset
  rows and immutable asset-version paths before classifying objects.
- Only expected workspace/asset/version paths that have no database reference
  and are older than the supplied 24–8,760 hour grace window become candidates.
  Referenced, younger, malformed/out-of-scope, or timestamp-unverifiable
  objects remain non-reclaimable. The command emits aggregate counts only;
  object paths can include private filenames.
- This command has no deletion capability. Before any later cleanup procedure,
  run it against authorized native Storage, retain its operator-controlled
  evidence, independently recheck every candidate immediately before deletion,
  document a rollback/restore plan, and require explicit deletion approval.

## Embedded manuscript images

- DOCX/EPUB body raster images are returned only in a separate private parser
  payload. Supported formats are PNG/JPEG/GIF/WebP, capped at 100 unique images,
  10 MiB per image and 40 MiB aggregate. The API bounds the complete JSON response
  to 80 MiB. External image URLs are not fetched; unsupported placements receive
  explicit warnings/placeholders. Originals remain available.
- The API independently checks canonical base64, byte size, SHA-256 and sniffed
  type, scans every image before uploading any, writes fresh private object
  paths, and verifies storage readback. Manuscript nodes receive new asset IDs;
  embedded bytes and signed URLs are not persisted in canonical book content.
- Migration `20260909090000_manuscript_image_import.sql` adds book/source import
  receipts. Additive migration `20260909150000_manuscript_import_receipts.sql`
  generalizes the service-only transaction to `complete_manuscript_import`;
  the former image function remains a compatibility wrapper. It validates
  editor membership and the clean source, finalizes pending image versions with
  scanner evidence, and atomically stores assets, chapters, links and the receipt.
  All new imports, including text-only manuscripts, persist a receipt atomically.
  Replays return the original result without duplicate chapters. Both migrations
  have only been tested in disposable PostgreSQL, not a native/live database.
- Definite precommit failures remove only confirmed new uploads. Unknown commit
  outcomes retain potentially referenced files; unconfirmed storage writes can
  also leave private orphans. Do not delete these by age alone. A reconciliation
  process must prove objects are unreferenced after an appropriate grace period.
- Author import uses the durable document worker; the compatibility endpoint can
  still execute synchronously for trusted internal callers. Native concurrent
  lease/storage/ClamAV tests are required before production.
- Renderer acceptance checks verify JPEG/GIF/WebP bytes become actual PNG files
  before EPUB packaging. This does not prove full visual fidelity or native
  storage integration. Complex table/header/footer drawings and SVG/vector
  images remain unsupported.

## Author import recovery

- Book setup checkpoints a successfully created book before uploading and a
  successfully uploaded source before scanning. Retry reuses those identifiers,
  rather than creating a duplicate book or uploading another confirmed original.
- Recovery metadata is scoped to the verified user and workspace in browser
  sessionStorage and accepted for 24 hours in the same tab. Only IDs, checksum,
  size, mode/completion state and timestamp are stored; no manuscript text,
  filename, signed upload URL, credentials or parser warnings are copied there.
  Reload checks the book through the authorized API before restoring its form.
- Confirmation conflicts are not assumed successful: the original version must
  have the exact saved checksum and a clean scan. A newer asset version blocks
  automatic recovery, rather than silently importing replacement content.
  Legacy text-only import conflicts require an authenticated manuscript-source
  link to the exact book before showing an already-imported result.
- Import results display chapter/image counts and literal parser warnings before
  the author opens the editor. Restoring a completed setup does not rerun it;
  it loads the durable report through the authorized read-only endpoint. An
  interrupted checkpoint is also recognized as complete when a receipt exists.
  Legacy imports without receipts show an explicit unavailable-report message;
  transient receipt failures preserve the book and offer reload/editor access.
- `GET /v1/books/:bookId/imports/:assetId` returns a member-authorized historical
  import result or null, with private/no-store caching and allowlisted fields.
  It does not call the parser, scanner or storage, nor approve a current asset
  version. POST replay still checks editor access and the current clean source
  checksum before returning a receipt, ahead of parser configuration/download.
- Parser reports are validated before side effects: up to 100 warnings of 2,000
  characters each and a 65,536-byte serialized report cap. Returned counts are
  derived from persisted chapter/image arrays. Report text is not stored in
  browser recovery metadata.
- Known limits: tab closure, expiration or blocked browser storage can remove
  recovery context. Lost create-book replies have no durable client receipt;
  authors must check the library before creating again. Unconfirmed PUT replies
  can leave pending assets and retry may allocate another upload. This is not a
  durable worker, cross-device recovery or general orphan cleanup mechanism.
- Browser acceptance uses the isolated auth fixture and synthetic
  `tests/e2e/fixtures/import-recovery.txt`, never a real author's manuscript.
  One lost scan reply and one parser outage, including a reload, result in one
  book and one source upload. Native service acceptance remains separate.

## Manuscript formatting and artwork

- The editor stores canonical text plus allowlisted inline formatting. Accepted
  text operations, splits and merges preserve valid runs; stale formatting may
  not override current text. Nested list content is retained through save/reload.
- Insert illustrations from the current workspace, set alt text or explicitly
  mark decorative artwork, add a caption and choose text-relative width. Private
  preview URLs are short-lived and are not persisted in manuscript nodes. Save
  the chapter to persist these edits; removing a placement does not delete its
  source asset.
- Artwork may instead use a dedicated full-bleed print page. Horizontal and
  vertical focus control deterministic cover-cropping; the ebook remains
  inline. Enable the edition's printer-specific bleed first. Core preflight
  requires enough width and height for the entire physical page at 300 DPI and
  returns a located error before invalid output. Full-bleed pages omit the page
  number. Inspect every crop and safe area, then order a physical proof; these
  checks do not validate artistic focus, contrast or binding loss.
- EPUB/PDF renderer versions are `epub-1.4.0` / `pdf-1.9.0`. They preserve inline
  emphasis, breaks, nested lists and illustration captions; PDF gutters mirror
  correctly on odd/even pages. EPUB writes the saved edition's BCP-47 language and
  resolved `dir` attribute (`ltr`/`rtl`), letting reading systems apply local
  script-capable fonts and bidirectional layout. Render, preflight, and package
  requests all rebuild the model with that saved edition language, so their
  freshness fingerprints remain consistent. Core rules are `core-1.0.6`.
- Numbering reserves the complete 9pt font box at least 0.5in inside trim,
  with at least 6pt of clearance from the body. Outer numbers align against
  mirrored outer margins. Keep a 0.75in top margin for top numbers or bottom
  margin for bottom numbers; preflight reports the exact font-dependent
  minimum when space is insufficient. Authors may move or disable numbering
  to retain tight body margins. Empty body areas and horizontally overflowing
  page labels are rejected before an invalid PDF is returned. Re-render old
  interiors to receive corrected numbering placement.
- Print `bleed_edges` is explicit: `outer` adds bleed to top, bottom and the
  outer side (KDP); `all` adds it to all four sides (Lulu). Existing saved
  editions default to `all` for compatibility, so select `outer` and re-render
  before sending a bleeding interior to KDP. A 6x9 trim at 0.125in bleed is
  6.125x9.25 for KDP and 6.25x9.25 for Lulu. Sources checked 2026-09-18:
  [KDP](https://kdp.amazon.com/en_US/help/topic/GVBQ3CMEQW3W2VL6),
  [Lulu](https://help.lulu.com/en/support/solutions/articles/64000255584).
  Margins remain trim-relative; odd/even frames alternate on every page,
  including pages after the second. Numbering is anchored to the trim area.
  KDP `1.4.0`, B&N `1.2.0`, and Lulu `1.3.0` inspect actual artifact geometry
  and page count rather than trusting saved settings. KDP uses the selected
  ink/paper profile and trim-specific current page range, rounds an odd count
  the same way KDP does, and applies the page-count gutter tier. Covers use
  that even manufacturing count automatically, with an informational preflight
  message for odd interiors. Do not add a blank page solely to work around
  older Bookworm odd-page errors; re-render using the current cover version.
  B&N applies the
  supported 18-800 page range and its 0.75in inside/0.5in other margin guide.
  Lulu's current perfect-bound paperback range is 32-800; its 0.5in safe-area
  and page-count gutter guidance are warnings because Lulu documents them as
  recommendations. Sources checked 2026-09-18:
  [KDP paperback guidelines](https://kdp.amazon.com/en_US/help/topic/G201857950),
  [B&N rejection limits](https://help-press.barnesandnoble.com/hc/en-us/articles/5359031189787-Cover-Interior-Not-Accepted),
  [B&N interior guide](https://www2.nookassets.com/npassets-spb/pod/resources/interior-file-preparation-quick-guide-v1.pdf), and
  [Lulu formatting limits](https://help.lulu.com/en/support/solutions/articles/64000255583).
  This still does not validate artistic crop safety, binding loss, every text
  boundary, or acceptance by a retailer's live upload service.
- Print body and heading fonts can use `BookwormVera` / `BookwormVera-Bold`.
  The renderer embeds ReportLab's bundled, unchanged Bitstream Vera TrueType
  family, including regular, bold, italic and bold-italic variants. Retain the
  installed `reportlab/fonts/bitstream-vera-license.txt` when packaging the
  rendering runtime; no operating-system or customer font files are loaded.
  Coverage is limited Latin, not universal Unicode or RTL shaping. Existing
  font choices remain compatible. When both body and heading use Vera, inline
  code uses the four vendored DejaVu Sans Mono faces and page numbers use Vera;
  incidental canvas/table fonts are also embedded. Keep the unmodified font
  files, license and checksum provenance in `services/rendering/fonts/`.
  Legacy Times/Helvetica/Courier choices remain unchanged and unembedded.
  Before rendering, glyph checks inspect the effective font for
  headings, marked text, lists, tables and captions; unsupported characters
  produce located `PRINT_GLYPH_UNSUPPORTED` errors instead of substituted boxes.
  `/preflight` returns these findings without attempting invalid output;
  `/render` rejects the same input with 422. The direct renderer also enforces
  this guard. Re-render older artifacts before relying on this coverage.
- Paperback editions can enable `wrap_cover`. The `paperback-cover-1.1.0`
  renderer produces one back/spine/front CMYK PDF with embedded back/spine
  fonts, a 300-DPI raster front and blank barcode reserve. `cover-1.3.0`
  checks visible front-overlay glyphs and fits measured text without clipping
  or discarding long tokens. Footer text and QR areas do not overlap. QR
  modules are integral pixels with a four-module quiet zone; too-small/dense
  requests fail instead of resampling. Contrast and physical scan proof are
  still author acceptance steps. White/cream/color KDP profiles derive
  spine width from the actual interior rounded up to KDP's even manufacturing
  count. Cover generation enforces the same stock/trim page limits as KDP
  preflight. Custom paperback templates require
  matching page count and spine width. Outer bleed is 0.125 inch.
  Geometry follows [KDP's paperback cover guidance](https://kdp.amazon.com/en_US/help/topic/G201953020),
  checked 2026-09-18. This is not retailer acceptance certification.
  Re-render after changing paper or manuscript. Preflight/package checks reject
  missing covers, wrong geometry, cropped bleed, rotation and multi-page covers;
  back/spine text must fit and use supported glyphs. Private render assets use
  `application/pdf` and `cover.pdf`, retained in the retailer ZIP and checksum
  manifest. Install the rendering requirements (including `pypdf`) in the
  publishing runtime, which shares the rendering rules. EPUB covers stay PNG.
  Review front text/QR, the chosen printer's template and a physical proof.
  Hardcover, arbitrary printer bleed, RTL shaping, complete interior print
  conformance and actual ISBN barcode issuance remain separate work.
- DOCX import preserves supported run marks, hyperlink labels without URLs,
  named list styles and table text in body order. EPUB walks nested content once,
  retains semantic marks and mixed lists, and excludes scripts/navigation.
  Table row/cell text reaches the canonical model, editor, EPUB and paginated
  PDF. The editor supports insertion, cell editing, row/column addition and
  preview; chapter save persists the grid and its synchronized canonical text.
  If a text operation makes the grid stale, display/export uses the latest text
  instead of silently showing old cells. Raw imported HTML is never persisted.
- This is not pixel-identical EPUB/print layout or full PDF accessibility
  certification. The deterministic base-font PDF and raster-cover renderer
  explicitly reject RTL text overlays and RTL print editions instead of producing
  unsafe output. The Publishing Studio resolves the same direction locally,
  explains the limitation before an invalid render, and leaves preflight
  available for the saved edition. A separately licensed, embedded shaping-capable font pipeline,
  tagged PDF, complex imported tables, full DOCX/EPUB format fidelity and
  complex/vector image placements still need work. Supported body raster import
  is described above.
- SnapOtter is an optional processor candidate, not installed or required.
  See `docs/SNAPOTTER_EVALUATION.md` for licensing, privacy and benchmark gates.

## Reviewed AI metadata
- `POST /v1/books/:bookId/metadata/generate` is an editor-only, synchronous
  private-AI operation over bounded current chapter versions, book identity,
  style rules and Book Bible evidence.
- A successful call stores the cited candidate, run telemetry and applicable
  credit event atomically on the AI job. It never changes `book_metadata`.
  Authors must choose **Use this draft**, review the fields, and then choose
  **Save metadata** as a separate canonical write.
- Retries reuse the same request key while a request is in flight. A failed
  job returns an explicit conflict requiring a new key; a succeeded replay is
  returned before a new quota check and is never charged again.
- Alert on repeated `ai_service_unavailable`, `invalid_ai_output`,
  `invalid_ai_citation`, or `ai_persistence_failed` job errors. Provider and
  native-service acceptance remain staging work; deterministic mocks do not
  prove live generation quality.

## Account support and data rights
- `/settings/data-rights` provides authenticated intake for support tickets and
  account-data export/deletion requests. The matching API routes scope reads and
  writes to the authenticated user, and deletion intake requires the exact
  `DELETE MY ACCOUNT` confirmation phrase.
- Intake is not fulfilment. Nothing is exported, emailed, or deleted
  automatically. Assign a privacy owner, approve retention/legal policy, build
  the fulfilment audit trail, and exercise it in authorized staging before
  enabling production requests.
- The browser acceptance journey covers successful intake and the 390px layout;
  database tests cover ownership, duplicate-open requests and cancellation.

## Retailer submission boundary
- The production-safe contract is export-first: generate a versioned preflighted
  private package, then let the author submit it through the retailer's supported
  workflow. No route claims direct KDP submission or retailer-side status.
- Do not map Amazon Selling Partner Catalog Items endpoints to KDP publishing.
  That API retrieves catalog data and is not a manuscript/cover submission API.
  Add direct integrations only after provider approval, documented scopes,
  sandbox fixtures and contract tests exist.

## Audiobook narration

- Audiobook editions pin a narrator voice, direction, speed, language, and the
  required AI-voice disclosure. Chapter jobs always pin the current
  `document_versions.id`; queue rows contain only character ranges and SHA-256
  hashes, never copied manuscript text.
- Start the durable worker with `npm run worker:audiobook`; add `-- --once` for
  one claim. It uses `OPENAI_TTS_MODEL` (default `gpt-4o-mini-tts`) and the
  server-only `OPENAI_API_KEY`. Each OpenAI request is at most 4,096 characters,
  uses no automatic SDK retry, and writes an MP3 to private `book-assets`
  storage before atomic asset/accounting completion.
- One `audio_credit` represents up to 1,000 source characters in a segment.
  The full chapter reservation is checked under the organization lock before
  any job is committed. No subscription or missing audio allowance means zero
  capacity. Failed terminal projects cancel remaining segments so reservations
  cannot remain stranded.
- A private completion receipt permits recovery after an uploaded result loses
  its database response. If audio exists without a valid receipt, the worker
  stops in an unknown state instead of paying for a duplicate provider call.
- Speech responses do not contain exact token usage. `ai_runs.estimated_cost`
  uses the documented model prices plus the labelled `word-rate-v1` duration
  estimate. Reconcile actual spend from OpenAI organization usage before margin
  reporting. Audio mastering, loudness/QC, opening/closing
  credits, retailer packaging, and live-provider acceptance remain separate
  release gates; segment MP3s are not claimed to be a retail-ready audiobook.
- Completed chapters support `GET /v1/audiobook-jobs/{projectId}/audio-download`.
  The caller's RLS client checks completion, sequential indexes and exact
  workspace/project paths, sizes and SHA-256 before transmitting saved audio
  to the authenticated rendering service's `/audio/assemble`. No new provider
  call or credit spend occurs. The assembled artifact is returned as a private,
  no-store attachment, not persisted as another asset; future downloads may
  assemble again. The UI handles failures and retains the original segments.
- `chapter-audio-1.0.0` decodes each MP3 to common PCM, joins in order and encodes
  once at 44.1 kHz mono/192 kbps. This does not normalize loudness or perform
  narration QC. Limits: 250 segments, 50 MiB each, 100 MiB total source, two-hour
  decoded duration, 150 MiB output, 120-second processing deadline. The output
  cap can be reached before two hours. Native assembly is serialized per
  renderer process; API admission is two operations per process, one per
  user/project. There is no distributed queue/cache for this download yet.
- The local source also exposes
  `POST /v1/editions/{editionId}/audiobook-google-play-export`. It is an
  author-triggered, synchronous download, not a retailer integration. Before
  assembly it requires every current chapter to have succeeded narration and
  an exact-audio QC sign-off, plus a private cover and publisher identifier.
  It reassembles each chapter to match the immutable QC hash, writes an
  uncompressed ZIP to a mode-0600 temporary file, and streams the result; the
  ZIP is removed when the response closes. Cap is 3,750 MiB and 250 chapters.
  A disconnect aborts the author download and causes temporary cleanup; retry
  may repeat CPU-only assembly but never provider generation or credit usage.
  This long synchronous work does not yet have durable job recovery and may
  exceed the BFF/serverless request window for large titles. Do not treat it as
  a production-scale export queue. Its required QC tables are in
  `20260923040940_audiobook_qc_review_signoffs.sql`, which remains unapplied
  live. Cover pixel bounds are checked; dpi metadata is not measured, so the
  author must verify the retailer's 72-dpi requirement. The download never
  marks the title as uploaded or published.
- Install rendering requirements, including pinned `imageio-ffmpeg==0.6.0`.
  Its Windows wheel supplies FFmpeg 7.1; `IMAGEIO_FFMPEG_EXE` may point to a
  reviewed operator-managed executable. No shell/network protocols or caller
  paths are accepted. Temporary files are cleaned on success/error; allow up
  to roughly 1.3 GB scratch space per operation. Enforce corresponding private
  service body/concurrency limits at the reverse proxy. Runtime security
  updates, production capacity, native Storage/provider audio and recovery
  acceptance remain required. Wrapper license is BSD-2-Clause; the bundled
  Windows executable reports GPLv3-or-later via `-L`. Retain appropriate notices
  and review binary redistribution obligations before distributing runtime
  images. No FFmpeg executable is committed to the application repository.

## Translation workflow

### Usage-priced web flow

The web translation screen now prepares and confirms saved quotes. Run these as
two separate supervised processes on a persistent worker host, not in Vercel
HTTP handlers:

```text
npm run worker:translation -- --prepare-quotes
npm run worker:translation -- --quoted
```

`--prepare-quotes` counts one pinned chapter per 120-second leased step and
checkpoints the count. When every chapter is counted, it atomically publishes a
proposal. It does not reserve credits or generate translated text. Counting
sends the saved manuscript to OpenAI only after the user's explicit consent.
An abandoned running count becomes `counting_outcome_unknown`; do not reset it
to queued automatically. A committed count survives an uncertain reply.

`--quoted` handles accepted, funded translation jobs. Separate acceptance holds
the full proposal amount atomically. One-time dispatch, durable provider receipts
and measured settlement protect recovery; unverified usage remains held. Do not
delete receipts, release holds or reset dispatch markers to unblock a worker.

Add `--once` to either command for a bounded operator diagnostic. This may call
OpenAI when work is queued: it is NOT a free health check. Never combine
`--prepare-quotes` and `--quoted`. The unflagged worker now defaults to
`--quoted`; it never consumes legacy operational jobs.

Both processes require server-injected `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` and `OPENAI_API_KEY`. The API requires the approved
`TRANSLATION_PRICING_CATALOG_JSON` described in `PRICING_AND_PLAN_RELEASE.md`.
Workers use the request's saved catalog/model snapshot; they do not replace it
with a default model or today's rates. A missing/expired catalog prevents new
quotes. No approved commercial config is seeded by this build.

Before enabling this flow live, review/apply migrations through
`20260919180000_retire_legacy_translation_queue.sql`, verify native database tests,
exercise synthetic browser acceptance, configure both workers and confirm
queue movement and receipt recovery. None of these commands deploys migrations.
Monitor request counts by status and oldest queued age; worker logs deliberately
omit manuscript text, API keys, token receipts and price configuration. A ready
quote can expire before acceptance; request a fresh quote rather than extending
its saved validity. An accepted proposal can be reread/replayed to recover the
same purchase without another debit.

### Retired operational queue

The pre-quote `queue_translation_project` RPC and HTTP endpoint are retired.
They cannot create new work, and `npm run worker:translation` never claims their
jobs. Do not invoke `runOneTranslationJob` through an ad-hoc script: it has no
usage-priced quote, provider cost ceiling or funded hold. If a pre-retirement
project exists, freeze it, reconcile entitlement/payment and provider state,
then create a fresh quote or issue a documented customer remedy. Never start it
to "clear" a queue or infer whether a provider call happened.

Before applying the retirement migration to a live environment, stop every
legacy translation consumer and wait through the maximum existing 900-second
lease (or reconcile each live lease). Then apply the migration, verify no new
legacy claim can occur, and start only the `--prepare-quotes` and `--quoted`
workers. Existing running jobs keep renewal/completion/failure permission so
operators can settle their known outcome; never revoke those paths mid-lease.

# Fixed-layout EPUB worker dependency

## Metadata generation concurrency migration

Production AI workers also require migration
`20260919040000_metadata_service_receipts.sql`, `SUPABASE_URL`, server-only
`SUPABASE_SERVICE_ROLE_KEY`, and a nonempty `AI_SERVICE_TOKEN`. Metadata generation
fails before provider execution if receipt reservation cannot be confirmed.
Real providers always use durable receipts; `AI_RESULT_STORE=supabase` enables
the same path for the deterministic mock. Do not expose credentials to browsers.
Receipts contain private generated content, not raw input prompts; they cascade
with AI-job deletion and are unavailable to anon/authenticated database roles.
Include them in protected backups and data-retention review. Never clear an
unresolved reservation merely because it is old: the provider may have completed.
These migrations are local build artifacts until explicitly deployed/verified.

Apply `20260919030000_metadata_single_active_request.sql` through the reviewed
migration workflow before relying on cross-tab metadata request protection.
It creates a partial unique index for active metadata jobs per author/book.
If existing duplicates prevent creation, inspect their provider receipts and
completion state first. Do not cancel by age, delete job records, or silently
mark them failed to make the migration pass. This local checkpoint does not
apply the migration to Supabase. API conflicts stop before provider execution.

## Fixed-layout conversion

Fixed-layout EPUB uses saved `fixed_layout.trim_size`, `margins` and `typography`
with the PDF paginator and local Poppler
`pdftoppm` to produce paginated raster images (long edge 1800 pixels). Install
and pin Poppler in the rendering-worker image/host; ensure `pdftoppm` is on PATH
or set server-only `BOOKWORM_PDFTOPPM` to its executable. The converter never
receives user-supplied paths or network URLs. Missing/conversion/timeout errors
stop export; they do not silently fall back to reflowable output.

Limits: 2000 source pages, 120 seconds total rasterization, 150 MiB page-image
budget. Temporary source PDF is removed on success or failure. Pin both
ReportLab and Poppler for reproducible bytes across hosts; deterministic tests
only establish repeatability within the tested toolchain. Native Poppler tests
are skipped on hosts without the executable, so a green run with skips is not
fixed-layout acceptance.

This output preserves appearance but text is rasterized with image alternatives,
not selectable/reflowable. It inherits the print renderer's script limitations.
Use reflowable EPUB for adjustable text and better reading-system accessibility.
The editor exposes these layout settings only for fixed EPUB or print. Existing
fixed EPUBs default to 6x9 with Vera body/heading fonts; existing print defaults
are preserved. New editions use Vera. Fixed EPUB does not use print bleed or
page-number controls. Switching to reflowable retains saved fixed settings but
does not apply them to reflowable content.
Full-bleed illustration handling, tagged
semantics and actual reader/retailer preview acceptance remain open. No live
deployment is authorized by these instructions.
