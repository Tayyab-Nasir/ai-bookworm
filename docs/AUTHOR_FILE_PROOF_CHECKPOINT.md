# Author, file library and saved-print checkpoint

User decision, 2026-10-13: defer Stripe integration. Preserve billing drafts and
existing subscription/credit gates. Deferral does not authorize free AI or
retailer-channel access. Build the author-facing application first.

## Implemented

- Asset library refresh explicitly reloads files, folders, books, image history
  and access. Workspace changes no longer invalidate their own new reads. The
  folder/file layout stacks at narrow widths, including320px.
- Original-file download preparation revalidates current metadata and immutable
  version: workspace, path, checksum, MIME, bytes and scan status. It exposes a
  short private link for a separate user click; preparing never downloads a file.
  Errors, expired links, dialog replacement and late replies fail closed.
- Account settings/support is reachable on mobile alongside existing sign-out
  and eligible Admin navigation.
- Chapter draft backups preserve rich canonical nodes, table grids, captions,
  styles, numbering and artwork references. Invalid numbering additionally
  captures the actual editor document and current text, explicitly marking the
  canonical nodes as the last-valid draft. No manuscript is saved in browser
  recovery storage by this action. TXT is text-only; JSON is not yet an accepted
  manuscript upload format and does not contain image bytes.
- New chapter-version text/counts use the shared browser-safe reading-text
  helper. Explicit canonical text wins; rows-only tables and distinct image
  captions are included. Existing document versions are not rewritten.
- Book Bible unsaved entries/details/listing metadata now guard ordinary SPA
  links as well as closing/reloading. Cancellation preserves the draft.
- Print editions list immutable saved PDF proofs and renew exact interior/cover
  private links without rendering again. The API binds tenant membership,
  source request, whole-proof fingerprint, canonical version paths and every
  artifact's metadata/bytes. Membership/source are rechecked after byte reads.
  Files require a matching SHA-256 and PDF/PNG signature under bounded deadlines;
  this is not a general PDF-parser safety certificate. Old proofs retain their
  old content after manuscript/edition edits. Fresh preflight and existing
  current-source/entitlement checks still govern retailer packaging.

## Acceptance evidence

Frozen source tree:88719a1b95a046845211528774258e207a9d2dc9; parent:
f94d726f09929d35ce92ae720c247f8d8558bdb5.31 reviewed paths;882 exported sources;
eight snapshot-local workspace links. Dependency installation junctions remain
external, so this is not a fully hermetic dependency snapshot.

The isolated production build passed with source inventory checked before/after.
All53 mounted browser checks passed on the same snapshot, covering real editor,
Book Bible, asset page/account menu and saved-print/PublishingStudio components.
Compiled desktop/mobile screenshots were reviewed. An off-screen mobile backup
menu was caught visually and repaired with explicit320–1280px bounds checks.
The headless PDF iframe surface is not pixel-faithful PDF rendering evidence.
R2 adds the current-book identity guard before private print reads, conservative
signed-link expiry from request start, and a wall-clock check at the actual
download click. Three browser regressions exercise these additional boundaries.
The matching full verifier and all six composed author-browser journeys passed.
Full verification includes eight workspace typechecks,852 API/362 web tests,
106 disposable migrations/68 SQL suites, populated45+61 upgrade with two guarded
aborts,721 Python service/16 E2E/46 security cases plus two subtests,50-request
load without5xx and six deterministic evaluations. Live provider evaluation was
skipped. Build/fullverify/mounted/browser receipts were captured respectively
at05:14:03.872,05:19:10.844,05:15:27.299 and05:21:24.828 UTC on2026-10-13,
with exact source inventory checks and all owned children terminal.
Current authoritative receipt paths, remote save and native CI confirmation
are in the linked vault note; local tests do not imply hosted/native acceptance.
Do not reuse October10 acceptance for this source tree.

Current shared note:
`C:/Users/Asus/Memory-Ai/Codex Sessions/2026-10/2026-10-13-author-file-proof-checkpoint.md`.
Read it with `docs/AGENT_HANDOFF.md` before continuing. Other agents' private or
generated memory was not modified, and discovery does not prove note consumption.

## Next requirements

Durable manual Book Bible POST creation recovery remains incomplete: a lost
reply followed by retry can duplicate an entry. Initial/import SQL still derives
plain text from node.text until an explicit save. Full native journeys, funded
provider/pricing acceptance, scanner/Storage/runtime and commercial release
checks remain separate. LightRAG/SnapOtter are evaluation proposals, not live
integrations. Retailer submission is manual, not a claimed native connection.
No hosted migrations, deployment, paid provider request, charge or retailer
action occurred. Keep the full publishing-OS goal active.
