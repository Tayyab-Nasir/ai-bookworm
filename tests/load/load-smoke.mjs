// Load smoke: N=50 concurrent mixed requests against the TS API with fake
// Supabase (no external infra). Asserts zero 5xx and prints p50/p95 latency.
// ponytail: in-process via app.inject — measures handler logic, not network/
// TLS/DB; for real load run k6 against a deployed stack.
// Usage: node tests/load/load-smoke.js  (tsx handles the TS import)
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { buildApp } = await import("../../services/api/src/app.ts");

function fakeSupabase(responses) {
  const client = {
    auth: {
      getUser: async (token) =>
        token === "good"
          ? { data: { user: { id: "user-1" } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    from: (table) => {
      const r = responses[table] ?? { data: null, error: null };
      const b = {};
      for (const m of ["select", "eq", "insert", "update", "delete"]) b[m] = () => b;
      b.order = () => b;
      b.limit = () => b;
      b.single = async () => r;
      b.maybeSingle = async () => r;
      b.then = (resolve) => resolve(r);
      return b;
    },
  };
  return client;
}

const app = await buildApp(() => fakeSupabase({
  workspaces: { data: [{ id: "w1", name: "W" }], error: null },
  chapters: { data: { book_id: "b1" }, error: null },
  books: { data: { workspace_id: "w1" }, error: null },
  workspace_members: { data: { role: "editor" }, error: null },
  document_versions: { data: { version_number: 0, content_json: {}, plain_text: "", word_count: 0 }, error: null },
}));

const auth = { authorization: "Bearer good" };
const N = 50;
const CH_ID = "c1";

const requests = [
  // read
  () => app.inject({ method: "GET", url: "/v1/workspaces", headers: auth }),
  // write op (idempotent-ish; version always 0 in fake)
  () => app.inject({ method: "POST", url: `/v1/chapters/${CH_ID}/operations`, headers: auth,
    payload: { operationId: `op-${Math.random()}`, type: "replace_text", target: {}, payload: {}, expectedVersion: 0 } }),
  // health
  () => app.inject({ method: "GET", url: "/v1/health" }),
  // auth failure
  () => app.inject({ method: "GET", url: "/v1/workspaces" }),
];

const started = performance.now();
const results = await Promise.all(
  Array.from({ length: N }, (_, i) => {
    const t0 = performance.now();
    return requests[i % requests.length]().then((res) => ({
      status: res.statusCode, ms: performance.now() - t0,
    }));
  }),
);
const total = performance.now() - started;

const fiveXx = results.filter((r) => r.status >= 500);
const lat = results.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))].toFixed(1);

console.log(`load-smoke: ${N} concurrent requests in ${total.toFixed(0)}ms`);
console.log(`  statuses: ${JSON.stringify(results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {}))}`);
console.log(`  latency ms: p50=${pct(50)} p95=${pct(95)} max=${lat[lat.length - 1].toFixed(1)}`);

await app.close();

if (fiveXx.length > 0) {
  console.error(`FAIL: ${fiveXx.length} 5xx responses`);
  process.exit(1);
}
console.log("PASS: no 5xx");
