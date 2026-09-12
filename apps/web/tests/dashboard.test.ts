import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, type DashboardOverview } from "@bookworm/api-client";
import { activityLabel, dashboardMeter } from "../components/AuthorDashboard";

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
