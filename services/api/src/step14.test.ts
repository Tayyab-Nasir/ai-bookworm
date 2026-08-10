import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL = "redis://127.0.0.1:6399"; // closed port: /ready redis check fails
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.ADMIN_USER_IDS = "admin-1";

const { buildApp } = await import("./app.js");
const { redactObject } = await import("./lib/redact.js");

// ---- stateful fake supabase (same pattern as step12, + range/lte/or/upsert) --
type Row = Record<string, unknown>;
interface Store { tables: Record<string, Row[]> }

const TOKENS: Record<string, string> = { good: "user-1", admin: "admin-1" };

function fakeSupabase(store: Store, opts: { failReads?: boolean } = {}) {
  const client = {
    auth: {
      getUser: async (token: string) =>
        TOKENS[token] ? { data: { user: { id: TOKENS[token] } }, error: null } : { data: { user: null }, error: { message: "bad" } },
    },
    from: (table: string) => {
      const rows = (store.tables[table] ??= []);
      let filters: [string, unknown][] = [];
      let cmpFilters: [string, string, unknown][] = [];
      let matched: Row[] | null = null;
      let pendingOp: "update" | null = null;
      let pendingPatch: Row = {};
      let range: [number, number] | null = null;
      const apply = () => {
        let out = matched ?? rows;
        out = out.filter((r) => filters.every(([c, v]) => (Array.isArray(v) ? (v as unknown[]).includes(r[c]) : r[c] === v)));
        out = out.filter((r) => cmpFilters.every(([op, c, v]) => (op === "gte" ? String(r[c]) >= String(v) : String(r[c]) <= String(v))));
        return out;
      };
      const applyRanged = () => {
        const out = apply();
        return range ? out.slice(range[0], range[1] + 1) : out;
      };
      const uid = () => crypto.randomUUID();
      const done = (v: { data: unknown; error: unknown }) =>
        opts.failReads ? { data: null, error: { message: "connection failed" } } : v;
      const b: Record<string, unknown> = {};
      const finalize = () => {
        b.single = async () => done({ data: applyRanged()[0] ?? null, error: null });
        b.maybeSingle = b.single;
        b.then = (res: (v: unknown) => unknown) => res(done({ data: applyRanged(), error: null }));
        return b;
      };
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { if (pendingOp) matched = apply(); filters.push([c, v]); return b; };
      b.in = (c: string, vs: unknown[]) => { if (pendingOp) matched = apply(); filters.push([c, vs]); return b; };
      b.gte = (c: string, v: unknown) => { cmpFilters.push(["gte", c, v]); return b; };
      b.lte = (c: string, v: unknown) => { cmpFilters.push(["lte", c, v]); return b; };
      b.or = () => b; // search filter: not exercised in tests
      b.order = () => b;
      // range/limit: apply the slice to the NEXT resolution only, but stay
      // chainable for a following .range().
      b.limit = (n: number) => { range = [0, n - 1]; return finalize(); };
      b.range = (f: number, t: number) => { range = [f, t]; return finalize(); };
      b.insert = (row: Row) => {
        const r = { id: uid(), created_at: new Date().toISOString(), ...row };
        rows.push(r);
        b.single = async () => done({ data: r, error: null });
        b.maybeSingle = b.single;
        b.then = (res: (v: unknown) => unknown) => res(done({ data: [r], error: null }));
        return b;
      };
      b.upsert = (row: Row) => {
        const hit = rows.find((x) => x.key === row.key && x.scope_type === row.scope_type && (x.scope_id ?? null) === (row.scope_id ?? null));
        if (hit) Object.assign(hit, row);
        else rows.push({ id: uid(), created_at: new Date().toISOString(), ...row });
        const r = hit ?? rows[rows.length - 1];
        b.single = async () => done({ data: r, error: null });
        return b;
      };
      b.update = (patch: Row) => {
        pendingOp = "update";
        pendingPatch = patch;
        const mutate = () => {
          const hits = apply();
          for (const h of hits) Object.assign(h, patch);
          return hits;
        };
        b.select = () => {
          const hits = mutate();
          b.single = async () => done({ data: hits[0] ?? null, error: null });
          b.then = (res: (v: unknown) => unknown) => res(done({ data: hits, error: null }));
          return b;
        };
        b.then = (res: (v: unknown) => unknown) => res(done({ data: mutate(), error: null }));
        return b;
      };
      b.single = async () => done({ data: apply()[0] ?? null, error: null });
      b.maybeSingle = b.single;
      b.then = (res: (v: unknown) => unknown) => res(done({ data: apply(), error: null }));
      return b;
    },
  };
  return client as never;
}

const appWith = (store: Store, opts: { failReads?: boolean } = {}) =>
  buildApp((() => fakeSupabase(store, opts)) as never);
const as = (token: string) => ({ authorization: `Bearer ${token}` });

// ---- tests ------------------------------------------------------------------

test("admin routes: 403 for non-admin, 401 without token", async () => {
  const app = await appWith({ tables: {} });
  const noAuth = await app.inject({ method: "GET", url: "/v1/admin/users" });
  assert.equal(noAuth.statusCode, 401);
  const nonAdmin = await app.inject({ method: "GET", url: "/v1/admin/users", headers: as("good") });
  assert.equal(nonAdmin.statusCode, 403);
  await app.close();
});

test("admin users list + suspend sets status and writes audit", async () => {
  const store: Store = {
    tables: {
      profiles: [{ id: "user-1", display_name: "User One", created_at: "2026-01-01T00:00:00Z" }],
      organization_members: [
        { organization_id: "org-1", user_id: "user-1", role: "member", status: "active" },
      ],
      workspace_members: [],
    },
  };
  const app = await appWith(store);
  const list = await app.inject({ method: "GET", url: "/v1/admin/users", headers: as("admin") });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().users.length, 1);
  assert.equal(list.json().memberships.length, 1);

  const bad = await app.inject({ method: "POST", url: "/v1/admin/users/user-1/suspend", headers: as("good") });
  assert.equal(bad.statusCode, 403);

  const res = await app.inject({ method: "POST", url: "/v1/admin/users/user-1/suspend", headers: as("admin") });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().suspended, true);
  assert.equal(store.tables.organization_members[0].status, "suspended");
  const audit = store.tables.audit_logs ?? [];
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "user.suspend");
  assert.equal(audit[0].actor_id, "admin-1");
  await app.close();
});

test("job retry resets failed job to queued with attempts+1 and audit", async () => {
  const store: Store = {
    tables: {
      ai_jobs: [{ id: "job-1", status: "failed", attempts: 2, error_message: "boom", created_at: "2026-01-01T00:00:00Z" }],
      publishing_jobs: [],
    },
  };
  const app = await appWith(store);
  const res = await app.inject({ method: "POST", url: "/v1/admin/jobs/ai/job-1/retry", headers: as("admin") });
  assert.equal(res.statusCode, 200);
  const job = store.tables.ai_jobs[0];
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 3);
  assert.equal((store.tables.audit_logs ?? [])[0]?.action, "job.retry");

  // non-failed job cannot retry
  const again = await app.inject({ method: "POST", url: "/v1/admin/jobs/ai/job-1/retry", headers: as("admin") });
  assert.equal(again.statusCode, 422);

  const list = await app.inject({ method: "GET", url: "/v1/admin/jobs?type=ai&status=queued", headers: as("admin") });
  assert.equal(list.json().jobs.length, 1);
  await app.close();
});

test("feature flag toggle upserts and audits", async () => {
  const store: Store = { tables: { feature_flags: [] } };
  const app = await appWith(store);
  const res = await app.inject({
    method: "PUT", url: "/v1/admin/flags/new-editor", headers: as("admin"),
    payload: { enabled: true, config: { rollout: 50 } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(store.tables.feature_flags.length, 1);
  assert.equal(store.tables.feature_flags[0].enabled, true);

  const off = await app.inject({
    method: "PUT", url: "/v1/admin/flags/new-editor", headers: as("admin"),
    payload: { enabled: false },
  });
  assert.equal(off.statusCode, 200);
  assert.equal(store.tables.feature_flags.length, 1); // upsert, not dup
  assert.equal(store.tables.feature_flags[0].enabled, false);
  assert.equal((store.tables.audit_logs ?? []).length, 2);

  const list = await app.inject({ method: "GET", url: "/v1/admin/flags", headers: as("admin") });
  assert.equal(list.json().flags.length, 1);
  await app.close();
});

test("support ticket status update", async () => {
  const store: Store = {
    tables: { support_tickets: [{ id: "t-1", status: "open", priority: "normal", created_at: "2026-01-01T00:00:00Z" }] },
  };
  const app = await appWith(store);
  const res = await app.inject({
    method: "POST", url: "/v1/admin/support/t-1", headers: as("admin"),
    payload: { status: "resolved" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(store.tables.support_tickets[0].status, "resolved");
  assert.equal((store.tables.audit_logs ?? [])[0]?.action, "ticket.update");
  await app.close();
});

test("audit list filters by action", async () => {
  const store: Store = {
    tables: {
      audit_logs: [
        { id: 1, action: "user.suspend", entity_type: "user", created_at: "2026-01-01T00:00:00Z" },
        { id: 2, action: "flag.update", entity_type: "feature_flag", created_at: "2026-01-02T00:00:00Z" },
      ],
    },
  };
  const app = await appWith(store);
  const res = await app.inject({ method: "GET", url: "/v1/admin/audit?action=flag.update", headers: as("admin") });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().entries.length, 1);
  assert.equal(res.json().entries[0].action, "flag.update");
  await app.close();
});

test("/health ok; /ready 503 when supabase fails and redis down", async () => {
  const app = await appWith({ tables: { profiles: [] } }, { failReads: true });
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  const ready = await app.inject({ method: "GET", url: "/ready" });
  assert.equal(ready.statusCode, 503);
  const body = ready.json();
  assert.equal(body.checks.supabase, false);
  assert.equal(body.checks.redis, false);
  await app.close();
});

test("/ready 200 when supabase ok but redis down? no — both required", async () => {
  const app = await appWith({ tables: { profiles: [] } });
  const ready = await app.inject({ method: "GET", url: "/ready" });
  assert.equal(ready.statusCode, 503); // redis port 6399 closed
  assert.equal(ready.json().checks.supabase, true, JSON.stringify(ready.json()));
  await app.close();
});

test("usage summary aggregates per org", async () => {
  const store: Store = {
    tables: {
      usage_events: [
        { organization_id: "org-1", meter: "ai_tokens", quantity: 100, created_at: new Date().toISOString() },
        { organization_id: "org-1", meter: "ai_tokens", quantity: 50, created_at: new Date().toISOString() },
        { organization_id: "org-2", meter: "renders", quantity: 10, created_at: new Date().toISOString() },
      ],
    },
  };
  const app = await appWith(store);
  const res = await app.inject({ method: "GET", url: "/v1/admin/usage/summary", headers: as("admin") });
  assert.equal(res.statusCode, 200);
  const orgs = res.json().orgs;
  assert.equal(orgs[0].organizationId, "org-1");
  assert.equal(orgs[0].total, 150);
  assert.equal(orgs[1].organizationId, "org-2");
  await app.close();
});

test("redactObject scrubs manuscript text, tokens, signed urls", () => {
  const dirty = {
    text: "Chapter 1: It was a dark and stormy night",
    nested: { content: "manuscript body", token: "sk-secret-123", keep: "visible" },
    uploadUrl: "https://s3.example.com/bucket/file?X-Amz-Signature=abc123",
    list: [{ body: "more text", fine: 42 }],
  };
  const clean = redactObject(dirty) as Record<string, unknown>;
  const serialized = JSON.stringify(clean);
  assert.ok(!serialized.includes("dark and stormy"));
  assert.ok(!serialized.includes("sk-secret-123"));
  assert.ok(!serialized.includes("X-Amz-Signature=abc123"));
  assert.ok(!serialized.includes("manuscript body"));
  assert.ok(!serialized.includes("more text"));
  assert.ok(serialized.includes("visible"));
  assert.equal((clean.nested as Row).keep, "visible");
  assert.equal((clean.list as Row[])[0].fine, 42);
});
