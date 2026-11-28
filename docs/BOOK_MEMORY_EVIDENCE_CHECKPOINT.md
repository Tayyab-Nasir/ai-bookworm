# Book memory, source evidence and metadata proof

This checkpoint continues the complete publishing application through persistent
Book Bible review and evidence-backed publishing metadata. It does not authorize
hosting, paid activation, migrations or retailer submission.

## Author workflow

- Book memory revalidates access on every load. Previously loaded canon, forms,
  candidates, histories and editable permissions are removed while revalidation
  is pending and remain unavailable after a failed response. Each load has its
  own response fence; an older editable reply cannot replace newer viewer data.
  Unmount invalidates outstanding callbacks without cancelling accepted work.
- Browser paid-request recovery pointers survive failed revalidation. Reloading
  never accepts a quote, starts generation, cancels a job or writes book data.
  New paid work still requires approved pricing, token-count consent, exact
  quote review and a separate explicit credit authorization.
- Generated candidates stay outside canon. Authors recover an existing paid
  result, inspect its sources, open an unsaved entry, select cleared reference
  images and explicitly save. Unedited structured attributes, image IDs and
  chapter/version/node/hash references are preserved by the existing save API.
- Saved memory entries expose their exact manuscript passages to authorized
  viewers as well as editors. The reader sits outside disabled edit controls.
  Full citation identity keys keep late replies from reappearing after entry
  selection, chapter changes or source removal. Chapter-only references are
  explicitly not represented as exact-passage proof.
- Metadata candidates reuse the same passage reader. Reading a proof does not
  change the description; using it only changes the unsaved form. Explicit
  Save metadata persists description, keywords and categories. Existing saved
  candidate history retains its source evidence.

## Evidence and interface contract

The existing evidence API checks active book membership, chapter and document
version ownership, source node and exact SHA-256 before returning private,
no-store text. Historical sources are identified as earlier versions. The
client checks every returned text range and next offset. Failed or malformed
page reads leave the last verified passage intact and expose a retry.

Read/paging controls have 44px minimum targets and visible keyboard focus.
Loading uses guarded, aria-disabled read actions so keyboard focus remains
stable; unavailable previous/next actions cannot dispatch a request. Native
fieldset minimum sizing and mobile grid tracks are constrained, including
long, unbroken chapter titles.

The design remains an editorial reference desk: black ledger panels,
Instrument Serif display type, the existing body typography and sky evidence
accents. Hierarchy separates candidate confidence from source verification and
canon saving. No new dependency, theme replacement or decorative motion.
Design feasibility score: (impact 4 + fit 4 + feasibility 4 + performance 4)
minus consistency risk 2 = 14.

## Acceptance

Run from `C:/Users/Asus/ai-bookworm`:

```powershell
node --test apps/web/tests/quote-recovery-mounted.mjs
node --test apps/web/tests/editor-numbering-mounted.mjs
npm run verify
```

The quote-recovery harness currently contains 30 mounted checks using actual
React components and controlled local transports. Eleven new checks cover
401/403/503 revalidation, the StrictMode load race, viewer source reading,
metadata proof/use/save, lost paid acceptance plus explicit canon saving and
remount, three stale-citation changes, and 375px pagination/failure/focus/containment.
Earlier AI, metadata and image quote-recovery checks are retained.

Styled memory cases compile the actual project Tailwind/global CSS and embed
the vendored Instrument display font. The fixture's body font uses locally
available Inter/sans-serif. AI/image CSS modules remain mocked in their older
behavior-only cases. These checks open no application listener and do not prove
native Supabase, provider, ledger or production-route font behavior.

Terminal logs, source hashes, screenshots, exact-index production-build
manifest and Git identity belong in the owned phase note and current shared
Codex handoff in `C:/Users/Asus/Memory-Ai`. No coverage percentage or independent
lint acceptance is inferred from the root no-task lint wrapper.

## Remaining full-product gates

Keep the full goal open: native Auth/PostgREST/RLS/private Storage/scanner;
approved, current OpenAI models and usage-based catalogs; supervised workers
and funded provider/receipt/settlement recovery; Google operator OAuth setup;
retailer packaging/accounts, physical print/international typography, audio QC,
Flutter/device acceptance, monitoring/backups and author beta. Local fixtures
and a production build do not establish commercial or retailer acceptance.
Preserve unrelated shared Next/config/docs/generated graph work and other
agents' private memories. No keys or customer content belong in Git or notes.
