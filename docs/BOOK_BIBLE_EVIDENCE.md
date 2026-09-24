# Book Bible manuscript evidence

Book Bible entries are author-approved records, not automatically verified
facts. Their optional `sourceRefs` can point to a chapter or to a node in a
saved chapter version. The API checks every cited chapter belongs to the book
and every supplied version belongs to that chapter.

For node-level citations, the API now reads the saved document version and
requires the node to exist in it. If no version ID was supplied, it resolves
and stores the chapter's current saved version at the time of approval. It
stores the SHA-256 hash of the complete canonical node text when present; a
supplied hash must match exactly. An invented node, stale hash, unsupported
saved chapter format, or missing current version prevents the entry from
being saved. Editing an entry with a pinned historical source continues to
check that historical version, even if the current chapter has changed.

Chapter-only references remain valid for human notes but do not prove a
specific passage. A verified source citation proves a saved node and text
existed at that version; it does not prove the entry's interpretation of the
passage. The author must still review AI-proposed facts and images. No
manuscript text is copied into the Book Bible source reference.

These checks are locally verified only. Hosted Auth/PostgREST/Storage
acceptance and the broader publishing release gates remain separate.

The additive `20260924180000_book_bible_evidence.sql` migration extends the
same boundary to direct authenticated table writes through PostgREST. A
trigger rejects fabricated chapters, mismatched versions, missing nodes and
incorrect hashes; textual node citations must carry a pinned version and
the full canonical text hash. Its disposable database test covers direct
insert/update bypass attempts. The migration is **source-only**, not applied
to the hosted Supabase project. Existing Book Bible rows are not rewritten or
retroactively certified; audit them before any claim of universal provenance.
