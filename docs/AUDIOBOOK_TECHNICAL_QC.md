# Audiobook technical preflight

The chapter download path can attach a report measured from the exact assembled
MP3. The report measures decoded chapter duration, overall RMS, sample peak,
and the output profile (mono, 44.1 kHz, 192 kbps CBR). The current numeric
limits follow ACX's technical submission page checked on 2026-09-23: each file
must be under 120 minutes, between -23 and -18 dB RMS, at or below -3 dB peak,
and 192 kbps or higher CBR MP3 at 44.1 kHz. The project encoder emits one
chapter as mono 192 kbps CBR MP3.

This is a technical preflight, not retailer certification, approval, or a
publisher submission. Automated measurements do not establish noise-floor
compliance, 1–5 second head/tail room tone, absence of clicks/outtakes/mouth
noise, correct spoken chapter headings, pronunciation, consistent narration,
opening/closing credits, sample suitability, or copyright/consent. Authors
must listen through the deliverable and follow each retailer's current
requirements.

Critical AI-voice boundary: ACX's current submission requirements state that
audiobooks must be narrated by a human unless AI/TTS is separately authorized.
AI narration in Bookworm is therefore not represented as ACX-eligible. The UI
marks authorization as required and does not offer an ACX package. Do not
remove this warning or enable a retailer route without rechecking official
policy and a documented authorization path.

The measured report is returned with the private download and, in local source,
can be persisted against the exact audio hash and source-version manifest.
Workspace approvers can record an immutable confirmation that they listened to
that exact file. The migration
`20260923040940_audiobook_qc_review_signoffs.sql` is not installed in the live
project, so production download history/sign-off is unavailable until the
schema is reviewed and applied; audio download remains non-blocking if report
persistence is unavailable. No new generation credits are spent, and audio
remains in private storage.

## Google Play author-side archive (local source only)

The Publishing Studio now has a local export-only route for audiobook editions.
It requires workspace approver access, a succeeded narration project pinned to
the current manuscript version for every chapter, a saved QC report for each
exact assembled MP3, an immutable listening sign-off for each report, and a
private same-workspace JPEG/PNG cover with both dimensions between 1,024 and
7,200 pixels. It accepts a checksum-valid ISBN-13 (including its check digit)
or a safe partner/book identifier. It assembles chapters in manuscript order
and writes `Audio/<ID>_chN.mp3` and `Cover/<ID>.jpg|png` into a ZIP named
`<ID>.zip`. It verifies Google Play's five-minute minimum and 100-hour maximum,
and the listed MP3 bitrate/channel minima. It makes no provider calls and
spends no additional credits.

This is not a Google submission, retailer approval, ISBN registration, pricing
or territory check. Authors must manually label this AI-generated title
“Synthesized voice” in Partner Center and verify the cover's 72 dpi requirement
(dpi metadata is not measured by the current export check). The ZIP is created
synchronously into a private temporary file, capped below ZIP32's 4 GiB limit;
the BFF has a finite request timeout. This first implementation is suitable for
bounded author-side exports, not yet a durable large-audiobook export queue.
The QC migration remains unapplied live, so this route is not active for the
production Supabase project. No live retailer request or data operation was
made.

## Distribution research (first-party sources, checked 2026-09-23)

- **ACX / Audible:** human narration is required unless the title has separate
  authorization for AI/TTS. Do not expose this OpenAI-generated voice as
  ACX-eligible or offer an ACX export preset without that authorization.
- **Google Play Books:** its Partner Center guide explicitly says that an
  uploaded AI-generated audiobook must be labeled “Synthesized voice.” The
  official file guide accepts MP3 (CBR preferred) at >=128 kbps mono or >=256
  kbps stereo, with a 5-minute minimum and 100-hour maximum; covers are JPG/PNG
  from 1,024 to 7,200 pixels. Direct audiobook sales are limited to select
  publisher partners/territories. This makes a future author-side,
  export-only Google package a candidate, not a submission or eligibility
  guarantee. Google's separate auto-narration/INaudio path has its own
  eligibility and continued-Play-availability/price conditions; those must
  not be applied to arbitrary Bookworm-generated audio.
- **Apple Books:** Apple offers digital narration made from EPUBs and says to
  use its preferred distribution partners for audiobook upload. That evidence
  does not establish acceptance of a third-party GPT-generated narration
  package. Keep Apple audio export disabled/neutral until a named partner
  confirms its current third-party AI narration and disclosure terms.

Any retailer-specific export must validate the retailer's exact format,
metadata/disclosure, ISBN, cover and duration rules; must require author rights
and listening attestations; and must be export-only until direct integrations
and partner permissions are separately verified. Policy pages can change.

Sources checked 2026-09-23:

- [ACX audio submission requirements](https://help.acx.com/s/article/what-are-the-acx-audio-submission-requirements)
- [ACX audio analysis tool FAQ](https://help.acx.com/s/article/acx-audio-analysis-tool-faq-s)
- [Google Play Books: Quickstart guide to add a new book](https://support.google.com/books/partner/answer/9261664?hl=en)
- [Google Play Books: Book file guidelines](https://support.google.com/books/partner/answer/3424254?hl=en)
- [Google Play Books: Upload & sell audiobooks](https://support.google.com/books/partner/answer/14164701?hl=en)
- [Google Play Books: Auto-narrated audiobook programme policies](https://support.google.com/books/partner/answer/10013009?hl=en-GB)
- [Apple Books for Authors: Audiobooks](https://authors.apple.com/audiobooks)
- [Apple Books for Authors: Digital narration for audiobooks](https://authors.apple.com/support/4519-digital-narration-audiobooks)
