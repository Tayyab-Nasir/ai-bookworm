import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@bookworm/api-client";

test("retailer imports use the same-origin BFF and durable report dedupe instead of generic POST keys", async () => {
  const original = globalThis.fetch; let called = ""; let request: RequestInit | undefined;
  globalThis.fetch = async (input, init) => { called = String(input); request = init; return Response.json({ importId: "id", rowCount: 1, duplicate: false }); };
  try {
    await createClient({ baseUrl: "/api/backend" }).importRetailerSales({ workspaceId: "workspace", source: "amazon_kdp", fileName: "report.csv", rows: [{ soldOn: "2026-09-01", title: "Book", units: 1, royaltyCents: 1, currency: "USD" }] });
    assert.equal(called, "/api/backend/v1/sales/imports");
    assert.equal(request?.credentials, "same-origin");
    assert.equal(new Headers(request?.headers).has("idempotency-key"), false);
  } finally { globalThis.fetch = original; }
});
