import type { RetailerSalesRowInput } from "@bookworm/api-client";

type CsvRow = string[];

function parseGrid(text: string): CsvRow[] {
  const rows: CsvRow[] = []; let row: string[] = []; let cell = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(cell); cell = ""; continue; }
    if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (char !== "\r") cell += char;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted value.");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const aliases: Record<string, string[]> = {
  soldOn: ["soldon", "date", "royaltydate", "transactiondate", "salesdate"],
  title: ["title", "booktitle", "producttitle"],
  externalId: ["externalid", "asin", "isbn", "asinisbn", "productid"],
  marketplace: ["marketplace", "territory", "country", "store"], format: ["format", "producttype", "binding"],
  units: ["units", "unitssold", "netunitssold", "quantity"], reportedProceedsCents: ["reportedproceedscents", "proceedscents"],
  reportedProceeds: ["reportedproceeds", "salesproceeds", "netproceeds"], royaltyCents: ["royaltycents", "earningscents"],
  royalty: ["royalty", "royaltyamount", "earnings", "netroyalty"], currency: ["currency", "royaltycurrency"],
};

function column(headers: string[], name: string, required = false) {
  const index = headers.findIndex((header) => aliases[name].includes(compact(header)));
  if (index < 0 && required) throw new Error(`CSV needs a ${name} column.`);
  return index;
}

function at(row: CsvRow, index: number) { return index < 0 ? "" : row[index]?.trim() ?? ""; }

function toCents(value: string, row: number, label: string) {
  const raw = value.trim().replace(/[ $£€]/g, "").replace(/\((.*)\)/, "-$1");
  if (!/^-?[\d,]+(?:\.\d{1,2})?$/.test(raw)) throw new Error(`Row ${row}: ${label} must be decimal money.`);
  const numeric = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) throw new Error(`Row ${row}: ${label} is invalid.`);
  return Math.round(numeric * 100);
}

function toInteger(value: string, row: number, label: string) {
  if (!/^-?\d+$/.test(value.trim())) throw new Error(`Row ${row}: ${label} must be a whole number.`);
  return Number(value);
}

function isIsoCalendarDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseRetailerSalesCsv(text: string, bookId?: string | null): RetailerSalesRowInput[] {
  if (text.length > 256_000) throw new Error("CSV is larger than 256 KB.");
  const grid = parseGrid(text); const headers = grid.shift();
  if (!headers?.length) throw new Error("CSV has no header row.");
  const soldOn = column(headers, "soldOn", true); const title = column(headers, "title", true);
  const units = column(headers, "units", true); const royalty = column(headers, "royalty"); const royaltyCents = column(headers, "royaltyCents");
  const currency = column(headers, "currency", true); const proceeds = column(headers, "reportedProceeds"); const proceedsCents = column(headers, "reportedProceedsCents");
  if (royalty < 0 && royaltyCents < 0) throw new Error("CSV needs a royalty or royalty cents column.");
  if (grid.length > 2000) throw new Error("CSV has more than 2,000 rows.");
  return grid.flatMap((row, index) => {
    if (row.every((cell) => !cell.trim())) return [];
    const line = index + 2; const date = at(row, soldOn);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isIsoCalendarDate(date)) throw new Error(`Row ${line}: sold date must be YYYY-MM-DD.`);
    const bookTitle = at(row, title);
    if (!bookTitle) throw new Error(`Row ${line}: title is required.`);
    const code = at(row, currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw new Error(`Row ${line}: currency must be ISO-4217, for example USD.`);
    const royaltyValue = royaltyCents >= 0 ? toInteger(at(row, royaltyCents), line, "royalty cents") : toCents(at(row, royalty), line, "royalty");
    const proceedsValue = proceedsCents >= 0 ? toInteger(at(row, proceedsCents), line, "reported proceeds cents") : proceeds >= 0 ? toCents(at(row, proceeds), line, "reported proceeds") : null;
    return [{
      bookId: bookId ?? null, soldOn: date, title: bookTitle, externalId: at(row, column(headers, "externalId")) || null,
      marketplace: at(row, column(headers, "marketplace")) || null, format: at(row, column(headers, "format")) || null,
      units: toInteger(at(row, units), line, "units"), reportedProceedsCents: proceedsValue, royaltyCents: royaltyValue, currency: code,
    }];
  });
}
