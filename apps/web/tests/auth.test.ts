import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { NextRequest, type NextResponse } from "next/server";
import { POST } from "../app/api/auth/[action]/route";
import { GET as session } from "../app/api/auth/session/route";
import { GET as backendGet, POST as backendPost } from "../app/api/backend/[...path]/route";
import { GET as callback } from "../app/auth/callback/route";
import { safeNext, sameOrigin } from "../lib/auth/policy";
import { appOrigin } from "../lib/auth/server";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const user = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "author@example.test", app_metadata: {}, user_metadata: { display_name: "Test author" }, created_at: "2026-01-01T00:00:00Z" };
const token = (expires = 3600) => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + expires, aud: "authenticated" })).toString("base64url")}.fixture-signature`;
const authSession = (expires = 3600) => ({ access_token: token(expires), refresh_token: "fixture-refresh-token", token_type: "bearer", expires_in: expires, expires_at: Math.floor(Date.now() / 1000) + expires, user });
let provider: (url: URL, init?: RequestInit) => Response | Promise<Response>;
const calls: { url: string; headers: Headers }[] = [];

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: "test", APP_URL: "http://localhost:3000", SUPABASE_URL: "http://auth.example.test", SUPABASE_ANON_KEY: "fixture-anon-key", API_URL: "http://api.example.test" });
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  calls.length = 0;
  provider = (url) => {
    if (url.pathname === "/auth/v1/token") return Response.json(authSession());
    if (url.pathname === "/auth/v1/user") return Response.json(user);
    if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    if (url.pathname === "/auth/v1/recover") return Response.json({});
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, headers: new Headers(init?.headers) });
    return provider(url, init);
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

function request(action: string, body: unknown, cookie?: string, origin = "http://localhost:3000") {
  return new NextRequest(`http://localhost:3000/api/auth/${action}`, { method: "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
}
const invoke = (action: string, body: unknown, cookie?: string) => POST(request(action, body, cookie), { params: Promise.resolve({ action }) });
const cookies = (response: NextResponse) => response.cookies.getAll().map(({ name, value }) => `${name}=${value}`).join("; ");
const login = () => invoke("login", { email: user.email, password: "fixture-password" });

test("redirects stay inside author routes and same-origin is required", () => {
  for (const path of ["https://evil.test", "//evil.test", "/\\evil.test", "/%5cevil.test", "/%0aevil", "/auth/callback", "/api/backend/v1/books"]) assert.equal(safeNext(path), "/dashboard");
  assert.equal(safeNext("/books/123?tab=writing"), "/books/123?tab=writing");
  assert.equal(safeNext("/admin"), "/admin");
  assert.equal(sameOrigin(request("login", {}), "http://localhost:3000"), true);
  assert.equal(sameOrigin(request("login", {}, undefined, "http://evil.test"), "http://localhost:3000"), false);
});

test("local auth keeps the active development origin instead of a stale APP_URL port", () => {
  assert.equal(appOrigin(new NextRequest("http://127.0.0.1:3001/books/new")), "http://localhost:3001");
});

test("login returns minimal identity, HttpOnly cookies, no tokens in JSON, no caching", async () => {
  const response = await login();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.id, user.id);
  assert.equal(body.redirectTo, "/dashboard");
  assert.ok(!JSON.stringify(body).includes("token"));
  assert.ok(response.cookies.getAll().length > 0);
  for (const cookie of response.cookies.getAll()) { assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, "lax"); }
  assert.match(response.headers.get("cache-control")!, /no-store/);
});

test("production cookies are Secure and redirect origin is configured", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  const response = await login();
  assert.equal(response.status, 200);
  assert.ok(response.cookies.getAll().every((cookie) => cookie.secure));
  delete process.env.APP_URL;
  assert.equal((await login()).status, 503);
});

test("session endpoint verifies identity with provider and rejects an anonymous request", async () => {
  assert.equal((await session(new NextRequest("http://localhost:3000/api/auth/session"))).status, 401);
  const response = await login();
  const verified = await session(new NextRequest("http://localhost:3000/api/auth/session", { headers: { cookie: cookies(response) } }));
  assert.equal(verified.status, 200);
  assert.ok(calls.some((call) => call.url.endsWith("/auth/v1/user")));
  assert.deepEqual((await verified.json()).user, { id: user.id, email: user.email, displayName: "Test author" });
});

test("cross-site and malformed credentials are rejected before contacting the provider", async () => {
  assert.equal((await POST(request("login", {}, undefined, "https://evil.test"), { params: Promise.resolve({ action: "login" }) })).status, 403);
  assert.equal((await invoke("signup", { email: "bad", password: "short" })).status, 422);
  assert.equal(calls.length, 0);
});

test("confirmation-required signup never pretends the user has signed in", async () => {
  provider = () => Response.json({ ...user, identities: [] });
  const response = await invoke("signup", { name: "Test author", email: user.email, password: "fixture-password" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.confirmationRequired, true);
  assert.equal(body.redirectTo, undefined);
});

test("BFF forwards only the verified session token, not caller authorization or service secrets", async () => {
  const signedIn = await login();
  provider = (url, init) => {
    if (url.pathname === "/auth/v1/user") return Response.json(user);
    assert.equal(url.href, "http://api.example.test/v1/books?workspaceId=fixture");
    const headers = new Headers(init?.headers);
    assert.match(headers.get("authorization")!, /^Bearer /);
    assert.notEqual(headers.get("authorization"), "Bearer forged");
    assert.equal(headers.get("x-service-token"), null);
    assert.equal(headers.get("cookie"), null);
    return Response.json({ books: [] });
  };
  const response = await backendGet(new NextRequest("http://localhost:3000/api/backend/v1/books?workspaceId=fixture", { headers: { cookie: cookies(signedIn), authorization: "Bearer forged", "x-service-token": "forged" } }), { params: Promise.resolve({ path: ["v1", "books"] }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { books: [] });
  assert.match(response.headers.get("cache-control")!, /no-store/);
});

test("BFF rejects anonymous writes, cross-site writes and service-only routes", async () => {
  const context = { params: Promise.resolve({ path: ["v1", "books"] }) };
  assert.equal((await backendPost(request("x", {}), context)).status, 401);
  assert.equal((await backendPost(request("x", {}, undefined, "https://evil.test"), context)).status, 403);
  assert.equal((await backendGet(new NextRequest("http://localhost:3000/api/backend/v1/credits/deduct"), { params: Promise.resolve({ path: ["v1", "credits", "deduct"] }) })).status, 404);
});

test("Google sign-in uses the active app origin and Supabase callback flow", async () => {
  const response = await invoke("google", { next: "/dashboard" });
  const body = await response.json();
  assert.equal(response.status, 200);
  const redirect = new URL(body.redirectTo);
  assert.equal(redirect.origin, "http://auth.example.test");
  assert.equal(redirect.pathname, "/auth/v1/authorize");
  assert.equal(redirect.searchParams.get("provider"), "google");
  assert.equal(redirect.searchParams.get("redirect_to"), "http://localhost:3000/auth/callback?next=%2Fdashboard&from=google");
});

test("BFF accepts empty streamed actions but rejects non-JSON payloads", async () => {
  const signedIn = await login();
  let forwards = 0;
  provider = (url, init) => {
    if (url.pathname === "/auth/v1/user") return Response.json(user);
    forwards++;
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get("content-type"), null);
    return Response.json({ status: "accepted" });
  };
  const context = { params: Promise.resolve({ path: ["v1", "ai", "suggestions", "fixture", "apply"] }) };
  const headers = { cookie: cookies(signedIn), origin: "http://localhost:3000" };
  const empty = new NextRequest("http://localhost:3000/api/backend/v1/ai/suggestions/fixture/apply", {
    method: "POST", headers, body: new Uint8Array(0),
  });
  assert.ok(empty.body, "exercise a present but empty request stream");
  assert.equal((await backendPost(empty, context)).status, 200);
  const invalid = new NextRequest(empty.url, { method: "POST", headers, body: "not json" });
  assert.equal((await backendPost(invalid, context)).status, 415);
  assert.equal(forwards, 1);
});

test("expired sessions refresh in the server and return replacement HttpOnly cookies", async () => {
  provider = () => Response.json(authSession(-10));
  const signedIn = await login();
  provider = (url) => url.pathname === "/auth/v1/token" ? Response.json(authSession()) : Response.json(user);
  const response = await session(new NextRequest("http://localhost:3000/api/auth/session", { headers: { cookie: cookies(signedIn) } }));
  assert.equal(response.status, 200);
  assert.ok(calls.some((call) => call.url.includes("grant_type=refresh_token")));
  assert.ok(response.cookies.getAll().some((cookie) => cookie.httpOnly && cookie.value));
});

test("logout revokes the local provider session and clears the auth cookies", async () => {
  const signedIn = await login();
  const response = await invoke("logout", {}, cookies(signedIn));
  assert.equal(response.status, 200);
  assert.ok(calls.some((call) => call.url.includes("/auth/v1/logout")));
  assert.ok(response.cookies.getAll().some((cookie) => cookie.maxAge === 0));
});

test("reset requires an authenticated session and recovery response does not enumerate accounts", async () => {
  assert.equal((await invoke("reset-password", { password: "fixture-new-password" })).status, 401);
  const response = await invoke("forgot-password", { email: "unknown@example.test" });
  assert.equal(response.status, 200);
  assert.match((await response.json()).message, /^If this address/);
});

test("callback failure is a fixed login URL, never an external next target", async () => {
  const response = await callback(new NextRequest("http://localhost:3000/auth/callback?next=https://evil.test"));
  assert.equal(response.headers.get("location"), "http://localhost:3000/login?error=confirmation");
});

test("Google OAuth callback errors use a fixed recovery state and never reflect provider text", async () => {
  const response = await callback(new NextRequest("http://localhost:3000/auth/callback?from=google&error=server_error&error_code=provider_disabled&error_description=secret-provider-detail&next=https://evil.test"));
  assert.equal(response.headers.get("location"), "http://localhost:3000/login?error=oauth&next=%2Fdashboard");
  assert.equal(calls.length, 0);
});

test("non-Google auth callback errors retain the email-confirmation recovery flow", async () => {
  const response = await callback(new NextRequest("http://localhost:3000/auth/callback?error=access_denied&error_code=expired_confirmation"));
  assert.equal(response.headers.get("location"), "http://localhost:3000/login?error=confirmation");
});
