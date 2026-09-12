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
interface Store { tables: Record<string, Row[]>; rpc?: (name: string, args: Row) => { data: unknown; error: unknown } }

const TOKENS: Record<string, string> = { good: "user-1", admin: "admin-1" };

function fakeSupabase(store: Store, opts: { failReads?: boolean } = {}) {
  const client = {
    rpc: async (name: string, args: Row) => {
      if (store.rpc) return store.rpc(name, args);
      if (name === "cancel_data_rights_request") {
        const row = (store.tables.data_rights_requests ?? []).find((value) => value.id === args.p_request_id && value.user_id === "user-1");
        if (!row) return { data: null, error: { code: "P0002" } };
        if (row.status !== "submitted") return { data: null, error: { code: "22023" } };
        row.status = "cancelled";
        row.updated_at = new Date().toISOString();
        return { data: row, error: null };
      }
      assert.equal(name, "set_admin_feature_flag");
      const rows = (store.tables.feature_flags ??= []);
      let row = rows.find((value) => value.key === args.p_key && value.scope_type === args.p_scope_type && value.scope_id === args.p_scope_id);
      if (!row) {
        row = { id: crypto.randomUUID(), key: args.p_key, scope_type: args.p_scope_type, scope_id: args.p_scope_id, config_json: {} };
        rows.push(row);
      }
      row.enabled = args.p_enabled;
      if (args.p_config !== null) row.config_json = args.p_config;
      (store.tables.audit_logs ??= []).push({ actor_id: args.p_actor_id, action: "flag.update", entity_id: row.id });
      return { data: row, error: null };
    },
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
      b.ilike = (column: string, pattern: string) => {
        const text = pattern.slice(1, -1).replace(/\\(.)/g, "$1").toLowerCase();
        matched = rows.filter((row) => String(row[column] ?? "").toLowerCase().includes(text));
        return b;
      };
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
  const adminAccess = await app.inject({ method: "GET", url: "/v1/admin/access", headers: as("admin") });
  assert.deepEqual(adminAccess.json(), { admin: true });
  const deniedAccess = await app.inject({ method: "GET", url: "/v1/admin/access", headers: as("good") });
  assert.equal(deniedAccess.statusCode, 403);
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
  const search = await app.inject({ method: "GET", url: "/v1/admin/users?search=User%20One", headers: as("admin") });
  assert.equal(search.statusCode, 200);
  assert.equal(search.json().users.length, 1);
  const literal = await app.inject({ method: "GET", url: "/v1/admin/users?search=%25", headers: as("admin") });
  assert.equal(literal.statusCode, 200);
  assert.equal(literal.json().users.length, 0);

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

test("AI retry remains unavailable to the admin console while author reviews use durable worker recovery", async () => {
  const jobId = "a9000000-0000-4000-8000-000000000021";
  const store: Store = {
    tables: {
      ai_jobs: [{
        id: jobId, book_id: "b9000000-0000-4000-8000-000000000021", agent_type: "writer", status: "failed", attempts: 2,
        error_code: "ai_provider_failed", error_message: "boom", model: null, usage_json: {}, created_at: "2026-01-01T00:00:00Z",
        started_at: null, completed_at: "2026-01-01T00:00:01Z", input_ref: { userInstruction: "private prompt" },
        output_ref: { providerPayload: "private output" }, idempotency_key: "private-idempotency-key",
      }],
      publishing_jobs: [],
    },
  };
  const app = await appWith(store);
  const res = await app.inject({ method: "POST", url: `/v1/admin/jobs/ai/${jobId}/retry`, headers: as("admin") });
  assert.equal(res.statusCode, 503);
  const job = store.tables.ai_jobs[0];
  assert.equal(job.status, "failed");
  assert.equal(job.attempts, 2);
  assert.equal((store.tables.audit_logs ?? []).length, 0);

  const list = await app.inject({ method: "GET", url: "/v1/admin/jobs?type=ai&status=failed", headers: as("admin") });
  assert.equal(list.json().jobs.length, 1);
  assert.equal("input_ref" in list.json().jobs[0], false);
  assert.equal("output_ref" in list.json().jobs[0], false);
  assert.equal("idempotency_key" in list.json().jobs[0], false);
  assert.equal(JSON.stringify(list.json()).includes("private prompt"), false);
  assert.equal(JSON.stringify(list.json()).includes("private output"), false);
  assert.equal(JSON.stringify(list.json()).includes("private-idempotency-key"), false);
  await app.close();
});

test("publishing retry delegates atomic reset and audit to the queue RPC", async () => {
  const jobId = "a9000000-0000-4000-8000-000000000001";
  const store: Store = {
    tables: {
      ai_jobs: [],
      publishing_jobs: [{
        id: jobId, status: "failed", attempts: 4, request_json: { action: "export_package" },
        response_json: { error: { code: "PACKAGE_FAILED", message: "boom" } },
        created_at: "2026-01-01T00:00:00Z",
      }],
    }, rpc(name, args) {
      assert.equal(name, "retry_publishing_job");
      assert.deepEqual(args, { p_job_id: jobId, p_actor_id: "admin-1" });
      const job = this.tables.publishing_jobs[0];
      Object.assign(job, { status: "queued", attempts: 0, response_json: null });
      this.tables.audit_logs = [{ action: "job.retry", entity_id: jobId }];
      return { data: job, error: null };
    },
  };
  const app = await appWith(store);
  const res = await app.inject({ method: "POST", url: `/v1/admin/jobs/publishing/${jobId}/retry`, headers: as("admin") });
  assert.equal(res.statusCode, 200);
  const job = store.tables.publishing_jobs[0];
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 0);
  assert.equal(job.response_json, null);
  assert.equal("error_code" in job, false);
  assert.equal("error_message" in job, false);
  assert.equal(store.tables.audit_logs[0].action, "job.retry");
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
  assert.deepEqual(store.tables.feature_flags[0].config_json, { rollout: 50 });
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

test("document job diagnostics expose safe rows and aggregate health only", async () => {
  const jobId = "a9000000-0000-4000-8000-000000000099";
  const bookId = "b9000000-0000-4000-8000-000000000099";
  const assetId = "c9000000-0000-4000-8000-000000000099";
  const now = "2026-09-11T00:00:00.000Z";
  const store: Store = {
    tables: { manuscript_import_jobs: [{
      id: jobId, book_id: bookId, source_asset_id: assetId, status: "running", attempts: 1,
      error_code: null, created_at: now, available_at: now, completed_at: null,
      source_checksum: "a".repeat(64), lease_token: "secret-lease", lease_expires_at: now,
    }] },
    rpc(name) {
      assert.equal(name, "get_manuscript_import_health");
      return { data: [{ generated_at: now, queued: 0, due_queued: 0, running: 1,
        expired_running: 1, succeeded: 0, failed: 0, dead_letters: 0,
        oldest_queued_at: null, oldest_running_at: now }], error: null };
    },
  };
  const app = await appWith(store);
  const list = await app.inject({ method: "GET", url: "/v1/admin/jobs?type=document", headers: as("admin") });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().jobs[0].id, jobId);
  assert.equal("source_checksum" in list.json().jobs[0], false);
  assert.equal("lease_token" in list.json().jobs[0], false);
  assert.equal("lease_expires_at" in list.json().jobs[0], false);

  const health = await app.inject({ method: "GET", url: "/v1/admin/jobs/document/health", headers: as("admin") });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().health.expired_running, 1);
  assert.equal(JSON.stringify(health.json()).includes("secret-lease"), false);
  await app.close();
});

test("authors create and list only their support tickets", async () => {
  const store: Store = { tables: { support_tickets: [{ id: "other", user_id: "other-user", subject: "Private", created_at: "2026-01-01T00:00:00Z" }] } };
  const app = await appWith(store);
  const invalid = await app.inject({ method: "POST", url: "/v1/support/tickets", headers: as("good"), payload: { category: "general", subject: "Hi", body: "short" } });
  assert.equal(invalid.statusCode, 422);
  const created = await app.inject({ method: "POST", url: "/v1/support/tickets", headers: as("good"), payload: {
    category: "publishing", subject: "Package question", body: "Please explain the preflight warning.", priority: "urgent",
  } });
  assert.equal(created.statusCode, 422, "unknown or caller-controlled priority must be rejected");
  const ok = await app.inject({ method: "POST", url: "/v1/support/tickets", headers: as("good"), payload: {
    category: "publishing", subject: "Package question", body: "Please explain the preflight warning.",
  } });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().ticket.user_id, "user-1");
  assert.equal(ok.json().ticket.status, "open");
  assert.equal(ok.json().ticket.priority, "normal");
  const listed = await app.inject({ method: "GET", url: "/v1/support/tickets", headers: as("good") });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().tickets.map((ticket: Row) => ticket.subject), ["Package question"]);
  await app.close();
});

test("data-rights intake requires explicit deletion confirmation and cancellation is scoped", async () => {
  const requestId = "a8900000-0000-4000-8000-000000000001";
  const store: Store = { tables: { data_rights_requests: [{ id: requestId, user_id: "user-1", request_type: "export", status: "submitted", requested_at: "2026-01-01T00:00:00Z" }] } };
  const app = await appWith(store);
  const denied = await app.inject({ method: "POST", url: "/v1/account/data-requests", headers: as("good"), payload: { type: "delete", confirmation: "delete" } });
  assert.equal(denied.statusCode, 422);
  const deletion = await app.inject({ method: "POST", url: "/v1/account/data-requests", headers: as("good"), payload: { type: "delete", confirmation: "DELETE MY ACCOUNT", reason: "Moving service" } });
  assert.equal(deletion.statusCode, 201, deletion.body);
  assert.equal(deletion.json().request.user_id, "user-1");
  assert.equal(deletion.json().request.status, "submitted");
  const cancelled = await app.inject({ method: "DELETE", url: `/v1/account/data-requests/${requestId}`, headers: as("good") });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().request.status, "cancelled");
  const repeat = await app.inject({ method: "DELETE", url: `/v1/account/data-requests/${requestId}`, headers: as("good") });
  assert.equal(repeat.statusCode, 409);
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
