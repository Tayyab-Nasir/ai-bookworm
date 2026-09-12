# SnapOtter integration decision

Reviewed 2026-09-07. Status: evaluated; not installed, copied, or connected.

SnapOtter is a candidate for an optional private processing service, particularly
OCR for scanned manuscripts, artwork cleanup/upscaling, format conversion and
future audio preparation. Its documented API accepts multipart file uploads,
authenticates with API keys and exposes synchronous or queued jobs. This can
complement Bookworm without replacing its workspace permissions, private asset
storage, canonical book model, version history, credit accounting or publishing
preflight. [Official API](https://docs.snapotter.com/api/rest).

The repository is AGPL-3.0 except its commercial enterprise package; its authors
also offer commercial terms for proprietary uses. Do not assume that a separate
HTTP service settles licensing obligations. Obtain a qualified licensing review
and, if needed, a commercial agreement before adopting it in a closed-source
market product. No license purchase or change to Bookworm's license is authorized
by this note. [Licensing](https://github.com/snapotter-hq/SnapOtter/blob/main/LICENSING.md).

Self-hosting does not mean zero outbound traffic by default: product analytics is
enabled unless opted out. For private author manuscripts, disable telemetry and
verify egress behavior in an isolated staging deployment, including model/bundle
downloads. [Telemetry](https://github.com/snapotter-hq/SnapOtter/blob/main/TELEMETRY.md).

## Proposed boundary and acceptance gate

1. Keep existing import/render paths working without SnapOtter. Add only a
   narrowly scoped processor adapter after the licensing decision.
2. Send only author-requested, clean-scanned assets through a private backend
   connection. Never send storage credentials, entire workspaces, or public links.
3. Restrict tools/settings, bound CPU/memory/file size and job duration; isolate
   untrusted converters. Keep job-to-workspace ownership in Bookworm.
4. Treat downloaded results as untrusted: verify size/type/checksum, scan them,
   and save a new private asset version with source and processor provenance.
   Never overwrite the original automatically or charge twice on retry.
5. Benchmark scanned PDF OCR, a mixed-layout DOCX and print-resolution images
   against the current stack. Test tenant isolation, timeouts, cancellation,
   cleanup, failed jobs, URL/redirect validation and network egress.

Recommendation: defer core adoption, then trial OCR as the first bounded use
case if the licensing and operational gates pass. LightRAG addresses retrieval;
SnapOtter addresses file processing. Neither replaces canonical book editing.
