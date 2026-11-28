import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseRetailerSalesCsv } from "../lib/sales-csv";

test("sales CSV parser supports quoted titles and decimal royalties", () => {
  const rows = parseRetailerSalesCsv('Royalty Date,Title,Units Sold,Royalty,Currency\n2026-09-01,"The, Book",2,6.97,USD\n', "book-1");
  assert.deepEqual(rows, [{ bookId: "book-1", soldOn: "2026-09-01", title: "The, Book", externalId: null, marketplace: null, format: null, units: 2, reportedProceedsCents: null, royaltyCents: 697, currency: "USD" }]);
});

test("sales CSV parser refuses ambiguous dates and missing required columns", () => {
  assert.throws(() => parseRetailerSalesCsv("Date,Title,Units,Royalty,Currency\n09/01/2026,Book,1,1.00,USD"), /YYYY-MM-DD/);
  assert.throws(() => parseRetailerSalesCsv("Date,Title,Units,Royalty,Currency\n2026-02-30,Book,1,1.00,USD"), /YYYY-MM-DD/);
  assert.throws(() => parseRetailerSalesCsv("Date,Title,Units,Royalty,Currency\n2026-09-01,,1,1.00,USD"), /title is required/);
  assert.throws(() => parseRetailerSalesCsv("Title,Units,Royalty,Currency\nBook,1,1.00,USD"), /soldOn/);
});

test("downloadable sales template accepts real values and exact decimal cents", () => {
  const header = readFileSync(new URL("../public/retailer-sales-template.csv", import.meta.url), "utf8").trimEnd();
  const records = parseRetailerSalesCsv(`${header}\n2026-09-01,Book,2,"($1,234.50)",USD\n2026-09-02,Book,1,0.07,USD`);
  assert.deepEqual(records.map(row => row.royaltyCents), [-123450, 7]);
  assert.deepEqual(parseRetailerSalesCsv(header), []);
});

test("sales preview refuses numbers it cannot interpret without changing their value", () => {
  const report = "Date,Title,Units,Royalty,Currency\n2026-09-01,Book,1,";
  for (const amount of ['"1,23"', '"12,34.50"', '"1 23.45"']) {
    assert.throws(() => parseRetailerSalesCsv(report + amount + ",USD"), /dot for decimals/);
  }
  assert.throws(() => parseRetailerSalesCsv(report + "1,23,USD"), /more values than columns/);
  assert.throws(() => parseRetailerSalesCsv(report + "99999999999999999.01,USD"), /too large/);
});
