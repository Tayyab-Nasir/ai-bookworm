import { NextResponse, type NextRequest } from "next/server";
import { appOrigin, authError, AuthConfigurationError, createAuthContext } from "../../../../lib/auth/server";
import { publicUser, safeNext, sameOrigin, validEmail, validPassword } from "../../../../lib/auth/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  let auth: ReturnType<typeof createAuthContext> | undefined;
  try {
    const origin = appOrigin(request);
    if (!sameOrigin(request, origin)) return authError(403, "This request must come from this application.", "invalid_origin");
    const { action } = await context.params;
    if (!["login", "signup", "logout", "forgot-password", "reset-password", "google"].includes(action)) return authError(404, "Unknown authentication action.");
    if (!request.headers.get("content-type")?.startsWith("application/json")) return authError(415, "Send a JSON request.");
    const raw = await request.text();
    if (raw.length > 8192) return authError(413, "Request is too large.");
    let body: Record<string, unknown>;
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      body = value;
    } catch { return authError(400, "Invalid JSON request."); }
    auth = createAuthContext(request);
    const { supabase, finish } = auth;
    const next = safeNext(body.next);
    const callback = `${origin}/auth/callback?next=${encodeURIComponent(next)}`;

    if (action === "logout") {
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error && error.status !== 401 && error.status !== 403) return finish(authError(503, "Could not sign out. Please retry."));
      return finish(NextResponse.json({ ok: true, redirectTo: "/login" }));
    }
    if (action === "google") {
      const { data, error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: callback, skipBrowserRedirect: true } });
      if (error || !data.url) return finish(authError(503, "Google sign-in is unavailable. Try email sign-in or contact support."));
      return finish(NextResponse.json({ redirectTo: data.url }));
    }
    if (action === "reset-password") {
      if (!validPassword(body.password)) return finish(authError(422, "Use a password between 8 and 128 characters."));
      const { data: identity, error: identityError } = await supabase.auth.getUser();
      if (identityError || !identity.user) return finish(authError(401, "Open a fresh password-reset email before setting a password."));
      const { error } = await supabase.auth.updateUser({ password: body.password });
      if (error) return finish(authError(error.status === 429 ? 429 : 422, "Password could not be updated. Choose a different password or request a new reset link."));
      return finish(NextResponse.json({ ok: true, redirectTo: "/dashboard" }));
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : body.email;
    if (!validEmail(email)) return finish(authError(422, "Enter a valid email address."));
    if (action === "forgot-password") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/callback?next=/settings/password` });
      if (error?.status === 429) return finish(authError(429, "Too many requests. Wait before requesting another email."));
      if (error && (!error.status || error.status >= 500)) return finish(authError(503, "Email delivery is temporarily unavailable. Please retry."));
      // Do not expose whether an address has an account.
      return finish(NextResponse.json({ message: "If this address has an account, a password-reset email is on its way." }));
    }
    if (!validPassword(body.password)) return finish(authError(422, "Use a password between 8 and 128 characters."));
    if (action === "signup") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 120) return finish(authError(422, "Enter your name (up to 120 characters)."));
      const { data, error } = await supabase.auth.signUp({ email, password: body.password, options: { data: { display_name: name }, emailRedirectTo: callback } });
      if (error) return finish(authError(error.status === 429 ? 429 : 422, error.status === 429 ? "Too many attempts. Please wait and retry." : "Account creation could not be completed. Check your details or try signing in."));
      return finish(NextResponse.json(data.session && data.user
        ? { user: publicUser(data.user), redirectTo: next }
        : { confirmationRequired: true, message: "Check your email to confirm your account. If you already have an account, sign in instead." }));
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: body.password });
    if (error || !data.user) return finish(authError(error?.status === 429 ? 429 : 401, error?.status === 429 ? "Too many attempts. Please wait and retry." : "Sign-in failed. Check your email/password and confirm your email if required."));
    return finish(NextResponse.json({ user: publicUser(data.user), redirectTo: next }));
  } catch (error) {
    const response = authError(503, error instanceof AuthConfigurationError ? error.message : "Authentication is temporarily unavailable. Please retry.");
    return auth ? auth.finish(response) : response;
  }
}
