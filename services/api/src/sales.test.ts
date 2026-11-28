import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";

const { loadRetailerSalesAnalytics, loadRetailerSalesSummary } = await import("./routes/sales.js");

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

test("retailer analytics validates bounded monthly, book and source aggregates", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const sb = { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return { data: {
      windowStart: "2026-04-01", windowEnd: "2026-10-01", monthCount: 6,
      monthly: [{ month: "2026-09-01", currency: "USD", units: 4, reportedProceedsCents: 599, royaltyCents: 419 }],
      books: [{ bookId: "22222222-2222-2222-2222-222222222222", title: "River Book", currency: "USD", units: 4, reportedProceedsCents: 599, royaltyCents: 419, firstSoldOn: "2026-09-08", lastSoldOn: "2026-09-08" }],
      bookCount: 1,
      booksTruncated: false,
      sources: [{ source: "amazon_kdp", currency: "USD", units: 4, reportedProceedsCents: 599, royaltyCents: 419 }],
    }, error: null };
  } } as never;

  const analytics = await loadRetailerSalesAnalytics(sb, "11111111-1111-4111-8111-111111111111", 6);
  assert.equal(calls[0]?.name, "retailer_sales_analytics");
  assert.equal(calls[0]?.args.p_months, 6);
  assert.equal(analytics.available, true);
  assert.equal(analytics.monthly[0]?.royaltyCents, 419);
  assert.equal(analytics.books[0]?.title, "River Book");
  assert.equal(analytics.sources[0]?.source, "amazon_kdp");
});

test("retailer analytics is unavailable before migration and rejects invalid windows", async () => {
  const sb = { rpc: async () => ({ data: null, error: { code: "PGRST202" } }) } as never;
  const unavailable = await loadRetailerSalesAnalytics(sb, "11111111-1111-4111-8111-111111111111");
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.windowStart, null);
  assert.equal(unavailable.windowEnd, null);
  assert.deepEqual(unavailable.monthly, []);
  await assert.rejects(loadRetailerSalesAnalytics(sb, "11111111-1111-4111-8111-111111111111", 0), /between 1 and 36 months/i);
});

test("retailer aggregate replies reject money that JavaScript cannot represent exactly", async () => {
  const sb = { rpc: async () => ({ data: {
    status: "imported", imports: 1, latestImportedAt: null, units: 1, reportedProceedsCents: null,
    royaltyCents: Number.MAX_SAFE_INTEGER + 1, currency: "USD", currencies: [],
  }, error: null }) } as never;
  await assert.rejects(loadRetailerSalesSummary(sb, "11111111-1111-4111-8111-111111111111"), /summary is temporarily unavailable/i);
});
