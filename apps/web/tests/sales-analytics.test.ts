import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSalesTrend } from "../lib/sales-analytics";

test("sales trend keeps missing reports unknown, aggregates one currency, and retains corrections", () => {
  const points = buildSalesTrend([
    { month: "2026-05-01", currency: "USD", units: 3, reportedProceedsCents: 500, royaltyCents: 350 },
    { month: "2026-05-01", currency: "USD", units: 1, reportedProceedsCents: 100, royaltyCents: 70 },
    { month: "2026-07-01", currency: "USD", units: -1, reportedProceedsCents: null, royaltyCents: -70 },
    { month: "2026-07-01", currency: "EUR", units: 8, reportedProceedsCents: 900, royaltyCents: 600 },
  ], "USD", "2026-04-01", 4);

  assert.deepEqual(points, [
    { month: "2026-04-01", hasImportedRows: false, units: null, reportedProceedsCents: null, royaltyCents: null },
    { month: "2026-05-01", hasImportedRows: true, units: 4, reportedProceedsCents: 600, royaltyCents: 420 },
    { month: "2026-06-01", hasImportedRows: false, units: null, reportedProceedsCents: null, royaltyCents: null },
    { month: "2026-07-01", hasImportedRows: true, units: -1, reportedProceedsCents: null, royaltyCents: -70 },
  ]);
});

test("sales trend rejects invalid calendar windows", () => {
  assert.deepEqual(buildSalesTrend([], "USD", null, 12), []);
  assert.deepEqual(buildSalesTrend([], "USD", "2026-13-01", 12), []);
  assert.deepEqual(buildSalesTrend([], "USD", "2026-01-01", 0), []);
});

test("sales trend advances calendar months across year boundaries", () => {
  assert.deepEqual(
    buildSalesTrend([], "USD", "2026-12-01", 3).map((point) => point.month),
    ["2026-12-01", "2027-01-01", "2027-02-01"],
  );
});

test("partially unreported proceeds remain unknown regardless of row order", () => {
  const known = { month: "2026-09-01", currency: "USD", units: 1, royaltyCents: 70, reportedProceedsCents: 100 };
  const unknown = { ...known, reportedProceedsCents: null };
  for (const rows of [[known, unknown], [unknown, known]]) {
    const [point] = buildSalesTrend(rows, "USD", "2026-09-01", 1);
    assert.equal(point.reportedProceedsCents, null, "partial proceeds cannot masquerade as a complete total");
    assert.equal(point.units, 2);
    assert.equal(point.royaltyCents, 140);
  }
});
