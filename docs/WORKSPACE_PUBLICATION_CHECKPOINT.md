# Workspace and publication checkpoint — 2026-10-10

This is an implementation checkpoint, not commercial release approval. The
full publishing operating system is still in progress. Read
[the agent handoff](AGENT_HANDOFF.md) before changing the shared checkout.

## Implemented candidate

- Workspace selection survives supported page transitions without silently
  choosing another organization. Scoped dashboard, billing, collaboration and
  asset screens reject stale responses after identity/workspace changes.
- Publication metadata and layout options preserve unrelated saved settings.
  Title/copyright pages, cover composition, image fit, fixed/reflowable EPUB,
  text direction and retailer-package guidance have explicit validation.
- The proof desk opens immutable, private saved EPUB versions, not a fresh
  render. Source identity, SHA-256, raster bytes, dimensions and safe document
  markup are checked; active content and external links are not replayed.
  Repeated illustration occurrences can be inspected without regenerating.
- The mobile publishing grid contains fixed pages. Fit stays within the
  viewport; zoom uses an inner scroll area. Illustration selection has a full
  mobile row and fixed-page scrolling is keyboard-accessible.
- Redis readiness and auth-dependency failures report unavailable services
  honestly. A health response alone does not establish readiness.
- Migration 106 and the matching webhook implementation add durable receipts,
  lease-bound completion and current-subscription reconciliation. Bound
  cancellation/past-due revocation does not depend on obsolete granting-price
  metadata. Checkout completion alone does not grant paid entitlement.

## Frozen validation boundary

The final candidate is r11: tree
`4849b4dd9fe8f988cd0dab078606eccfe09c6a5a`, source inventory SHA-256
`4b8ea6567d5b757b9abd5d3c4e8eba0e92216f2e30aa3f127ea03877b309ec24`.
It contains 74 reviewed changed paths and 866 exported source files. Eight
workspace links resolve inside the snapshot; other installed dependencies
are junction-backed, not fully hermetic. No operator environment files or
provider secrets are inherited.

- Production build: passed, 2026-10-10T06:25:35.387Z.
- Full verification: passed, 2026-10-10T06:35:11.349Z; source integrity checked.
- Six composed browser journeys: passed, 2026-10-10T06:37:41.897Z; matching
  source inventory checked after every journey and cleanup. All owned children
  are terminal; fixture/web process-tree cleanup was confirmed.
- Desktop/mobile publishing, proof-reader, asset-detail and populated-dashboard
  screenshots were visually reviewed and preserved in the shared vault.

Local source commit: `c03beb62ca263bdba35255a3c030218a83bdd2c4` (74 paths;
8,746 additions/340 deletions), with the exact r11 tree above. Remote save and
native GitHub Actions confirmation are separate from this local acceptance.

Earlier r8/r9 builds and full verifications passed, but their reader browser
gates failed. R9 exposed real mobile layout overflow, not just a locator issue.
R10's corrected reader journey passed native saved-file/zoom/recovery checks;
its final control-accessibility improvements passed a separate r11 run.
Do not reuse an earlier candidate's receipt to accept a different source tree.

## Deliberately excluded unfinished work

The new bounded billing-operation helpers and explicit durable-idempotency
route flag are local working changes, not adopted by checkout routes or this
candidate. Their71 focused synthetic tests and nonincremental API typecheck
passed. The installed SDK's connection-coded retry behavior was reproduced,
then fenced to one native attempt. This is transport acceptance only.

The incomplete checkout-intent migration 107 and its weak route-existence test
were preserved outside automatic migration/test discovery. Do not apply them:
frozen preparation terms, provider parameters, lease validation, mode binding,
expiration/reconciliation and full API/client/UI contracts remain unfinished.
Native Flutter proposals are also uncompiled drafts; no mobile source or
dependency changes were applied in this checkpoint.

## Release boundaries and next work

1. Confirm the reviewed checkpoint on the authorized codex branch and check
   its native CI results; do not equate local synthetic checks with hosted
   acceptance or perform a deployment.
2. Finish durable checkout-intent preparation, explicit consent, same-key
   uncertainty recovery and authenticated status reconciliation. Integrate
   database, API, typed client, UI and OpenAPI together, preserving migration 106
   revocation. Keep amount/currency/billing-period comparisons exact.
3. Integrate and compile the complete native author workflow, not foundation
   files alone. Verify secure PKCE storage, session/tenant fencing, upload
   recovery, editing, paid suggestions and saved-artifact readers on devices.
4. Verify persistent API/workers, scanner/storage/native database behavior and
   owner-approved funded provider catalogs before commercial acceptance.

No hosted migrations, paid provider calls, payment charges, deployments or
retailer publishing were performed. Automatic Vercel Git deployments are
disabled for codex branches by both checked-in project-root configurations;
do not change that build-before-hosting boundary. LightRAG/SnapOtter remain
optional evaluated integrations, not substitutes for tenant isolation,
licensing/privacy review and recovery testing.

The authorized one-time gstack browser setup is complete and passed an
isolated synthetic interaction/screenshot smoke test. No global hooks,
telemetry preferences, user browser cookies or other agents' private memory
were changed. The shared vault contains detailed receipts and recovery
artifacts under Codex Sessions/2026-10/2026-10-10-workspace-publication-gstack-checkpoint.md.
