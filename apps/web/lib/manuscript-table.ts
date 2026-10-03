import type { BookNode } from "@bookworm/book-model";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export interface TableSpan { row: number; col: number; rowspan: number; colspan: number }
export interface TableCell { row: number; col: number }
export interface TableSelection { top: number; left: number; bottom: number; right: number }
const textOf = (rows: string[][]) => rows.map((row) => row.join("\t")).join("\n");
const hash = (text: string) => bytesToHex(sha256(new TextEncoder().encode(text)));

export function tableGridHash(rows: string[][]): string {
  return `v2:${hash(JSON.stringify(rows))}`;
}

export function manuscriptTableRows(node: BookNode): string[][] | null {
  const rows = node.rows;
  if (!Array.isArray(rows) || rows.length > 2000 || !rows.every((row) => Array.isArray(row) && row.length <= 100 && row.every((cell) => typeof cell === "string"))) return null;
  return node.text === undefined || node.text === textOf(rows) ? rows : null;
}

export function manuscriptTableHeaderRows(node: BookNode): number {
  const rows = manuscriptTableRows(node);
  const count = node.attributes?.tableHeaderRows;
  return rows && typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= rows.length ? count : 0;
}

function validSpans(rows: string[][], value: unknown, headers: number): TableSpan[] {
  if (!Array.isArray(value) || value.length > rows.reduce((sum, row) => sum + row.length, 0)) return [];
  const occupied = new Set<string>();
  const result: TableSpan[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || ![entry.row, entry.col, entry.rowspan, entry.colspan].every(Number.isSafeInteger)) return [];
    const { row, col, rowspan, colspan } = entry as TableSpan;
    if (row < 0 || col < 0 || rowspan < 1 || colspan < 1 || rowspan * colspan < 2 || row + rowspan > rows.length || (row < headers && headers < row + rowspan)) return [];
    for (let r = row; r < row + rowspan; r++) {
      if (col + colspan > rows[r].length) return [];
      for (let c = col; c < col + colspan; c++) {
        const key = `${r}:${c}`;
        if (occupied.has(key) || ((r !== row || c !== col) && rows[r][c] !== "")) return [];
        occupied.add(key);
      }
    }
    result.push({ row, col, rowspan, colspan });
  }
  return result.sort((a, b) => a.row - b.row || a.col - b.col);
}

export function manuscriptTableSpans(node: BookNode): TableSpan[] {
  const rows = manuscriptTableRows(node);
  if (!rows || !Array.isArray(node.attributes?.tableSpans)) return [];
  const source = node.attributes?.tableSpanSource;
  if (source !== tableGridHash(rows) && source !== hash(textOf(rows))) return [];
  return validSpans(rows, node.attributes.tableSpans, manuscriptTableHeaderRows(node));
}

function withLayout(node: BookNode, rows: string[][], spans: TableSpan[], headers = manuscriptTableHeaderRows(node)): BookNode {
  if (rows.length > 2000 || rows.some((row) => row.length > 100 || row.some((cell) => cell.length > 100000))) throw new Error("This table exceeds the supported size.");
  const { richText: _text, tableSpans: _spans, tableSpanSource: _source, ...attributes } = node.attributes ?? {};
  return { ...node, rows, text: textOf(rows), attributes: { ...attributes, tableHeaderRows: Math.min(headers, rows.length),
    ...(spans.length ? { tableSpans: spans, tableSpanSource: tableGridHash(rows) } : {}) } };
}

export function withTableRows(node: BookNode, rows: string[][]): BookNode {
  return withLayout(node, rows, validSpans(rows, manuscriptTableSpans(node), manuscriptTableHeaderRows(node)));
}

export function withTableHeaderRows(node: BookNode, count: number): BookNode {
  const rows = manuscriptTableRows(node);
  if (!rows || !Number.isInteger(count) || count < 0 || count > rows.length) throw new Error("Choose a valid number of header rows.");
  const spans = manuscriptTableSpans(node);
  if (spans.some((span) => span.row < count && count < span.row + span.rowspan)) throw new Error("Split the cell spanning the header and body before changing header rows.");
  return withLayout(node, rows, spans, count);
}

export function tableSelection(spans: TableSpan[], first: TableCell, last: TableCell): TableSelection {
  const extent = (cell: TableCell) => spans.find((span) => span.row === cell.row && span.col === cell.col) ?? { ...cell, rowspan: 1, colspan: 1 };
  const a = extent(first), b = extent(last);
  return { top: Math.min(a.row, b.row), left: Math.min(a.col, b.col),
    bottom: Math.max(a.row + a.rowspan - 1, b.row + b.rowspan - 1), right: Math.max(a.col + a.colspan - 1, b.col + b.colspan - 1) };
}

export function mergeTableCells(node: BookNode, selection: TableSelection): BookNode {
  const rows = manuscriptTableRows(node);
  const { top, left, bottom, right } = selection;
  if (!rows || ![top, left, bottom, right].every(Number.isSafeInteger) || top < 0 || left < 0 || bottom < top || right < left || bottom >= rows.length || rows.slice(top, bottom + 1).some((row) => right >= row.length)) throw new Error("Choose cells inside this table.");
  if (top === bottom && left === right) throw new Error("Select at least two cells to merge.");
  const headers = manuscriptTableHeaderRows(node);
  if (top < headers && headers <= bottom) throw new Error("Header and body cells cannot be merged together.");
  const spans = manuscriptTableSpans(node);
  const retained = spans.filter((span) => {
    const lastRow = span.row + span.rowspan - 1, lastCol = span.col + span.colspan - 1;
    const overlaps = span.row <= bottom && lastRow >= top && span.col <= right && lastCol >= left;
    if (overlaps && !(span.row >= top && lastRow <= bottom && span.col >= left && lastCol <= right)) throw new Error("Select whole merged cells, or split them first.");
    return !overlaps;
  });
  const next = rows.map((row) => [...row]);
  const content: string[] = [];
  for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) {
    if (next[row][col] !== "") content.push(next[row][col]);
    next[row][col] = "";
  }
  next[top][left] = content.join("\n");
  return withLayout(node, next, [...retained, { row: top, col: left, rowspan: bottom - top + 1, colspan: right - left + 1 }]);
}

export function splitTableCell(node: BookNode, cell: TableCell): BookNode {
  const rows = manuscriptTableRows(node);
  if (!rows) throw new Error("This table's grid is unavailable.");
  return withLayout(node, rows, manuscriptTableSpans(node).filter((span) => span.row !== cell.row || span.col !== cell.col));
}
