import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";

const { loadRetailerSalesSummary } = await import("./routes/sales.js");

test("retailer summary preserves currency separation and tolerates a pre-migration database", async () => {
  const imported = await loadRetailerSalesSummary({ rpc: async () => ({ data: {
    status: "imported", imports: 2, latestImportedAt: "2026-09-10T00:00:00Z", units: 4,
    reportedProceedsCents: null, royaltyCents: null, currency: null,
    currencies: [
      { currency: "EUR", units: 1, reportedProceedsCents: 100, royaltyCents: 70 },
      { currency: "USD", units: 3, reportedProceedsCents: 300, royaltyCents: 210 },
    ],
  }, error: null }) } as never, "22222222-2222-2222-2222-222222222222");
  assert.equal(imported.currency, null);
  assert.equal(imported.reportedProceedsCents, null);
  assert.match(imported.message, /Multiple currencies/i);

  const unavailable = await loadRetailerSalesSummary({ rpc: async () => ({ data: null, error: { code: "PGRST202" } }) } as never, "22222222-2222-2222-2222-222222222222");
  assert.equal(unavailable.status, "not_connected");
  assert.equal(unavailable.available, false);
  assert.match(unavailable.message, /not installed/i);
});
