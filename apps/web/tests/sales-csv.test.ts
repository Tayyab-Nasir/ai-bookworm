import assert from "node:assert/strict";
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
