# Account-bound dashboard and account menu

## Scope

The workspace dashboard and account menu revalidate server-verified public
identity on mount, focus and visible-tab activation. Old private snapshots are
cleared before each read. Neither component reloads the page, remounts authoring
tools or writes session credentials to browser storage.

Dashboard reads bind the expected caller at the same-origin proxy and API, then
check `viewerId`, workspace and book scope and recheck identity before applying
results. Unavailable explicit workspace selections remain explicit; there is no
silent fallback to another workspace. Superseded or unmounted reads cannot
restore an old library, balance, plan, activity, email or administrative link.

Workspace creation uses a synchronous single-flight fence, verified expected
caller before dispatch and after confirmation, and the existing idempotency
transport. A focus refresh cannot silently retry the write or unlock a second
write while the first is pending. Same-account workspace-name drafts survive
rechecks; another account gets the default, not the previous account's draft.
A superseded creation reply rechecks only the current account's library before
another creation is possible; it does not navigate using the old reply or retry
the write. This also closes a focus-read-before-create-completion race.

Administrative access remains allowlist-only. An unavailable/mismatched role
response never preserves a previous administrator link. Logout binds its expected
caller before signing out, fences late UI results and checks for a now-active
session before navigating. These checks do not make concurrent cookie writes
across independent tabs atomic or cancel a server operation already accepted.

## Verification

The dedicated mounted fixture exercises the actual React components with held
responses, same-workspace account changes, identity failures, old role replies,
duplicate creation, in-flight replacement and unmount cleanup. It uses synthetic
identity responses, not a claim that the human's Google account was switched.
Proxy/API tests separately verify that mismatched expected callers never reach
read/write/sign-out handlers. Native and production acceptance results belong
in the dated shared handoff with the exact source tree and receipts.

## Boundaries

No paid provider calls, credit grants, Stripe activation, live DDL, deployment,
retailer submissions or mobile work are part of this change. Paid provider
acceptance and total-spend reconciliation remain separate release gates.
