import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@bookworm/api-client";

test("admin client preserves cookie auth, flag scope/config, and job pagination", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ jobs: [{ id: "job-1" }], flag: { enabled: false } });
  };
  try {
    const api = createClient({ baseUrl: "/api/backend" });
    await api.adminToggleFlag("editor/preview", false, { scopeType: "workspace", scopeId: "ws-1", config: { rollout: 50 } });
    assert.equal(calls[0].url, "/api/backend/v1/admin/flags/editor%2Fpreview");
    assert.equal(new Headers(calls[0].init?.headers).has("authorization"), false);
    assert.equal(calls[0].init?.credentials, "same-origin");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { enabled: false, scopeType: "workspace", scopeId: "ws-1", config: { rollout: 50 } });
    assert.deepEqual(await api.adminList("jobs", { type: "publishing", status: "failed", offset: 50, limit: 50 }), [{ id: "job-1" }]);
    assert.equal(calls[1].url, "/api/backend/v1/admin/jobs?type=publishing&status=failed&offset=50&limit=50");
  } finally { globalThis.fetch = original; }
});

test("admin client: ticket update + usage summary use same-origin transport", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const url = String(input);
    if (url.includes("/v1/admin/support/")) {
      return Response.json({ ticket: { id: "ticket-1", status: "pending" } });
    }
    if (url.includes("/v1/admin/usage/summary")) {
      const daysMatch = url.match(/days=(\d+)/);
      const days = daysMatch ? Number(daysMatch[1]) : 30;
      return Response.json({ days, orgs: [{ organizationId: "org-1", total: 12, byMeter: { ai: 7, publishing: 5 } }] });
    }
    return Response.json({});
  };
  try {
    const api = createClient({ baseUrl: "/api/backend" });
    await api.adminUpdateTicket("ticket-1", "pending", "high");
    assert.equal(calls[0].url, "/api/backend/v1/admin/support/ticket-1");
    assert.equal(calls[0].init?.credentials, "same-origin");
    assert.equal(new Headers(calls[0].init?.headers).has("authorization"), false);
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { status: "pending", priority: "high" });
    const usage = await api.adminUsageSummary(7);
    assert.equal(usage.days, 7);
    assert.equal(usage.orgs[0].organizationId, "org-1");
    assert.equal(calls[1].url, "/api/backend/v1/admin/usage/summary?days=7");
  } finally { globalThis.fetch = original; }
});

test("admin client exposes document rows and aggregate queue health", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/v1/admin/jobs/document/health")) return Response.json({ health: { running: 2, expired_running: 1 } });
    return Response.json({ jobs: [{ id: "document-1", status: "queued" }] });
  };
  try {
    const api = createClient({ baseUrl: "/api/backend" });
    assert.equal((await api.adminList("jobs", { type: "document" }))[0].id, "document-1");
    assert.equal((await api.adminDocumentJobHealth()).health.expired_running, 1);
    assert.deepEqual(calls, [
      "/api/backend/v1/admin/jobs?type=document",
      "/api/backend/v1/admin/jobs/document/health",
    ]);
  } finally { globalThis.fetch = original; }
});

test("admin UI: AdminConsole.tsx does not expose a global Retry/Reprocess action", async () => {
  // The no-retry rule per the 2026-09-06 Codex handoff: "do not expose
  // global admin retry as operational." This test
  // loads AdminConsole.tsx as text and asserts it never references a
  // retry-like action. If a future PR reintroduces a Retry button, this
  // test fails and the rule is forced back into review.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { resolve, dirname } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const sourcePath = resolve(here, "..", "components", "AdminConsole.tsx");
  const source = await readFile(sourcePath, "utf8");
  assert.equal(
    /admin\s*\.\s*(adminRetryJob|retry|reprocess|requeue)\b/i.test(source) || /\bretry\b|\breprocess\b|\brequeue\b/i.test(source),
    false,
    "AdminConsole.tsx must not reference retry/reprocess/requeue helpers or labels. The publishing worker is still a stub.",
  );
});

test("Book Bible hold release transports explicit review attestations with cookie auth", async () => {
  const original = globalThis.fetch;
  let call: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => { call = { url: String(input), init }; return Response.json({ status: "failed" }); };
  try {
    const body = { incidentRef: "INC-BIBLE-123", receiptReviewed: true, providerReviewed: true } as const;
    await createClient({ baseUrl: "/api/backend" }).adminReleaseBibleHold("job/id", body);
    assert.equal(call?.url, "/api/backend/v1/admin/jobs/ai/job%2Fid/release-bible-hold");
    assert.equal(call?.init?.method, "POST");
    assert.equal(call?.init?.credentials, "same-origin");
    assert.deepEqual(JSON.parse(String(call?.init?.body)), body);
    assert.equal(new Headers(call?.init?.headers).has("authorization"), false);
  } finally { globalThis.fetch = original; }
});

test("account client: data requests + support tickets use same-origin transport", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const url = String(input);
    if (url.includes("/v1/account/data-requests")) {
      return Response.json({ requests: [{ id: "req-1", request_type: "export", status: "submitted", reason: null, requested_at: new Date().toISOString(), due_at: new Date().toISOString(), completed_at: null }] });
    }
    if (url.includes("/v1/support/tickets")) {
      return Response.json({ tickets: [{ id: "t-1", category: "general", subject: "Test", status: "open", priority: "normal", created_at: new Date().toISOString() }] });
    }
    return Response.json({});
  };
  try {
    const api = createClient({ baseUrl: "/api/backend" });
    await api.createDataRequest({ type: "export", reason: "GDPR" });
    assert.equal(calls[0].url, "/api/backend/v1/account/data-requests");
    assert.equal(calls[0].init?.credentials, "same-origin");
    assert.equal(new Headers(calls[0].init?.headers).has("authorization"), false);
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { type: "export", reason: "GDPR" });
    const list = await api.listDataRequests();
    assert.equal(list.requests[0].id, "req-1");
    assert.equal(calls[1].url, "/api/backend/v1/account/data-requests");
    const tickets = await api.listSupportTickets();
    assert.equal(tickets.tickets[0].id, "t-1");
    assert.equal(calls[2].url, "/api/backend/v1/support/tickets");
  } finally { globalThis.fetch = original; }
});
