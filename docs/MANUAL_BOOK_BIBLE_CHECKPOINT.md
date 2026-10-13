# Manual Book Bible recovery checkpoint

Source commit: `7530c5ecf5593e3e85323d668b48883fe0fbde0b` on
`codex/paid-story-blueprint-20260923`, pushed on 2026-10-13.
Stripe remains deferred by the user. Existing paid AI consent and credit gates
remain in force.

## Delivered behavior

Manual entry creation, editing and deletion carry the authenticated account and
an original request UUID through the browser, SDK, BFF, API and database. Canon
and its immutable receipt commit together. If a reply is lost, the author can
recover that request without writing again. Replaying the same request reports
the current entry; it cannot undo later edits or recreate a deleted entry.

Browser recovery storage contains only identifiers, revision information and an
intent digest. Canon text and attributes stay in page memory. Writes stop when
the recovery pointer cannot be persisted. Old recovery pointers remain readable
and closable but cannot guess the current entry identity and retry a write.

An author may explicitly close an unresolved request. The database either
returns its already committed result or permanently closes the original UUID.
The UI clears uncertainty only after validating matching request/book closure
proof. An empty recovery response alone does not permit a new write.

First edits/deletes require both the server revision timestamp and the row's
incarnation UUID. Direct legacy updates receive a monotonic server revision;
recreated rows receive a new identity even when their public UUID is copied.
Selected chapter/document/image evidence remains locked through the transaction.
All operations recheck current editor access and use READ COMMITTED transport.

Migration `20261013100000_manual_book_bible_recovery.sql` must run atomically.
It preserves existing history/confidence, backfills row identities, and aborts
on non-finite historical revisions. Receipt/closure tables hold metadata without
canon bodies and deny direct application-role access. Their retention/erasure
policy remains a release requirement; deleting closure evidence could allow an
old delayed request to execute. No zero-downtime migration claim is made.

## Verification

Corrected R2 contains exactly 24 reviewed source changes and 891 exported files.
Tree: `3d6883194a244858dbdc31f05ca98f1dee80be35`.
Source digest: `18b75db78a905437316be2c31f897a03afcf7be88daa920d2c44b51e6eb373a3`.
The earlier R1 build is superseded and is not acceptance for this revision.

Production build, eight workspace typechecks, 893 API tests, 378 web tests,
107 disposable migrations/69 SQL suites, populated 45+62 upgrade with three
guarded aborts, 721 Python service tests, 16 E2E tests, 47 security cases plus
two subtests, the load smoke and deterministic evaluations passed. Live provider
evaluation was skipped. All 125 mounted browser tests and seven composed
production-browser journeys passed. The isolated Gstack check passed; desktop
and mobile Book Bible/sign-in screenshots were reviewed. Owned test processes
are terminal. Installed dependencies are shared through checked junctions, so
the snapshot is not a fully hermetic dependency installation.

Native PostgreSQL CI passed for the exact source commit:
https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/38375357427
Job `115222242960` completed successfully at 09:21:23 UTC. Its logs confirm
all 61 contention schedules, 65 lock-wait observations, six isolation refusals
and two additional stale-incarnation probes. This was a disposable PostgreSQL 16
service in CI; the hosted Supabase project was not changed.

## Follow-on import reading-text alignment

Migration `20261013110000_canonical_import_reading_text.sql` aligns new initial
chapter/import versions with the existing canonical reading-text helper. It
includes rows-only tables and distinct image captions, preserves authoritative
empty text, and counts ECMAScript whitespace consistently. Rich content and
historical versions are not rewritten. Existing import receipts and leases
retain their behavior. The import worker uses the same reading-text check and
keeps captions when an older parser cannot transfer illustration bytes.

Apply this forward migration atomically through the supported runner. Exact
function-body and metadata guards abort on an unexpected predecessor; rollback
of a failed transaction preserves both function definitions, helper/schema
grants and historical rows. Do not run the statements individually or reverse
an accepted migration by editing historical files. Rehearse operator rollout
against actual drift/backups before hosted use. This is not a zero-downtime claim.

Coverage lives in `services/api/src/manuscript-import-quarantine.test.ts`,
`tests/security/canonical-import-reading-text.test.sql` and the populated
45-to-108 upgrade runner. The manual R2 results above predate this follow-on
change; its own frozen-candidate and native CI outcomes belong in the shared
continuation note below.

## Continuation

Exact receipts, artifact hashes and native CI outcome:
`C:/Users/Asus/Memory-Ai/Codex Sessions/2026-10/2026-10-13-manual-book-bible-build.md`.
Read that note with `docs/AGENT_HANDOFF.md` and Git status before edits. Preserve
the remaining shared Next configuration, operational documentation and Stripe
drafts; they were excluded from this source commit.

Next: verify the follow-on import alignment against its exact frozen source,
then continue native Storage/scanner/runtime, funded OpenAI/pricing,
and commercial release acceptance. LightRAG/SnapOtter remain evaluation proposals,
not installed production integrations. Retailer handoff remains manual. This
checkpoint does not establish full product completion. No hosted migration,
deployment, paid provider request, charge or retailer submission occurred.
