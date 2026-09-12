# Google sign-in setup

Google sign-in is implemented in the Bookworm web app, and new Auth identities
now receive a `public.profiles` row automatically. The live Supabase project
still reports the Google provider as disabled because the app owner has not yet
supplied a Google OAuth client.

Bookworm customers do **not** create OAuth credentials. The Bookworm operator
creates one Google OAuth client for the application; customers then choose their
normal Google account on Google's consent screen.

## One-time operator configuration

1. In Google Cloud Console, create or select the Bookworm project, configure the
   OAuth consent screen, and create an OAuth client of type **Web application**.
2. Add these authorized JavaScript origins:
   - `http://localhost:3001` for the current local web app.
   - The final production origin, for example `https://app.example.com`.
3. Add this exact authorized redirect URI:
   - `https://cyhqtwndadlyzpeatxws.supabase.co/auth/v1/callback`
4. In Supabase Dashboard, open **Authentication → Sign In / Providers → Google**.
   Enable Google and enter the Google client ID and client secret. Store the
   secret only in the provider settings; never commit it or paste it into chat.
5. In **Authentication → URL Configuration**, set the production Site URL and
   allow these redirects while they are in use:
   - `http://localhost:3001/auth/callback`
   - `https://app.example.com/auth/callback` (replace with the real origin)
6. Test both a new Google account and a returning account. Confirm that the user
   reaches `/dashboard`, has exactly one `profiles` row, can create a workspace,
   refresh the session, and sign out.

The local host must be consistent during a test. Use `localhost:3001`; do not
switch between `localhost` and `127.0.0.1` mid-flow because OAuth redirect URLs
are exact-origin security boundaries.
