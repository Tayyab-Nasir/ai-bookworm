export interface SalesTrendInput {
  month: string;
  currency: string;
  units: number;
  reportedProceedsCents: number | null;
  royaltyCents: number;
}

export interface SalesTrendPoint {
  month: string;
  hasImportedRows: boolean;
  units: number | null;
  reportedProceedsCents: number | null;
  royaltyCents: number | null;
}

export function buildSalesTrend(
  rows: readonly SalesTrendInput[],
  currency: string,
  windowStart: string | null,
  monthCount: number,
): SalesTrendPoint[] {
  const match = windowStart?.match(/^(\d{4})-(\d{2})-01$/);
  if (!match || !Number.isInteger(monthCount) || monthCount < 1 || monthCount > 36) return [];
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10) !== windowStart) return [];

  const months = Array.from({ length: monthCount }, (_, offset) =>
    new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 10),
  );
  const monthSet = new Set(months);
  const grouped = new Map<string, SalesTrendPoint>();
  for (const row of rows) {
    if (row.currency !== currency || !monthSet.has(row.month)) continue;
    const previous = grouped.get(row.month);
    grouped.set(row.month, {
      month: row.month, hasImportedRows: true, units: (previous?.units ?? 0) + row.units,
      reportedProceedsCents: !previous ? row.reportedProceedsCents
        : previous.reportedProceedsCents === null || row.reportedProceedsCents === null ? null
          : previous.reportedProceedsCents + row.reportedProceedsCents,
      royaltyCents: (previous?.royaltyCents ?? 0) + row.royaltyCents,
    });
  }

  return months.map((value) => grouped.get(value) ?? {
    month: value, hasImportedRows: false, units: null, reportedProceedsCents: null, royaltyCents: null,
  });
}
