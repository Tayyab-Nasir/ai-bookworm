import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import type { SupabaseFactory } from "./lib/supabase.js";
import { parseRedisReadinessEndpoint, redisReady } from "./lib/redis-readiness.js";

// This file never reads a local environment file or reaches Supabase. Its
// sockets are disposable loopback test fixtures, not application services.
process.env.NODE_ENV = "production";
Object.assign(process.env, {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_ANON_KEY: "synthetic-anon",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service",
  QDRANT_URL: "http://127.0.0.1:6333",
  REDIS_URL: "redis://127.0.0.1:6379",
});
const { resetEnvCache } = await import("@bookworm/config");
const { healthRoutes } = await import("./routes/health.js");

async function listen(t: TestContext, server: net.Server, host = "127.0.0.1") {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { port: address.port, host, url: `redis://${host.includes(":") ? `[${host}]` : host}:${address.port}` };
}

// Small RESP decoder for requests made by these synthetic fixtures. Production
// response parsing is separate and deliberately accepts only the expected ACK.
function decodeCommand(input: Buffer): { parts: string[]; consumed: number } | null {
  let offset = 0;
  const line = () => {
    const end = input.indexOf("\r\n", offset);
    if (end < 0) return null;
    const value = input.subarray(offset, end).toString("ascii");
    offset = end + 2;
    return value;
  };
  const array = line();
  if (array === null) return null;
  assert.match(array, /^\*[1-3]$/);
  const parts: string[] = [];
  for (let i = 0; i < Number(array.slice(1)); i++) {
    const length = line();
    if (length === null) return null;
    assert.match(length, /^\$\d+$/);
    const size = Number(length.slice(1));
    if (input.length < offset + size + 2) return null;
    parts.push(input.subarray(offset, offset + size).toString("utf8"));
    assert.equal(input.subarray(offset + size, offset + size + 2).toString("ascii"), "\r\n");
    offset += size + 2;
  }
  return { parts, consumed: offset };
}

async function redisFixture(t: TestContext, respond: (socket: net.Socket, parts: string[], index: number) => void, host = "127.0.0.1") {
  const commands: string[][] = [];
  const endpoint = await listen(t, net.createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      while (input.length) {
        const parsed = decodeCommand(input);
        if (!parsed) return;
        input = input.subarray(parsed.consumed);
        commands.push(parsed.parts);
        respond(socket, parsed.parts, commands.length - 1);
      }
    });
  }), host);
  return { ...endpoint, commands };
}

async function prepareReadyApp(t: TestContext, url: string, supabaseFactory?: SupabaseFactory) {
  process.env.REDIS_URL = url;
  resetEnvCache();
  const factory = (() => ({ from: () => ({ select: () => ({ limit: async () => ({ error: null }) }) }) })) as unknown as SupabaseFactory;
  const app = Fastify({ logger: false });
  healthRoutes(app, supabaseFactory ?? factory);
  t.after(() => app.close());
  await app.ready();
  return app;
}

async function requestReady(t: TestContext, url: string, supabaseFactory?: SupabaseFactory) {
  const app = await prepareReadyApp(t, url, supabaseFactory);
  return app.inject({ method: "GET", url: "/ready" });
}

// Exercise the actual SDK/factory transport seam, without any network fetch.
// Node's test runner isolates this file; these tests are serial and restore fetch.
async function syntheticSupabaseFactory(t: TestContext, fetcher: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  t.after(() => { globalThis.fetch = original; });
  return (await import("./lib/supabase.js")).defaultSupabaseFactory;
}

test("Supabase readiness has one absolute deadline for stalled headers and response bodies", async (t) => {
  for (const phase of ["headers", "body"] as const) {
    await t.test(phase, async (sub) => {
      let attempts = 0;
      let transportSignal: AbortSignal | null | undefined;
      let deadlineObserved = false;
      let guard: ReturnType<typeof setTimeout> | undefined;
      sub.after(() => clearTimeout(guard));
      const factory = await syntheticSupabaseFactory(sub, async (_input, init) => {
        attempts++;
        transportSignal = init?.signal;
        transportSignal?.addEventListener("abort", () => { deadlineObserved = true; }, { once: true });
        // The guard also lets the pre-fix regression finish: no orphan promise.
        if (phase === "headers") return new Promise<Response>((_resolve, reject) => {
          guard = setTimeout(() => reject(new DOMException("Synthetic stalled headers", "AbortError")), 2_600);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(guard);
            reject(init.signal!.reason);
          }, { once: true });
        });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("["));
            guard = setTimeout(() => controller.error(new DOMException("Synthetic stalled body", "AbortError")), 2_600);
          },
          cancel() { clearTimeout(guard); },
        }), { headers: { "content-type": "application/json" } });
      });
      const fixture = await redisFixture(sub, (socket) => socket.write("+PONG\r\n"));
      // Cold Fastify registration/boot is not part of /ready's dependency
      // deadline. Exercise the real handler only after the app is ready.
      const app = await prepareReadyApp(sub, fixture.url, factory);
      const started = performance.now();
      const response = await app.inject({ method: "GET", url: "/ready" });
      const elapsed = performance.now() - started;
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { status: "not_ready", checks: { supabase: false, redis: true } });
      assert.ok(elapsed < 1_900, "Supabase readiness did not honor its absolute deadline");
      assert.equal(deadlineObserved, true, "The transport must observe the readiness abort, not only the fixture guard");
      assert.equal(transportSignal?.aborted, true);
      assert.equal(transportSignal?.reason?.name, "TimeoutError");
      assert.equal(attempts, 1, "A readiness timeout must not be retried");
      assert.ok(!response.body.includes("Synthetic"));
    });
  }
});

test("Supabase readiness does not retry transient HTTP responses and preserves healthy behavior", async (t) => {
  for (const status of [503, 200]) {
    await t.test(`HTTP ${status}`, async (sub) => {
      let attempts = 0;
      const factory = await syntheticSupabaseFactory(sub, async () => {
        attempts++;
        return new Response("[]", { status, headers: { "content-type": "application/json", "retry-after": "1" } });
      });
      const fixture = await redisFixture(sub, (socket) => socket.write("+PONG\r\n"));
      const response = await requestReady(sub, fixture.url, factory);
      assert.equal(response.statusCode, status === 200 ? 200 : 503);
      assert.deepEqual(response.json(), { status: status === 200 ? "ready" : "not_ready", checks: { supabase: status === 200, redis: true } });
      assert.equal(attempts, 1, "A readiness query has exactly one transport attempt");
    });
  }
});

test("readiness rejects a TCP listener that is not Redis", async (t) => {
  const fixture = await listen(t, net.createServer((socket) => {
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
  }));
  const response = await requestReady(t, fixture.url);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: "not_ready", checks: { supabase: true, redis: false } });
});

test("readiness requires an exact Redis PONG, then returns the existing safe shape", async (t) => {
  const fixture = await redisFixture(t, (socket) => socket.write("+PONG\r\n"));
  const response = await requestReady(t, fixture.url);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ready", checks: { supabase: true, redis: true } });
  assert.deepEqual(fixture.commands, [["PING"]]);
});

test("ACL credentials are decoded once, bulk-framed, then SELECT and PING run sequentially", async (t) => {
  const fixture = await redisFixture(t, (socket, parts) => socket.write(parts[0] === "PING" ? "+PONG\r\n" : "+OK\r\n"));
  const username = "a@b";
  const password = "päss\r\n%value";
  const url = `redis://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${fixture.port}/2`;
  assert.equal(await redisReady(url, 500), true);
  assert.deepEqual(fixture.commands, [["AUTH", username, password], ["SELECT", "2"], ["PING"]]);
});

test("legacy password AUTH and explicitly selected database zero are supported", async (t) => {
  const fixture = await redisFixture(t, (socket, parts) => socket.write(parts[0] === "PING" ? "+PONG\r\n" : "+OK\r\n"));
  assert.equal(await redisReady(`redis://:synthetic-password@127.0.0.1:${fixture.port}/0`, 500), true);
  assert.deepEqual(fixture.commands, [["AUTH", "synthetic-password"], ["SELECT", "0"], ["PING"]]);
});

test("omitted path, root slash, database zero and positive database preserve valid exchanges", async (t) => {
  const fixture = await redisFixture(t, (socket, parts) => socket.write(parts[0] === "PING" ? "+PONG\r\n" : "+OK\r\n"));
  for (const path of ["", "/", "/0", "/2"]) assert.equal(await redisReady(`${fixture.url}${path}`, 500), true);
  assert.deepEqual(fixture.commands, [["PING"], ["PING"], ["SELECT", "0"], ["PING"], ["SELECT", "2"], ["PING"]]);
});

test("AUTH denial is fail-closed, stops before PING and does not expose the server error", async (t) => {
  const fixture = await redisFixture(t, (socket) => socket.write("-WRONGPASS synthetic-private-reply\r\n"));
  const response = await requestReady(t, `redis://user:synthetic-wrong@127.0.0.1:${fixture.port}`);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: "not_ready", checks: { supabase: true, redis: false } });
  assert.ok(!response.body.includes("synthetic"));
  assert.deepEqual(fixture.commands, [["AUTH", "user", "synthetic-wrong"]]);
});

test("failed SELECT stops before PING", async (t) => {
  const fixture = await redisFixture(t, (socket) => socket.write("-ERR DB index is out of range\r\n"));
  assert.equal(await redisReady(`${fixture.url}/1000`, 500), false);
  assert.deepEqual(fixture.commands, [["SELECT", "1000"]]);
});

test("fragmented AUTH, SELECT and PONG responses are reassembled within the deadline", async (t) => {
  const fixture = await redisFixture(t, (socket, parts) => {
    const response = parts[0] === "PING" ? "+PONG\r\n" : "+OK\r\n";
    let at = 0;
    const timer = setInterval(() => {
      if (socket.destroyed || at === response.length) { clearInterval(timer); return; }
      socket.write(response[at++]);
    }, 3);
    t.after(() => clearInterval(timer));
  });
  assert.equal(await redisReady(`redis://user:synthetic@127.0.0.1:${fixture.port}/3`, 750), true);
  assert.deepEqual(fixture.commands.map((parts) => parts[0]), ["AUTH", "SELECT", "PING"]);
});

test("silent servers and continuously trickling bytes cannot extend the absolute deadline", async (t) => {
  for (const trickle of [false, true]) {
    await t.test(trickle ? "trickle" : "silence", async (sub) => {
      const fixture = await redisFixture(sub, (socket) => {
        if (!trickle) return;
        const timer = setInterval(() => { if (!socket.destroyed) socket.write("+"); }, 10);
        sub.after(() => clearInterval(timer));
      });
      const started = performance.now();
      assert.equal(await redisReady(fixture.url, 90), false);
      assert.ok(performance.now() - started < 1_500, "absolute timeout was not bounded");
    });
  }
});

test("AUTH and SELECT share one deadline instead of receiving independent timeout budgets", async (t) => {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const fixture = await redisFixture(t, (socket, parts) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!socket.destroyed) socket.write(parts[0] === "PING" ? "+PONG\r\n" : "+OK\r\n");
    }, 150);
    timers.add(timer);
  });
  const started = performance.now();
  assert.equal(await redisReady(`redis://user:synthetic@127.0.0.1:${fixture.port}/1`, 250), false);
  assert.ok(performance.now() - started < 1_500);
  assert.ok(fixture.commands.every((parts) => parts[0] !== "PING"));
});

test("oversized, malformed, wrong-type, extra and truncated responses are rejected", async (t) => {
  const replies = ["+" + "x".repeat(4_096), "+OK\r\n", "$4\r\nPONG\r\n", "+PONG\r\n+PONG\r\n", "+PONG\n", "+PON"];
  for (const [index, reply] of replies.entries()) {
    await t.test(`response ${index}`, async (sub) => {
      const fixture = await redisFixture(sub, (socket) => socket.end(reply));
      assert.equal(await redisReady(fixture.url, 500), false);
    });
  }
});

test("invalid Redis configurations fail before any connection or default-host fallback", async (t) => {
  let connections = 0;
  const fixture = await listen(t, net.createServer((socket) => { connections++; socket.end("+PONG\r\n"); }));
  const invalid = ["", "not-a-url", `http://127.0.0.1:${fixture.port}`, "redis:///0", "redis:localhost", "redis://127.0.0.1:0", "redis://127.0.0.1:65536", "redis://127.0.0.1:abc", `${fixture.url}/-1`, `${fixture.url}/01`, `${fixture.url}/1/2`, `${fixture.url}/2147483648`, `${fixture.url}?tls=false`, `${fixture.url}?`, `${fixture.url}#`, ` ${fixture.url}`, `${fixture.url}\n`, `redis://:bad%ZZ@127.0.0.1:${fixture.port}`, `redis://:${"x".repeat(1_025)}@127.0.0.1:${fixture.port}`, `redis://:${"x".repeat(8_193)}@127.0.0.1:${fixture.port}`];
  for (const value of invalid) {
    assert.equal(parseRedisReadinessEndpoint(value), null);
    assert.equal(await redisReady(value, 100), false);
  }
  for (const rawPath of ["/1/../0", "/%2e%2e/0", "/./2", "/%2E/2", "/1/.%2e/0", "/%2e./0", "/1/..", "/1/."]) {
    assert.equal(parseRedisReadinessEndpoint(`${fixture.url}${rawPath}`), null);
    assert.equal(await redisReady(`${fixture.url}${rawPath}`, 100), false);
  }
  for (const timeout of [0, -1, NaN, Infinity, 10_001, 1.5]) assert.equal(await redisReady(fixture.url, timeout), false);
  assert.equal(connections, 0);
});

test("IPv6 brackets are removed for socket addressing while protocol, port and database are retained", () => {
  const endpoint = parseRedisReadinessEndpoint("rediss://[::1]:6380/4");
  assert.ok(endpoint);
  assert.equal(endpoint.host, "::1");
  assert.equal(endpoint.port, 6380);
  assert.equal(endpoint.secure, true);
  assert.equal(endpoint.database, 4);
});

test("a native IPv6 loopback Redis exchange works when the host supports IPv6", async (t) => {
  let fixture: Awaited<ReturnType<typeof redisFixture>>;
  try { fixture = await redisFixture(t, (socket) => socket.write("+PONG\r\n"), "::1"); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && ["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(String(error.code))) { t.skip("Host does not support IPv6 loopback"); return; }
    throw error;
  }
  assert.equal(await redisReady(fixture.url, 500), true);
});

// Generate a self-signed X.509 certificate entirely in memory using Node
// crypto. Its private key is synthetic, short-lived and never persisted/logged.
// DER encoding lives only in the test fixture; production uses native TLS.
function selfSignedFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = (tag: number, bytes: Buffer): Buffer => {
    const size = bytes.length;
    const length = size < 128 ? Buffer.from([size]) : (() => {
      let hex = size.toString(16); if (hex.length % 2) hex = "0" + hex;
      const encoded = Buffer.from(hex, "hex");
      return Buffer.concat([Buffer.from([0x80 | encoded.length]), encoded]);
    })();
    return Buffer.concat([Buffer.from([tag]), length, bytes]);
  };
  const sequence = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
  const algorithm = Buffer.from("300d06092a864886f70d01010b0500", "hex");
  const name = sequence(der(0x31, sequence(Buffer.from("0603550403", "hex"), der(0x0c, Buffer.from("localhost")))));
  const time = (date: Date) => der(0x17, Buffer.from(date.toISOString().replace(/\D/g, "").slice(2, 14) + "Z"));
  const san = sequence(der(0x82, Buffer.from("localhost")), der(0x87, Buffer.from([127, 0, 0, 1])));
  const extensions = der(0xa3, sequence(sequence(Buffer.from("0603551d11", "hex"), der(0x04, san))));
  const tbs = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), algorithm, name,
    sequence(time(new Date(Date.now() - 60_000)), time(new Date(Date.now() + 86_400_000))), name,
    publicKey.export({ type: "spki", format: "der" }), extensions);
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", tbs, privateKey)])));
  const certificatePem = `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }), cert: certificatePem };
}

test("rediss cannot accept a plaintext Redis listener", async (t) => {
  const fixture = await listen(t, net.createServer((socket) => socket.end("+PONG\r\n")));
  assert.equal(await redisReady(`rediss://127.0.0.1:${fixture.port}`, 500), false);
});

test("rediss rejects an untrusted self-signed certificate rather than disabling certificate validation", async (t) => {
  let applicationBytes = 0;
  const server = tls.createServer(selfSignedFixture(), (socket) => socket.on("data", (bytes) => { applicationBytes += bytes.length; socket.write("+PONG\r\n"); }));
  server.on("tlsClientError", () => {});
  const fixture = await listen(t, server);
  assert.equal(await redisReady(`rediss://user:synthetic-secret@127.0.0.1:${fixture.port}`, 750), false);
  assert.equal(applicationBytes, 0, "AUTH must not be sent before certificate validation");
});

test("a plaintext probe cannot report a TLS-only server as ready", async (t) => {
  const server = tls.createServer(selfSignedFixture());
  server.on("tlsClientError", () => {});
  const fixture = await listen(t, server);
  assert.equal(await redisReady(fixture.url, 500), false);
});

test("rediss succeeds with a trusted certificate and still rejects a hostname mismatch", async (t) => {
  // These APIs only change this isolated test process's CA trust, never the
  // production probe or certificate verification. Older supported Node builds
  // without this test seam still run the mandatory refusal/mismatch coverage.
  if (typeof tls.setDefaultCACertificates !== "function" || typeof tls.getCACertificates !== "function") {
    t.skip("Runtime lacks the test-local CA override API");
    return;
  }
  const certificate = selfSignedFixture();
  const original = tls.getCACertificates("default");
  tls.setDefaultCACertificates([...original, certificate.cert]);
  try {
    await t.test("trusted exact host", async (sub) => {
      const server = tls.createServer(certificate, (socket) => socket.on("data", () => socket.write("+PONG\r\n")));
      server.on("tlsClientError", () => {});
      const fixture = await listen(sub, server);
      assert.equal(await redisReady(`rediss://127.0.0.1:${fixture.port}`, 750), true);
    });
    await t.test("trusted issuer but wrong host", async (sub) => {
      const server = tls.createServer(certificate, (socket) => socket.on("data", () => socket.write("+PONG\r\n")));
      server.on("tlsClientError", () => {});
      const fixture = await listen(sub, server, "127.0.0.2");
      assert.equal(await redisReady(`rediss://127.0.0.2:${fixture.port}`, 750), false);
    });
  } finally {
    tls.setDefaultCACertificates(original);
  }
});
