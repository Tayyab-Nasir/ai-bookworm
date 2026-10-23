# AI Bookworm mobile companion

This is an unfinished native companion to the web authoring application, not a
release-ready Android/iOS app. The current authentication and file workflows
replace the original disconnected mobile scaffolding. Stripe remains deferred.

## Implemented and checked locally

- Supabase login, signup, password recovery and Google sign-in entry points.
  Session and PKCE data use platform secure storage, not preferences.
- Membership-validated workspace selection/creation and account-scoped navigation.
  Account/workspace changes invalidate old API requests and private screens.
- Bounded JSON transport, HTTPS origin validation, redirect refusal and refreshed
  access tokens within the same authenticated scope.
- Actual document/image selection, explicit upload confirmation, SHA-256 checks,
  private non-overwriting signed uploads and server scan verification.
- Secure retry identity survives restart. Reservation/transfer/confirmation reply
  loss recovers the original file; scanner retries do not reserve or transfer
  again. Status checks are read-only. Discard removes local retry metadata only.
- File access from Home, including workspaces without books. Narrow-screen and
  enlarged-text tests cover sign-in and the file flow.

The tests use synthetic accounts, fake API/Storage transports and the real Dart
Storage SDK serializer. They do not establish real device picker, Keychain,
Android keystore, Google callback or hosted Supabase acceptance.

## Configuration boundary

The eventual device build requires these compile-time values:

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | Supabase project HTTPS origin |
| `SUPABASE_PUBLISHABLE_KEY` | Public publishable key or legacy `anon` key only |
| `API_BASE_URL` | Bookworm Fastify API origin, not the web app or private AI service |
| `WEB_APP_URL` | Bookworm web origin, distinct from the API |

Never embed OpenAI, service-role, Stripe or OAuth client secrets in the app.
Remote HTTP is rejected; local HTTP is debug-only. Source declares the exact
PKCE callback `com.bookworm.ai://login-callback`. An operator must separately
configure and verify its Supabase allowlist; source declarations are not proof
of hosted configuration. Customers need no OAuth credentials of their own.

## Local verification

From `apps/mobile`, with Flutter available:

```text
flutter pub get
flutter analyze --no-pub
flutter test --no-pub --coverage --timeout 25s
```

The October 23 checkpoint uses Flutter 3.47.5 / Dart 3.13.4. A Windows-target
debug asset/kernel bundle (`flutter build bundle --no-pub
--target-platform=windows-x64`) compiles; this is not a Windows executable or an
Android/iOS package. Android bundle generation currently fails on the local
machine because the Android SDK is absent.

## Remaining work — do not bypass these gates

1. Complete book creation/import and the mobile editor using current document
   endpoints, preserved rich nodes, expected versions and save recovery. The
   legacy reader's whole-chapter `replace_text` request is incompatible with
   the node-based operation contract.
2. Replace legacy AI calls with the existing paid quote, consent, acceptance,
   original-job recovery and review/apply contracts. Never enable free generation
   or forward an app token to a private AI service.
3. Replace legacy publishing calls with saved editions/render/preflight pins,
   immutable package history and original-request recovery.
4. Finish Android/iOS project scaffolding. Existing Gradle files and plist alone
   are insufficient: platform runners/wrappers/resources are missing. Use the
   correct SDKs, release signing and real device tests before distribution.
5. Verify real native authentication, secure persistence, file selection and
   upload/import against an authorized isolated Supabase environment. No hosted
   migrations, OAuth changes, provider spend, deployment or store submission are
   implied by these local checks.

Cross-agent continuation: repository `docs/AGENT_HANDOFF.md`, the main Codex
handoff in `C:/Users/Asus/Memory-Ai`, and
`Codex Sessions/2026-10/2026-10-23-mobile-files-continuation.md`.
