# Book workspace navigation and live authoring — 2026-10-23

Book routes now resolve the current authorized book's workspace for Dashboard,
Assets, Workflow, Billing, Analytics and New book navigation. Direct links work
without saved browser preferences. A query preference, old book response or
foreign/malformed book identity cannot select the workspace. Links wait for the
lookup; failures offer explicit reload and workspace selection. Desktop and
mobile use the same scope. The editor also has a direct Book Bible link and a
workspace-scoped Library link.

## Evidence

- Workspace/header component suite: 138 checks pass, including ten new cases
  for canonical scope, delayed responses, malformed identity and all five book
  route wrappers.
- Full web unit suite and TypeScript checks pass.
- Actual mounted header and existing Book Bible navigation: eight browser
  checks pass, including mobile containment, keyboard dismissal, explicit
  recovery and unsaved manuscript/navigation protection. These are synthetic
  transport checks; native CI and updated local production evidence follow.

Before these source changes, refreshed the local runtime to frozen `f8e59fe`.
The real Chrome Google sign-in succeeded and the dashboard loaded without the
earlier unreadable-response error. Through the normal UI, created the operator's
default `My publishing studio` workspace and a clearly labeled synthetic book,
chapter and 35-word manuscript. Its manual save reached version 2. Those hosted
application rows remain available for operator review; no customer manuscript,
paid generation, retailer submission or credit grant was involved.

The actual production login also passed isolated gstack input, navigation,
390px containment and screenshot checks. Its local receipt is
`.git/bookworm-tracking/source-reader-local-gstack-20261023.receipt.json`.
The owned browser process was stopped; no existing cookies or operator secrets
were imported. The shared mobile/config/billing/docs work was preserved.

## Remaining work

Commit and verify this source, refresh only ownership-verified local processes,
then verify manuscript reload, saved Book Bible context and source reading in
the authenticated app. Record native CI results when terminal. Supabase remains
at the previously verified 111 migrations; this change adds no migration.
Private processing/scanning services and Redis are unavailable locally. Paid
provider acceptance remains stopped for quota/billing, with the original USD5
total ceiling and USD2.50 conservative holds unchanged. Full product acceptance
still requires the gates in `WEB_APP_ACCEPTANCE_2026-10-23.md`.
