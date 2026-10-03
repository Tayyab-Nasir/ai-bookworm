# Version-bound artwork review and export

New author-uploaded and generated artwork requires an independent workspace
reviewer before manuscript placement or cover rendering. Existing imported
artwork is grandfathered from human review, but still must be confirmed,
current, clean and available. The UI does not replace server-side checks.

## Dependency bundle

`20260929170000_illustration_review_workflow.sql` adds asset review state,
version-bound approvals, idempotent service-only review RPCs and a guard on
direct document writes. Release it together with the shared types, API client,
asset/collaboration/authoring/edition routes and artwork controls. Do not ship
the loader against a database missing these columns. Applying the source
migration locally is not proof that a hosted project has it installed.

The API verifies caller and assigned-reviewer eligibility. SQL locks the asset
and approval and validates new requests. An exact accepted-request retry
recovers the original approval even after a later revision; changing the
reviewer, version, comment or request identity is not an exact retry. Resolved
decisions are replayable only for the same reviewer, action and note, and a
superseded decision cannot approve a later revision.

Collaboration Center separates artwork from generic book approvals. Rejected
artwork needs a new immutable version before another review. Manuscript image
nodes save `assetVersionNumber`; previews request that private version rather
than silently displaying a newer asset revision. A revised image must be
reviewed and explicitly replaced in the manuscript.

## Export integrity

`services/api/src/lib/render-images.ts` is shared by render, preflight and
publishing workers. It checks workspace, live state, current version metadata,
scan state, explicit consistent placement pins, non-superseded exact-version
approval, and private byte size/SHA-256. At most 100 images, 25 MiB per image
and 100 MiB combined are accepted. Archived/rejected images are not placeable,
even when human review was grandfathered.

Render/preflight/package request identities include `imageSha256`, a
deterministic hash of the verified cover and illustration bytes. Packaging
requires both successful saved proofs to match current content, settings and
artwork. Historical proofs without the image hash require a new render and
preflight; they are not upgraded by assuming their artwork was unchanged.

Artwork is re-read after service work and before completion. A revision,
quarantine, revoked review or different stored bytes fails the attempt, and
attempt-owned uploads are compensated without charging successful usage.
These rechecks add private Storage reads. They are bounded but should be
included in operating costs; they do not invoke an AI provider.

The last artwork read and the completion RPC are separate operations. This
checkpoint does not claim atomic acceptance against a concurrent revision or
revocation at that final boundary. Native two-connection SQL acceptance and
an atomic snapshot guard remain release work. A database metadata check also
cannot by itself prove that an external Storage object is immutable.

## Local acceptance

Run the focused boundary checks from the repository root:

```powershell
node --import tsx --test services/api/src/asset-approval-routes.test.ts services/api/src/render-image-version.test.ts services/api/src/rendering-api.test.ts services/api/src/publishing-worker.test.ts services/api/src/editions.test.ts
npm run test:db
npm run verify
```

`tests/e2e/illustration-review-browser.mjs` uses an isolated real Next app and
synthetic Auth/API routes. It verifies independent request/decision recovery,
reject/revise/approve, exact-version placement and private download, save,
reload and mobile containment. It must not run against a customer workspace.

`tests/e2e/illustration-export-proof.py` renders the saved browser node through
the actual EPUB/PDF services. It checks embedded image pixels, alt text and
EPUBCheck 5.4.0. Its executable Java/JAR and browser fixture prerequisites are
deliberate operator inputs; the proof does not spend provider credits.

Local mocks, disposable SQL and synthetic render proofs do not certify native
Supabase Auth/Storage, live workers, real manuscripts, retailer acceptance,
physical printer quality, or production readiness. Keep paid catalog and
deployment gates unchanged until their own acceptance requirements pass.
