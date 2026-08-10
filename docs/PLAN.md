# AI Book Publishing SaaS — Build Plan

Condensed from PRD-SOW.txt and MASTER-BUILD-SPEC.txt (same dir). Architecture rules:
Supabase/PostgreSQL = source of truth; Redis = transient (queues/cache/locks); Qdrant = derived retrieval index only.
Originals immutable. AI produces validated suggestions, never silently overwrites canonical content.
Retailer compliance deterministic + versioned; LLMs explain findings, never certify.
All async jobs idempotent/retryable/observable. Every tenant op authorized server-side (RLS + API authz).
Stack: Next.js/React/TS + Tiptap editor; NestJS/Fastify TS API; Python FastAPI AI/document services; Flutter mobile; Stripe billing; Sentry/OTel; Docker.

## Step 1 — Foundation: monorepo, env/config, CI/CD, observability
Repo contract per spec section 2: apps/{web,mobile}, services/{api,ai,document,rendering,publishing}, workers/{ai,document,render,publishing}, packages/{book-model,api-client,types,ui,validation}, supabase/{migrations,functions,seed}, tests/{unit,integration,e2e,security,fixtures,ai-evals}, docs/. Typed env config, GitHub Actions CI, Sentry+OpenTelemetry baseline. Tickets T00,T01, FOUND-001..004.
Out of scope: any business logic, DB schema, UI pages.

## Step 2 — Database: migrations, RLS, tenant isolation
Spec sections 3-6 executable baseline: migrations 0001_extensions, 0002_core (profiles, orgs, workspaces, books, chapters, document_versions, book_metadata, style_guides, book_bible_items), 0003_assets_collaboration, 0004_ai, 0005_community (incl. credit_ledger), 0006_billing_publishing (incl. audit_logs), 0007_indexes + is_workspace_member/workspace_role/can_edit_workspace helpers, 0008_rls policies, private storage bucket book-assets + object read policy. UUID PKs, UTC timestamps, unique slugs/version numbers/idempotency keys. Cross-tenant isolation tests for every table. Tickets T02-T05, DB-001..008, SEC-001.
Out of scope: API layer, seed data beyond plans, performance tuning.

## Step 3 — API foundation: auth middleware, OpenAPI, workspace/book services
TS API (NestJS/Fastify). Auth/session middleware via Supabase Auth, authorization service (SEC-002). OpenAPI 3.1 source with mandatory paths/schemas per spec section 9 (workspaces, books, chapters, document operations, assets upload-url, ai/jobs, publishing/validate+jobs, usage, billing/checkout; ApiError envelope with code/message/requestId). Standard error codes 400/401/403/404/409/422/429/500/503. Generated typed clients into packages/api-client. Versioned under /v1, idempotency keys, request IDs, structured logging. Tickets T06-T09, API-001..004.
Out of scope: AI agents, editor UI, rendering, Flutter.

## Step 4 — Book Model + document operations engine
Canonical Book Model JSON Schema per spec section 7 (schemaVersion 1.0, metadata, styleGuide, bookBible entities, chapters[] with typed nodes: paragraph/heading/quote/list/listItem/image/caption/pageBreak/table/footnote/separator). Typed operation contract per spec section 8: insert_node, delete_node, move_node, replace_text, set_attribute, attach_asset, detach_asset, split_node, merge_nodes — with expectedVersion optimistic concurrency (stale returns 409, no data loss). Implemented in packages/book-model, shared by web editor + API. Tickets T10, T15.
Out of scope: importers, renderers, AI usage of operations.

## Step 5 — Ingestion: secure upload + DOCX/EPUB/TXT import
Upload pipeline: malware/file checks, immutable source asset, parser, intermediate representation, canonical Book Model, import report (spec section 13). Storage path workspaces/{workspace_id}/assets/{asset_id}/v{version}/{safe_filename}; signed URLs; checksums. DOCX parser (P0), EPUB importer (P0, sandboxed unzip), TXT with encoding detection + chapter heuristics, PDF with explicit confidence warnings (P1). Sandboxed document worker via jobs.document queue. Import success target over 98% on supported normal files. Tickets T05, T11-T13, ING-001..004.
Out of scope: AI analysis of imported content, OCR quality work beyond warnings.

## Step 6 — Web editor shell + versioning UI
Next.js editor: chapter tree (BookTree), Tiptap/ProseMirror RichBookEditor emitting typed operations, VersionTimeline (compare/restore), permissions-aware. Anchored comments (P1). Component contracts per spec section 15. Tickets T14, EDIT-001..003.
Out of scope: AI sidebar behavior (Step 7 wires agents), realtime multi-user presence.

## Step 7 — AI gateway + proofreading/copyediting agents
Python FastAPI AI service. Provider-neutral gateway; versioned prompts/models/tools; agent tool schemas per spec section 12 (get_chapter, search_book, get_book_bible, get_style_guide, propose_edit, create_diagnostic, get_asset). AgentRequest/AgentResult contracts with idempotencyKey + usage telemetry (ai_runs). Default read-only + suggestion mode; propose_edit only via validated operations. Manuscript = untrusted input, prompt-injection defenses. Proofreader (P0) + Copy editor (P0) agents with golden eval suite (spec section 28: golden excerpts, precision/false-positive tracking). AI gateway flow: permissions/policy, context builder (Postgres + Bible + style + Qdrant), agent router, JSON-schema validation, suggestion/job, human approval, audit+usage. Tickets T16-T18, AI-001..003, AI-007.
Out of scope: Book Bible/consistency agents, Qdrant RAG (Step 8), image generation.

## Step 8 — Qdrant RAG + Book Bible + consistency agents
Qdrant collections per spec section 11: book_chunks, book_bible, style_memory, community_posts. Every query filtered by workspace_id + book_id; embeddings async, idempotent (jobs.embeddings), delete/re-index on version change. Never source of truth. Book Bible agent (structured entity candidates into book_bible_items with confidence + source refs), consistency agent (names/dates/characters/facts diagnostics). Tickets T19-T21, AI-004..006.
Out of scope: community semantic search UI, style profile generation UI.

## Step 9 — Assets/folders UI + collaboration (comments, tasks, approvals)
Professional folder tree (spec section 13 template: 00_Admin through 08_Archive), AssetBrowser (grid/list, preview, versions, usage links, permissions view/comment/edit/approve/manage, soft delete/restore, audit events). Collaboration: email invitations, roles owner/admin/editor/writer/illustrator/designer/reviewer/viewer, CommentThread, tasks with assignee/priority/due, approvals queue, activity timeline, mentions + notifications. Tickets T22-T23, ASSET-001..003, COLLAB-001..003.
Out of scope: realtime presence, asset-level permission overrides UI beyond defaults.

## Step 10 — Publishing engine: editions, EPUB/PDF render, deterministic preflight
Edition model (ebook/print; trim size, bleed, margins, typography, page numbering for print). EPUB renderer (P0), PDF renderer (P0) — same model/config/renderer version produces reproducible artifacts (checksum + immutable final package). Deterministic preflight with versioned rule sets (spec section 19: package integrity, EPUB structure, navigation/TOC, metadata, images, fonts, accessibility, links, language, channel rules); every rule version has fixtures. PreflightPanel with errors/warnings + location + remediation. Visual QA (P1). PublishingAdapter interface per spec section 14; export-first for KDP/Apple/B&N/Lulu, submission only where officially supported. Retailer rules verified against current official docs at implementation time. Tickets T24-T29, PUB-001..006.
Out of scope: automatic retailer submission APIs, audiobook editions.

## Step 11 — Billing, credits, usage metering
Stripe subscriptions + webhooks (signature verification). Plans/entitlements, checkout, customer portal. Meters: AI credits, image credits, rendering, storage, seats, publishing. usage_events reference the consuming job. credit_ledger immutable — never update balance without ledger transaction; compensating reversal entries for fraud/chargeback. Tickets T30-T31, API-007.
Out of scope: invoicing customization, marketplace payouts.

## Step 12 — Community + referrals
Public/private/unlisted communities, roles owner/moderator/member; posts, comments, reactions, reports, moderation queue; spam/rate controls. Referral codes/links, state machine attributed, qualified, rewarded; anti-fraud checks + manual review thresholds; rewards posted server-side as idempotent ledger transactions. Tickets T32-T33, COMM-001..002, REF-001..002.
Out of scope: full social network features, community semantic search.

## Step 13 — Flutter mobile companion (review-first)
Flutter + Dart; Dart models generated from OpenAPI (no duplicated business rules). Screens per spec section 16: Auth, Home, Books, Book Overview, Reader/Editor (lightweight edits + comments), AI Assistant (run job, review/apply/reject), Book Bible search, Assets browse/upload, Tasks, Team, Community, Notifications, Publishing status, Settings. Tickets T34-T36, MOB-001..005.
Out of scope: advanced layout/publishing controls (web-first), offline mode.

## Step 14 — Admin console + operations
Admin: users, jobs, moderation, support tickets, feature flags, audit views. Observability: health/readiness, queue-depth worker scaling signals, graceful shutdown, dead-letter queues. Backup/restore tested. Ticket T37, ADMIN-001.
Out of scope: enterprise SSO/SCIM, advanced analytics.

## Step 15 — Hardening, QA, launch
Critical E2E journeys (signup, import, edit, AI, preflight, export), security tests (tenant isolation matrix, upload abuse, prompt injection), load tests (concurrent AI jobs, rendering, API), AI regression evals on model/prompt changes, migration/rollback drills, MVP release checklist per PRD Appendix B (RLS verified, fixtures passing, billing/webhooks tested, DR tested, beta authors). Tickets T38-T42, QA-001..003.
Out of scope: post-MVP roadmap items (translation, audiobook, marketplace).
