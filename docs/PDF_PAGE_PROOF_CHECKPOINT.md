# Saved PDF page proof checkpoint

This fixes the observed blank inline PDF frame without changing the saved PDF,
removing privacy controls or depending on a browser PDF plugin. A fresh private
URL still produced a blank frame in the operator's real Chrome profile. The
Storage response was HTTP 200, application/pdf, byte-exact and not forced to
attachment. This does not establish the browser plugin's internal failure cause.

## Author experience

The print desk displays one verified page image at a time. Authors can choose
the interior or full-cover PDF, turn/jump pages, select 720/1080/1440-pixel detail,
zoom and inspect bounded plain page text. Text is React-escaped, not HTML. The
scroll region is keyboard-focusable and controls wrap on narrow screens.
Current manuscript edits never replace a historical proof. Original private
downloads remain available; final print inspection still requires the PDF.

Fresh render links now have a conservative expiry based on request start and
the shortest returned lifetime, capped at 300 seconds. Expiry withdraws all
proof pixels and download links. Opening the saved proof renews links without
another book render. Late, mismatched, expired and revoked-access replies cannot
replace the current source. Page retries are read-only.

## Trust and runtime boundaries

`GET /v1/editions/:editionId/print-renders/:jobId/pages/:pageNumber` requires the
listed primary SHA-256, complete proof fingerprint and a saved PDF asset ID.
The user-scoped API verifies active membership, canonical v1 descriptors and
exact trusted/clean asset versions. It reads and hashes only the selected PDF,
then rechecks source/membership before private decoding and before returning.
No caller URL/path, signed link, provider, payment, credit grant, row mutation
or new manuscript render is involved.

A 30-second API deadline and existing shared preview admission bound work,
including dependencies that ignore cancellation. The private rendering role
accepts binary PDF with an exact SHA-256 header. It admits one PDF request before
body buffering, caps the source at 150 MiB, serializes PDFium access, closes
native handles, disables forms and annotation drawing and rejects V8/XFA builds.
The result is at most six million pixels, 4096 pixels per side and 6 MiB PNG,
plus at most 6,000 characters of text. API and browser verify PNG bytes, digest,
geometry and source identity. No PDF is embedded in a same-origin frame.

The pinned `pypdfium2==5.14.0` default wheel bundles PDFium. Keep its distributed
BSD/Apache and third-party license notices in service images; do not strip
installed package metadata/licenses when packaging. Official API/thread-safety
and build guidance: https://pypdfium2.readthedocs.io/en/stable/python_api.html
and https://pypdfium2.readthedocs.io/en/stable/readme.html.

This is a private service for verified generated proofs, not a general-purpose
public untrusted-PDF conversion endpoint. Process/container memory and CPU limits,
authenticated private hosting and supervised workers remain required in a
hosted release. Native decoding is not a security sandbox.

## Acceptance and continuation

Targeted API/web checks, Python renderer cases and mounted full-Chrome journeys
cover integrity, tenant access, mid-read revocation, private transport, deadlines,
mobile paging/zoom, literal script-like text, stale replies and expiry. Native
CI additionally exercises actual PDFium, private Storage and production UI;
its source-pinned outcome must be checked separately from local fixtures.

Keep this checkpoint separate from full product completion. No new migration,
deployment, paid AI request or retailer submission is authorized by these notes.
Mobile remains parked and Stripe deferred; paid entitlement gates stay closed.
