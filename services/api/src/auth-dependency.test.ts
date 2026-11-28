import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import { resetEnvCache } from "@bookworm/config";
import { makeAuthPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { defaultSupabaseFactory, type SupabaseFactory } from "./lib/supabase.js";

const TOKEN = "synthetic-private-session";
const PRIVATE = "private-upstream-detail-never-expose";
const fixture = {
  SUPABASE_URL: "https://supabase.example.invalid", SUPABASE_ANON_KEY: "synthetic-anon",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service", REDIS_URL: "redis://example.invalid",
  QDRANT_URL: "https://qdrant.example.invalid", NODE_ENV: "production",
};

async function withFixture(run: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(fixture).map(key => [key, process.env[key]]));
  Object.assign(process.env, fixture); resetEnvCache();
  try { await run(); }
  finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetEnvCache();
  }
}

async function authApp(factory: SupabaseFactory) {
  const logs: string[] = []; let entered = 0;
  const stream = new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } });
  const app = Fastify({ logger: { level: "error", stream } });
  await app.register(errorHandlerPlugin); await app.register(makeAuthPlugin(factory));
  app.get("/v1/verified", async request => { entered++; return { userId: request.userId, userToken: request.userToken }; });
  app.get("/v1/service", { config: { serviceAuth: true } }, async () => ({ ownAuth: true }));
  await app.ready();
  return { app, logs, entered: () => entered };
}

function assertPrivateFailure(response: { statusCode: number; body: string; json(): any }, status: number, logs: string[]) {
  assert.equal(response.statusCode, status);
  assert.equal(response.json().error.message, status === 401 ? "invalid token" : "Authentication service is temporarily unavailable.");
  assert(!response.body.includes(PRIVATE)); assert(!response.body.includes(TOKEN));
  assert(!logs.join("").includes(PRIVATE)); assert(!logs.join("").includes(TOKEN));
}

test("auth preserves remotely verified identity and never authenticates from token shape", async () => {
  const calls: string[] = [];
  const { app, entered } = await authApp((token => ({ auth: { getUser: async (supplied: string) => {
    assert.equal(supplied, token); calls.push(supplied);
    return { data: { user: { id: "synthetic-user" } }, error: null };
  } } })) as SupabaseFactory);
  try {
    const response = await app.inject({ url: "/v1/verified", headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { userId: "synthetic-user", userToken: TOKEN });
    assert.deepEqual(calls, [TOKEN]); assert.equal(entered(), 1);
  } finally { await app.close(); }
});

test("auth rejects missing or empty bearer credentials before any client, preserving service-route auth", async () => {
  let calls = 0;
  const { app } = await authApp((() => { calls++; throw new Error(PRIVATE); }) as SupabaseFactory);
  try {
    for (const authorization of [undefined, "Bearer ", "Bearer   "]) {
      assert.equal((await app.inject({ url: "/v1/verified", headers: authorization ? { authorization } : {} })).statusCode, 401);
    }
    assert.equal((await app.inject({ url: "/v1/service" })).statusCode, 200); assert.equal(calls, 0);
  } finally { await app.close(); }
});

for (const status of [400, 401, 403]) test(`auth retains 401 for remote credential denial ${status}`, async () => {
  const { app, logs, entered } = await authApp((() => ({ auth: { getUser: async () => ({ data: { user: null }, error: { name: "AuthApiError", status, message: PRIVATE } }) } })) as SupabaseFactory);
  try { assertPrivateFailure(await app.inject({ url: "/v1/verified", headers: { authorization: `Bearer ${TOKEN}` } }), 401, logs); assert.equal(entered(), 0); }
  finally { await app.close(); }
});

for (const error of [
  { name: "AuthRetryableFetchError", status: 0, message: PRIVATE },
  { name: "AuthApiError", status: 429, message: PRIVATE },
  { name: "AuthRetryableFetchError", status: 503, message: PRIVATE },
  { name: "AuthApiError", status: 500, message: PRIVATE },
  { name: "AuthUnknownError", message: PRIVATE },
]) test(`auth maps dependency ${error.name}/${error.status ?? "unknown"} to private-safe 503`, async () => {
  const { app, logs, entered } = await authApp((() => ({ auth: { getUser: async () => ({ data: { user: null }, error }) } })) as SupabaseFactory);
  try { assertPrivateFailure(await app.inject({ url: "/v1/verified", headers: { authorization: `Bearer ${TOKEN}` } }), 503, logs); assert.equal(entered(), 0); }
  finally { await app.close(); }
});

test("auth thrown dependency errors do not expose or log private upstream details", async () => {
  const { app, logs, entered } = await authApp((() => ({ auth: { getUser: async () => { throw new Error(`${PRIVATE}: ${TOKEN}`); } } })) as unknown as SupabaseFactory);
  try { assertPrivateFailure(await app.inject({ url: "/v1/verified", headers: { authorization: `Bearer ${TOKEN}` } }), 503, logs); assert.equal(entered(), 0); }
  finally { await app.close(); }
});

test("auth rejects malformed successful user identity as unavailable, not authenticated", async () => {
  const { app, logs, entered } = await authApp((() => ({ auth: { getUser: async () => ({ data: { user: { private: PRIVATE } }, error: null }) } })) as unknown as SupabaseFactory);
  try { assertPrivateFailure(await app.inject({ url: "/v1/verified", headers: { authorization: `Bearer ${TOKEN}` } }), 503, logs); assert.equal(entered(), 0); }
  finally { await app.close(); }
});

test("auth uses the installed SDK with scoped credentials and bounded nonredirecting fetch", async context => withFixture(async () => {
  let calls = 0; let supplied: RequestInit | undefined;
  context.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++; supplied = init;
    assert.equal(String(input), `${fixture.SUPABASE_URL}/auth/v1/user`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), fixture.SUPABASE_ANON_KEY); assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
    return Response.json({ id: "synthetic-user" });
  });
  const { app } = await authApp(defaultSupabaseFactory);
  try {
    const response = await app.inject({ url: "/v1/verified", headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.statusCode, 200); assert.equal(calls, 1);
    assert.equal(supplied?.redirect, "error"); assert(supplied?.signal); assert.equal(supplied.signal.aborted, false);
  } finally { await app.close(); }
}));

function syntheticDeadline(context: TestContext) {
  const deadline = new AbortController(); const original = AbortSignal.timeout; const budgets: number[] = [];
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    budgets.push(milliseconds); return milliseconds === 12_000 ? deadline.signal : original(milliseconds);
  });
  return { deadline, budgets };
}

for (const phase of ["headers", "body"] as const) test(`auth absolute deadline aborts stalled SDK ${phase} with one attempt`, async context => withFixture(async () => {
  const { deadline, budgets } = syntheticDeadline(context);
  let began = () => {}; const started = new Promise<void>(resolve => { began = resolve; });
  let calls = 0, cancelled = 0;
  context.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    // The old unbounded implementation fails promptly instead of hanging the RED run.
    if (!init?.signal) { began(); return Response.json({ message: PRIVATE }, { status: 503 }); }
    if (phase === "headers") {
      began(); return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => { cancelled++; reject(signal.reason); }, { once: true });
      });
    }
    return new Response(new ReadableStream({ pull() { began(); }, cancel() { cancelled++; } }, { highWaterMark: 0 }));
  });
  const { app, logs, entered } = await authApp(defaultSupabaseFactory);
  try {
    const pending = app.inject({ url: "/v1/verified", headers: { authorization: `Bearer ${TOKEN}` } });
    await started; deadline.abort(new DOMException(PRIVATE, "TimeoutError"));
    assertPrivateFailure(await pending, 503, logs); assert.equal(calls, 1); assert.equal(cancelled, 1); assert.equal(entered(), 0);
    assert.equal(budgets.filter(value => value === 12_000).length, 1, "one fixed deadline is shared across headers and body");
  } finally { await app.close(); }
}));

test("auth pre-aborted deadline never starts the upstream SDK request", async context => withFixture(async () => {
  const { deadline } = syntheticDeadline(context); deadline.abort(new DOMException(PRIVATE, "TimeoutError"));
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ id: "synthetic-user" }); });
  const { app, logs, entered } = await authApp(defaultSupabaseFactory);
  try { assertPrivateFailure(await app.inject({ url: "/v1/verified", headers: { authorization: `Bearer ${TOKEN}` } }), 503, logs); assert.equal(calls, 0); assert.equal(entered(), 0); }
  finally { await app.close(); }
}));

for (const phase of ["declared", "stream-error"] as const) test(`auth SDK ${phase} body failure stays private-safe and never enters route`, async context => withFixture(async () => {
  let calls = 0, cancelled = 0;
  context.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    if (phase === "declared" && !init?.signal) return Response.json({ message: PRIVATE }, { status: 503 });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { if (phase === "stream-error") controller.error(new Error(`${PRIVATE}: ${TOKEN}`)); },
      cancel() { cancelled++; },
    });
    return new Response(body, { headers: phase === "declared" ? { "content-length": String(16 * 1024 * 1024 + 1) } : {} });
  });
  const { app, logs, entered } = await authApp(defaultSupabaseFactory);
  try {
    assertPrivateFailure(await app.inject({ url: "/v1/verified", headers: { authorization: `Bearer ${TOKEN}` } }), 503, logs);
    assert.equal(calls, 1); assert.equal(entered(), 0); if (phase === "declared") assert.equal(cancelled, 1);
  } finally { await app.close(); }
}));
