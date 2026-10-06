# Manuscript editor request and paid-review recovery

This checkpoint covers the real author canvas, chapter creation recovery and
explicit paid draft review. It does not change the product scope or authorize
deployment, paid activation or retailer submission.

## Author-facing contract

- A requested chapter is never silently replaced with the first chapter.
  While loading or after failed revalidation, the previous manuscript, history
  and editable role are cleared. Explicit retry preserves the requested target.
- Late save, history, restore, creation, reorder and AI Apply replies cannot
  replace the current chapter or release a newer operation's save lock.
  Ignoring a client reply does not cancel accepted server work.
- Unconfirmed chapter creation retains its original book, title, brief and
  idempotency key across same-book chapter changes. Its intent fields stay
  locked until recovery confirms the original outcome; a replayed sidebar row
  is not duplicated. Leaving the editor warns about this unresolved outcome.
  Private creation briefs are not persisted in local or session storage.
- Adding a chapter with an AI brief creates only an empty chapter and opens
  separate price review. Provider token-count consent, counted offer, exact
  credit acceptance and generation remain distinct actions. No generation or
  charge is initiated by chapter creation or opening the brief.
- An uncertain acceptance reply is recovered from the original quote's
  read-only status instead of accepting a second time. Proposed text stays
  outside the manuscript until the author explicitly selects Apply.
- A confirmed same-chapter Apply keeps its review mounted while refreshing
  the saved manuscript. Writes are disabled during that refresh. If refresh
  fails, previous content and permissions are removed and the author retries
  loading the requested chapter; the already applied review can be reopened
  without generating or applying again. Save is absent without a document.

## Acceptance commands and evidence

Run from `C:/Users/Asus/ai-bookworm`:

```powershell
node --test apps/web/tests/editor-numbering-mounted.mjs
npm run verify
```

The mounted harness uses the actual React editor, Tiptap, chapter tree, revision
timeline, compiled project CSS and, for paid-flow cases, the actual AI assistant
and proposal sheet. It intercepts fixture transports and opens no app listener.
Its 28 checks retain all eight numbering/draft/contrast checks and cover late
operation replies, current-save locking, requested-target recovery, original
creation identity, paid consent, lost acceptance reply, explicit Apply, and
successful/failed post-Apply refresh. Paid-refresh screenshots use distinct
success/failure filenames. Mobile containment is checked at 375px.

The full verifier covers workspace types, worker-launcher and unit/web/API tests,
disposable PostgreSQL migration/SQL assertions, Python services/E2E/security,
load smoke and deterministic evaluations. It does not execute this separate
mounted harness or prove funded live-provider behavior. For manuscript export
fidelity, `tests/e2e/editor-numbering-export-proof.py` independently renders the
exact mounted `edited-numbering.json`, runs installed EPUBCheck, reimports that
EPUB and checks PDF text/font embedding; it is a separate manual proof.

`tests/e2e/ai-authoring-browser.mjs` follows explicit creation retry and separate
quote/acceptance controls, but requires its authorized isolated app/auth fixture
listeners. Updated selectors alone are not a completed browser journey. Do not
bypass listener limits or restart an existing run because observation timed out.

Terminal results, artifact locations, exact-index production-build manifest,
commit/remote readback and exact continuation steps belong in the current shared
Codex handoff and owned phase note in `C:/Users/Asus/Memory-Ai`. An exact-index
build must use this checkpoint's parent and snapshot-scoped workspace aliases;
the older numbering build manifest cannot certify newer editor changes.

## Release boundaries

The local checks do not prove native Supabase Auth/RLS/PostgREST/private Storage,
scanner integration, live measured provider usage, funded ledger settlement,
approved pricing/model catalogs, supervised worker recovery, audio quality,
physical printer acceptance, Flutter device readiness or retailer acceptance.
The full application/release objective remains open until those gates are proved.
Preserve unrelated shared Next declarations/configuration, documentation and
generated Graphify files. Do not write keys or customer content into Git or notes.
