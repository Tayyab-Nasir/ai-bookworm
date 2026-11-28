# Google sign-in setup

The Google sign-in flow is implemented in the Bookworm web app. A profile
bootstrap migration is present, but new and returning hosted accounts still
need end-to-end acceptance. A read-only check at `2026-10-06T03:44:48.682Z`
reported the Google provider disabled in Supabase project
`cyhqtwndadlyzpeatxws`. Configuration can change; verify it again after setup.

Bookworm customers do **not** create OAuth credentials. The Bookworm operator
creates one Google OAuth client for the application; customers then choose their
normal Google account on Google's consent screen.

Before creating an OAuth URL or PKCE state, the app checks Supabase Auth's
public settings using only the configured public key. Disabled, unknown or
unavailable Google settings leave the user in the app with a safe retryable
message. Callback failures are also recovered without echoing provider error
text. Email/password signup with a Gmail address is a separate flow and does
not require Google OAuth; confirmation and reset email delivery must be tested
separately. Neither controlled tests nor public settings prove a successful
hosted Google login.

## One-time operator configuration

1. Select the operator-owned Google Cloud project `ai-bookworm` (number
   `1072603248635`). In **Google Auth Platform**, configure the app name
   **AI Bookworm**, a user support address, developer contact and **External**
   audience. Review Google's User Data Policy before accepting it. Start in
   **Testing** while the build is being completed; do not publish just to test.
   Add only approved test users. Request only `openid`, email and profile:
   Bookworm login does not need access to Gmail messages, Drive or Contacts.
   Then create an OAuth client of type **Web application**.
2. Add these authorized JavaScript origins:
   - `http://localhost:3001` for the current local web app.
   - The final production origin, for example `https://app.example.com`.
3. Add this exact authorized redirect URI:
   - `https://cyhqtwndadlyzpeatxws.supabase.co/auth/v1/callback`
4. In the named Supabase Dashboard project, open
   **Authentication → Sign In / Providers → Google**.
   Enable Google and enter the Google client ID and client secret. Store the
   secret only in the provider settings; never commit it or paste it into chat.
5. In **Authentication → URL Configuration**, set the production Site URL and
   allow these redirects while they are in use:
   - `http://localhost:3001/auth/callback`
   - `https://app.example.com/auth/callback` (replace with the real origin)
6. Use an approved test account. Test both a new Google account and a returning
   account. Confirm that the user
   reaches `/dashboard`, has exactly one `profiles` row, can create a workspace,
   refresh the session, and sign out.

The local host must be consistent during a test. Use `localhost:3001`; do not
switch between `localhost` and `127.0.0.1` mid-flow because OAuth redirect URLs
are exact-origin security boundaries.

The two callbacks serve different purposes: **Google's authorized redirect**
is the Supabase `/auth/v1/callback` URI above; **Supabase's redirect allowlist**
contains Bookworm's `/auth/callback`. The web server's `APP_URL` must match the
chosen Bookworm origin. Do not use wildcard redirects or enable skip-nonce
checks to work around a mismatch. Do not use an expiring preview hostname as
the final production Site URL.

Keep the client secret out of `.env` files, screenshots, Git, Obsidian and chat.
The operator should enter it directly in Supabase's Google provider settings.
For public customer access, review Google's production/brand requirements and
move out of testing only when the product and consent configuration are ready.
Separate native mobile client IDs and deep-link acceptance are still required
for native Google login; a web client alone is not mobile acceptance.

Primary reference: [Supabase Google sign-in configuration](https://supabase.com/docs/guides/auth/social-login/auth-google).
