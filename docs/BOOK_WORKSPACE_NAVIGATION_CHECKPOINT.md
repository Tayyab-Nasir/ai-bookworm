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
- Frozen committed source `09ba22b4a02dd6e4b14988b905f863303928fbcf`: all 451
  web tests and TypeScript checks pass, with source integrity verified.
- Actual mounted header and existing Book Bible navigation: eight browser
  checks pass, including mobile containment, keyboard dismissal, explicit
  recovery and unsaved manuscript/navigation protection. These are synthetic
  transport checks.
- Isolated production Next build passes on that source. Native author/files
  [CI 39998579555](https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/39998579555)
  passed at 17:59:15 UTC, including full Chromium navigation, production build,
  private processing container builds, native authoring, proofs and packages.

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

The loopback web/API were then refreshed to the new `09ba22b` production source.
The operator's Google session survived. The manuscript reopened at version 2
with all 35 words intact, all workspace links carry the saved workspace, and
the new Book Bible link opens the correct book. Live search found the synthetic
`silver compass` passage and Read cited source returned saved version 2,
characters 1–225. A manual `Mira` character entry with description, source note
and saved-chapter version pin was saved and survived a full reload. These
checks used the real authenticated app and hosted Supabase, with no OpenAI call.

Local receipts are under `.git/bookworm-tracking/`:
`book-navigation-source-20261023.json`, `book-navigation-webverify-20261023.json`,
`book-navigation-build-20261023.json`, and `book-navigation-live-20261023.json`.
The private editor screenshot is `book-navigation-live-editor-20261023.png`.
No account cookies, tokens or personal screenshot pixels belong in Git or Obsidian.

## Remaining work

Current source is pushed and served locally. Supabase remains at the previously
verified 111 migrations; this change adds no migration. Continue with private
processing runtime setup and the remaining hosted/paid-provider acceptance.
Private processing/scanning services and Redis are unavailable locally. Paid
provider acceptance remains stopped for quota/billing, with the original USD5
total ceiling and USD2.50 conservative holds unchanged. Full product acceptance
still requires the gates in `WEB_APP_ACCEPTANCE_2026-10-23.md`.
