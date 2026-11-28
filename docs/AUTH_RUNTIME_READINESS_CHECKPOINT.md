# Authentication and runtime readiness checkpoint

This continues the complete AI Bookworm publishing OS. It is not a release or
an assertion that Google sign-in, hosted author workflows or paid generation
have been accepted in production.

## Changes

- Root package and lockfile now require Node 22 or later, matching the locked
  Supabase SDK and existing CI/worker runtime. No dependencies were installed,
  upgraded or removed. A security regression protects both declarations.
- A Google sign-in request checks the configured Supabase Auth instance's public
  `/settings` endpoint before creating its OAuth URL or PKCE state. Only the
  literal boolean `external.google = true` permits the existing redirect flow.
  Disabled, unknown, failed or redirected settings return a neutral retryable
  in-app error. The request is GET-only, no-store, public-key-only, does not
  forward browser cookies or authorization, refuses redirects and has a
  12-second deadline. No provider settings or accounts are changed.
- Email signup remains independent of Google. A Gmail address and password
  can use the existing confirmation-required email flow; no customer-owned
  OAuth client is requested or required.
- Google failure recovery restores keyboard focus to its re-enabled retry
  button only when browser focus has fallen back to the page body. It does not
  take focus away from a field or link the user selected during the request.

## Current evidence

Both regressions were observed failing before the fixes: Node `>=20` did not
match the required `>=22`, and disabled Google returned an OAuth URL with HTTP
200 instead of the required in-app HTTP 503. Focused checks now pass: 26 Auth/BFF
tests and 45 Python security tests plus two subtests. Google-enabled callback,
disabled/unknown/error settings, public-key request shape, network failure,
Gmail signup, cookie privacy, session refresh and origin checks are covered.
These are controlled tests, not completed Google or email delivery acceptance.
Final full-verifier, exact-candidate build/browser and Git evidence belong in
the corresponding shared-vault phase after they actually complete.

Read-only live settings check at `2026-10-06T03:44:48.682Z` for the named
AI-BookWorm project reports Google disabled, email enabled, signup enabled and
email auto-confirmation disabled. Only boolean settings and project identity
were retained; no key, customer data, email, account or provider change occurred.
This proves the reported configuration then, not SMTP delivery or login success.

The preceding recorded hosted migration inventory remains 45 applied source
files and 60 pending local files. All 45 boundary-normalized source digests
match, with four legacy aliases; this is not full hosted DDL/runtime acceptance.
Do not blindly replay initialization SQL, repair history or activate catalogs.

## Remaining acceptance

The operator must configure one Google Web OAuth client in Supabase. Customers
use their normal Google account. Follow `GOOGLE_OAUTH_SETUP.md`, then verify new
and returning accounts, one safe profile row, workspace creation, session
refresh and logout. Test confirmation/reset delivery with an approved SMTP
configuration separately; current booleans do not prove delivery.

Review pending schema order, backup, grants/RLS and authority before live DDL.
Continue native persistent author/UI/Auth/private Storage/scanner/funded-provider
acceptance, approved model/rate catalogs, audio QC, international print/RTL,
mobile/device, retailer and operational gates. None are replaced by this
compatibility or Google failure-path fix. No deployment, migration, provider
spend, payment, customer write, email or retailer submission is authorized here.

Primary references: [Supabase Node support change](https://supabase.com/changelog/45715-deprecation-notice-dropping-support-for-node-js-20),
[public Auth settings](https://github.com/supabase/auth#endpoints) and
[Google configuration](https://supabase.com/docs/guides/auth/social-login/auth-google).
