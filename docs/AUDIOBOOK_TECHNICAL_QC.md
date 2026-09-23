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

The report is returned with the private download in an internal response
header; no new generation credits are spent, no audio is written to a public
bucket, and no per-user QC history is stored yet. A missing older renderer
report is shown as unavailable, not as a pass.

Sources checked 2026-09-23:

- [ACX audio submission requirements](https://help.acx.com/s/article/what-are-the-acx-audio-submission-requirements)
- [ACX audio analysis tool FAQ](https://help.acx.com/s/article/acx-audio-analysis-tool-faq-s)
