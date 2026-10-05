import assert from "node:assert/strict";
import { test } from "node:test";
import { resetEnvCache } from "@bookworm/config";
import { boundedSupabaseFetch, defaultSupabaseFactory } from "./lib/supabase.js";

const fixture = {
  SUPABASE_URL: "https://supabase.example.invalid", SUPABASE_ANON_KEY: "synthetic-anon",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service", REDIS_URL: "redis://example.invalid",
  QDRANT_URL: "https://qdrant.example.invalid", NODE_ENV: "production",
};
async function withFixture(run: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(fixture).map(key => [key, process.env[key]]));
  Object.assign(process.env, fixture); resetEnvCache();
  try { await run(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } resetEnvCache(); }
}

test("custom Supabase transport reaches SDK RPC, scoped reads and private Storage with correct credentials", async () => withFixture(async () => {
  for (const token of [undefined, "synthetic-author-session"]) {
    const calls: { url: string; method: string; headers: Headers }[] = [];
    const transport: typeof fetch = async (input, init) => {
      const url = String(input), method = init?.method ?? "GET", headers = new Headers(init?.headers);
      calls.push({ url, method, headers });
      assert.equal(headers.get("apikey"), token ? fixture.SUPABASE_ANON_KEY : fixture.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(headers.get("authorization"), `Bearer ${token ?? fixture.SUPABASE_SERVICE_ROLE_KEY}`);
      if (url.includes("/rpc/")) return Response.json(true);
      if (url.includes("/rest/v1/ai_jobs")) return Response.json([{ id: "synthetic-job" }]);
      assert(url.startsWith(`${fixture.SUPABASE_URL}/storage/v1/object/`));
      if (method === "POST") { assert.equal(headers.get("x-upsert"), "false"); return Response.json({ Key: "book-assets/private/narration/fixture.pcm", Id: "synthetic-asset" }); }
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "audio/pcm" } });
    };
    const sb = defaultSupabaseFactory(token, transport);
    assert.equal((await sb.rpc("claim_funded_dispatch", { p_job_id: "synthetic-job" })).data, true);
    assert.deepEqual((await sb.from("ai_jobs").select("id").eq("id", "synthetic-job").maybeSingle()).data, { id: "synthetic-job" });
    assert.equal((await sb.storage.from("book-assets").upload("private/narration/fixture.pcm", new Uint8Array([1, 2, 3, 4]), { upsert: false })).error, null);
    const downloaded = await sb.storage.from("book-assets").download("private/narration/fixture.pcm");
    assert.equal(downloaded.error, null); assert.equal(downloaded.data?.size, 4);
    assert.equal(calls.length, 4); assert.equal(calls[0]!.method, "POST");
  }
}));

test("custom private transport never retries ambiguous mutations or transient reads", async () => withFixture(async () => {
  for (const kind of ["rpc-network", "rpc-http", "read-http"]) {
    let calls = 0;
    const transport: typeof fetch = async () => {
      calls++;
      if (kind === "rpc-network") throw new Error("Synthetic lost response after server commit");
      // A second request deliberately succeeds: the test must detect an SDK
      // retry, not merely count repeated failure responses after backoff.
      return calls === 1 ? Response.json({ message: "Synthetic unavailable" }, { status: 503, headers: { "retry-after": "0" } }) : Response.json([]);
    };
    const sb = defaultSupabaseFactory(undefined, transport);
    const result = kind === "read-http" ? await sb.from("ai_jobs").select("id") : await sb.rpc("claim_funded_dispatch", {});
    assert.equal(calls, 1, kind); assert(result.error, kind);
  }
}));

test("private transport rejects oversized declared and chunked SDK bodies before buffering them", async () => withFixture(async () => {
  for (const kind of ["storage-declared", "storage-chunked", "rpc-declared"]) {
    let calls = 0, cancelled = 0, chunks = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const transport: typeof fetch = async (_input, init) => {
      calls++; assert.equal(init?.redirect, "error"); assert(init?.signal);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { chunks++; controller.enqueue(kind === "storage-chunked" ? chunk : new Uint8Array([1])); },
        cancel() { cancelled++; },
      });
      return new Response(body, { headers: kind === "storage-chunked" ? {} : { "content-length": String((kind === "rpc-declared" ? 16 : 12) * 1024 * 1024 + 1) } });
    };
    const sb = defaultSupabaseFactory(undefined, boundedSupabaseFetch(new AbortController().signal, transport));
    const operation = kind === "rpc-declared" ? sb.rpc("claim_quoted_narration_job", {}) : sb.storage.from("book-assets").download("private/narration/fixture.pcm");
    // The installed SDK returns fetch failures as error results, but rejects
    // body-consumption failures after headers. Both must remain one attempt.
    if (kind === "storage-chunked") await assert.rejects(Promise.resolve(operation), /worker byte limit/);
    else { const result = await operation; assert(result.error, kind); assert.equal(result.data, null); }
    assert.equal(calls, 1); assert.equal(cancelled, 1);
    assert(chunks <= 14, "unbounded input was consumed");
  }
}));

test("the private deadline covers stalled SDK Storage bodies, not only headers", async context => withFixture(async () => {
  const deadline = new AbortController();
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => { assert.equal(milliseconds, 60_000); return deadline.signal; });
  let began = () => {}; const started = new Promise<void>(resolve => { began = resolve; });
  let calls = 0, cancelled = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return new Response(new ReadableStream({ pull() { began(); }, cancel() { cancelled++; } }, { highWaterMark: 0 }));
  };
  const sb = defaultSupabaseFactory(undefined, boundedSupabaseFetch(new AbortController().signal, transport));
  const pending = sb.storage.from("book-assets").download("private/narration/fixture.pcm");
  // SDK download builders are lazy; awaiting starts consumption.
  const completed = Promise.resolve(pending); await started;
  deadline.abort(new DOMException("Synthetic private deadline", "TimeoutError"));
  await assert.rejects(completed, { name: "TimeoutError" });
  assert.equal(calls, 1); assert.equal(cancelled, 1);
}));

test("shutdown and caller abort cancel SDK requests without another private attempt", async () => withFixture(async () => {
  for (const kind of ["shutdown", "caller", "already-stopped"]) {
    const shutdown = new AbortController(), caller = new AbortController();
    let began = () => {}; const started = new Promise<void>(resolve => { began = resolve; });
    let calls = 0;
    const transport: typeof fetch = async (_input, init) => {
      calls++; began(); assert(init?.signal);
      return new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      });
    };
    if (kind === "already-stopped") shutdown.abort();
    const sb = defaultSupabaseFactory(undefined, boundedSupabaseFetch(shutdown.signal, transport));
    const completed = Promise.resolve(sb.rpc("claim_funded_dispatch", {}).abortSignal(caller.signal));
    if (kind !== "already-stopped") { await started; (kind === "caller" ? caller : shutdown).abort(); }
    const result = await completed; assert(result.error); assert.equal(calls, kind === "already-stopped" ? 0 : 1);
  }
}));

test("private transport preserves Request aborts, native methods and empty responses", async () => {
  const caller = new AbortController(); let calls = 0;
  const request = new Request(`${fixture.SUPABASE_URL}/rest/v1/rpc/fixture`, { method: "POST", signal: caller.signal });
  const transport: typeof fetch = async (input, init) => { calls++; assert.equal(input, request); assert.equal(init?.redirect, "error"); return new Response(null, { status: 204 }); };
  const fetcher = boundedSupabaseFetch(new AbortController().signal, transport);
  assert.equal((await fetcher(request)).status, 204);
  caller.abort(); await assert.rejects(fetcher(request), { name: "AbortError" }); assert.equal(calls, 1);
});
