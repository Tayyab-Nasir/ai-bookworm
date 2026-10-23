# Web publishing OS — acceptance audit, 2026-10-23

This audits the original full-product goal, not merely the latest editor feature.
Sources: `PRD-SOW.txt` sections 2, 5 and 16; `PLAN.md`; current source and the
native/local evidence linked below. User overrides: mobile parked, Stripe deferred.
Implemented source is not synonymous with a live, commercially accepted service.
Current verified source: `a22a4aa` (full local suite and native database CI).
Application-identical `5c32630` passed the production web build and native
author/files CI. Hosted schema is at 111 migrations; application-only recovery
through 111 is verified. See `CHAPTER_TITLE_CHECKPOINT.md` for evidence boundaries.

| Workflow | Current implementation/evidence | Remaining acceptance |
| --- | --- | --- |
| Accounts, workspaces and library | Supabase Auth/BFF, Google configuration, onboarding RPC, dashboard; prior native onboarding/tenant checks | Fresh user Google-login/dashboard result; final hosted API origin and production redirect configuration |
| Upload and import | Private assets, quarantine/scanning, immutable sources, DOCX/EPUB/TXT and limited PDF; native author/files acceptance | Private scanner/document service supervision and author-hosted upload acceptance |
| Write and edit | Canonical editor, chapter creation/order/title, formatting, page breaks, revisions, manual-save recovery; mounted browser and native author checks | Representative beta-author manuscripts, including unsupported-layout disclosure |
| Story/content/proofreading | Separate token-count consent, approved model/price catalog, funded quote, durable jobs, review and explicit apply | Server OpenAI key, approved current model/rates, funded provider quality/cost/recovery exercise |
| Book Bible and memory | Manual canon and recoverable AI extraction, source references, current-version PostgreSQL full-text retrieval | Funded extraction acceptance; semantic/relationship recall remains a separate evaluation gate |
| Illustrations and covers | Paid image quote/recovery, asset versions/approval, image placement and cover composition | Approved OpenAI image catalog, private workers and funded provider acceptance |
| Layout, preview and export | Saved editions, typography/trim/spacing, EPUB/PDF, private readers, deterministic preflight and retailer ZIP packages | Hosted services; representative physical print and retailer ingestion acceptance; documented RTL/tagged-PDF limitations |
| Publishing and sales | Export-first channel adapters, package history, manual submission and retailer-report import | Authorized retailer submission remains manual unless an official integration is separately approved; real report-format acceptance |
| Translation and audiobooks | Separate funded quoted jobs; reviewed translation and narrated audio/QC/export workflows | Approved OpenAI text/speech catalogs, funded narration/translation and hosted worker acceptance |
| Teams and operations | Invitations, roles, tasks, approvals, activity, moderation, support/data-rights intake | Operational ownership, retention/fulfilment processes, alerting and delivery acceptance |
| Credits and payments | Immutable ledger, quote holds, metered settlement and entitlement gates | Stripe intentionally deferred; no unpriced/free generation is enabled as a substitute |
| Deployment and recovery | Vercel web boundary documented; separate API/private processors/workers; application snapshot restore-tested through migration 111 | Private runtime hosting choice, supervision, full Supabase/Auth/Storage/settings recovery, operator-approved deployment |

## Integration decisions carried forward

- LightRAG is not installed in the author request path. The current working
  source search is PostgreSQL FTS with tenant/source-version checks. The existing
  `BOOK_RETRIEVAL_DECISION.md` requires a measured private evaluation before a
  second retrieval store is adopted. Do not label current search semantic RAG.
- SnapOtter has not been copied or installed. `SNAPOTTER_EVALUATION.md` records
  the prior licensing, privacy and isolated-processor gates. This audit does not
  refresh upstream terms or claim those gates have been cleared.
- Audiobook source already uses OpenAI-backed quoted narration; replacing it
  with another repository is not necessary to fill a missing narration workflow.

## What prevents a complete live product now

1. The operator has not supplied approved OpenAI keys/model-price catalogs.
   No paid provider or funded-quality claim is justified without those.
2. Local web/API liveness works, but Redis is unavailable and private processors
   and worker supervision are not running. The one-second hosted Supabase probe
   has intermittently failed after idle; its cause remains unconfirmed.
3. The pending fresh Google-login answer and private service-hosting choice must
   be collected. Do not infer successful user acceptance from a passing build.
4. Full project disaster recovery, hosted operational acceptance and retailer
   acceptance remain distinct from the tested application-only recovery and
   native disposable fixture checks.

No additional deployment, purchase, provider spend or retailer submission is
authorized by this audit. Continue meaningful implementation and verification,
but do not call the full product complete while these boundaries remain open.
