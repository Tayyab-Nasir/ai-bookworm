import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, type DashboardOverview } from "@bookworm/api-client";
import { activityLabel, dashboardMeter } from "../components/AuthorDashboard";
import { jobLink } from "../lib/job-link";

test("dashboard client uses the authenticated same-origin backend route", async () => {
  const original = globalThis.fetch;
  let called = ""; let request: RequestInit | undefined;
  globalThis.fetch = async (input, init) => { called = String(input); request = init; return Response.json({}); };
  try {
    await createClient({ baseUrl: "/api/backend" }).getDashboardOverview("workspace / one");
    assert.equal(called, "/api/backend/v1/dashboard?workspaceId=workspace%20%2F%20one");
    assert.equal(request?.credentials, "same-origin");
    assert.equal(new Headers(request?.headers).has("authorization"), false);
  } finally { globalThis.fetch = original; }
});

test("dashboard usage meters default to zero and never fabricate capacity", () => {
  assert.deepEqual(dashboardMeter(null, "translation_credits", "translation_credits_monthly"), { used: 0, limit: 0, percent: 0 });
  const overview = { usage: { usage: { translation_credits: 25 }, entitlements: { entitlements: { translation_credits_monthly: 100 } } } } as unknown as DashboardOverview;
  assert.deepEqual(dashboardMeter(overview, "translation_credits", "translation_credits_monthly"), { used: 25, limit: 100, percent: 25 });
});

test("dashboard activity uses friendly labels and safe fallbacks", () => {
  assert.equal(activityLabel("publishing_package_created"), "Retailer package prepared");
  assert.equal(activityLabel("retailer_sales_imported"), "Retailer sales report imported");
  assert.equal(activityLabel("chapter_saved"), "chapter saved");
});

test("pipeline links use saved scope, exact AI review IDs, and existing studios without executing work", () => {
  const bookId = "11111111-1111-4111-8111-111111111111", workspace = "22222222-2222-4222-8222-222222222222", id = "33333333-3333-4333-8333-333333333333";
  assert.equal(jobLink({ id, bookId, kind: "ai", destination: "editor" }, workspace), `/books/${bookId}?aiJob=${id}`);
  assert.equal(jobLink({ id, bookId, kind: "import", destination: "editor" }, workspace), `/books/${bookId}`);
  for (const destination of ["memory", "publish", "translate", "plan", "overview"] as const) assert.equal(jobLink({ id, bookId, kind: "ai", destination }, workspace), `/books/${bookId}/${destination}`);
  assert.equal(jobLink({ id, bookId: null, kind: "ai", destination: "assets" }, workspace), `/assets?ws=${workspace}`);
  assert.equal(jobLink({ id, bookId, kind: "audiobook_export", destination: "publish" }, workspace), `/books/${bookId}/publish`);
  assert.equal(jobLink({ id, bookId: null, kind: "publishing", destination: "publish" }, workspace), null);
  for (const bad of ["https://other.invalid", "../foreign", "", "<script>"]) {
    assert.equal(jobLink({ id: bad, bookId, kind: "ai", destination: "editor" }, workspace), null);
    assert.equal(jobLink({ id, bookId: bad, kind: "ai", destination: "editor" }, workspace), null);
    assert.equal(jobLink({ id, bookId, kind: "ai", destination: "editor" }, bad), null);
  }
  assert.equal(jobLink({ id, bookId, kind: "unknown", destination: "editor" }, workspace), null);
});
