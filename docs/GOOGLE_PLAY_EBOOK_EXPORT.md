# Google Play Books ebook export — 2026-09-24

Bookworm can prepare a private, deterministic `googleplay-export.zip` for a
single ebook. It contains the saved EPUB, allowlisted metadata, a manual
handoff README and checksums. A Google Play preflight requires title, author,
language and a readable embedded PNG/JPEG front cover between 640 and 7,200
pixels per side. The channel accepts ebook editions only and is available only
when the organization has the `google_play` publishing entitlement. An
additive migration extends the service-only preflight and package completion
allowlists; it is **not installed in hosted Supabase** by this checkpoint.

This is **not direct publishing**. The author must create or open a title in
the [Google Play Books Partner Center](https://support.google.com/books/partner/answer/3289675?hl=en),
enter the book information and pricing, upload `book.epub` from the archive
in that title's Content tab, review Google's processing/preview and publish
from the Review tab. Google says a single-title Content-tab upload does not
need the identifier in its filename; bulk uploads and updates do have naming
and book-ID rules. See [file guidelines](https://support.google.com/books/partner/answer/3424254?hl=en-GB).

Google calls for an EPUB containing the complete book and front cover and
validation with EpubCheck; see its [EPUB guidance](https://support.google.com/books/partner/answer/3316879?hl=en).
Bookworm checks its generated EPUB structure and embedded cover and runs
W3C EPUBCheck 5.4.0 on the exact EPUB during both rendering preflight and
package assembly. A missing or failed checker blocks the Google package;
warning counts are surfaced for review (run EPUBCheck separately for the full
diagnostic report). The isolated rendering and publishing
container images install a checksum-pinned checker at build time, with no
runtime network access required. This does **not** verify the title in
Google's reader, prove Google acceptance or confirm territories, rights, tax
and price settings. These remain human acceptance gates. Google may change its rules; recheck before
launch. The package is not an upload API request and creates no Google sale
or publication-status record.

For non-container local development, install the official EPUBCheck 5.4.0
release and set `EPUBCHECK_JAR` to its `epubcheck.jar` file for both the
rendering and publishing services. Java must be available on `PATH`. If either
service lacks that checker, its Google Play validation fails closed; other
publishing channels are unaffected.

Local validation: disposable SQL migration and service-only completion
assertions, Python rule/package tests, API route/entitlement tests, and
workspace typechecks. The processing-container workflow also exercises
rendering preflight and packaging with the real checker under network-isolated,
read-only runtime constraints; [run 35957543082](https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/35957543082)
passed for `00c91fd`. Native hosted Supabase/Storage, current provider,
Partner Center upload and actual retailer approval remain unverified.
