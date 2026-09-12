import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export class AuthConfigurationError extends Error {}

export function appOrigin(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return request.nextUrl.origin;
  const configured = process.env.APP_URL;
  if (!configured) throw new AuthConfigurationError("Set APP_URL before deploying authentication.");
  const url = new URL(configured);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new AuthConfigurationError("Invalid APP_URL configuration.");
  return url.origin;
}

export function authError(status: number, message: string, code = "auth_error") {
  return NextResponse.json({ error: { code, message, requestId: crypto.randomUUID() } }, {
    status, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
  });
}

/** Server-only auth: the browser uses same-origin routes, never a Supabase browser client. */
export function createAuthContext(request: NextRequest) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new AuthConfigurationError("Authentication is not configured. Set the server Supabase URL and publishable key.");
  const secure = process.env.NODE_ENV === "production" || request.nextUrl.protocol === "https:";
  const changes = new Map<string, { name: string; value: string; options: CookieOptions }>();
  const cookieHeaders: Record<string, string> = {};
  const supabase = createServerClient(url, key, {
    cookieOptions: { httpOnly: true, secure, sameSite: "lax", path: "/" },
    auth: { detectSessionInUrl: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store", signal: init?.signal ?? AbortSignal.timeout(12_000) }),
    },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies, headers) => {
        Object.assign(cookieHeaders, headers);
        for (const cookie of cookies) {
          request.cookies.set(cookie.name, cookie.value);
          changes.set(cookie.name, cookie);
        }
      },
    },
  });
  function finish(response: NextResponse) {
    for (const { name, value, options } of changes.values()) {
      response.cookies.set(name, value, { ...options, httpOnly: true, secure, sameSite: "lax", path: "/" });
    }
    for (const [name, value] of Object.entries(cookieHeaders)) response.headers.set(name, value);
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("Vary", "Cookie");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
  return { supabase, finish };
}
