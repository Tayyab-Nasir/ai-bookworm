"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BookNode } from "@bookworm/book-model";
import { manuscriptTableRows, manuscriptTableHeaderRows, manuscriptTableSpans, mergeTableCells,
  splitTableCell, tableSelection, withTableHeaderRows, withTableRows, type TableCell } from "../lib/manuscript-table";

const button = "min-h-11 rounded-lg border border-black/20 px-3 py-2 text-xs text-black outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-black disabled:opacity-40";

export default function ManuscriptTable({ node, editable, onChange, onRemove }: {
  node: BookNode; editable: boolean; onChange: (node: BookNode, separateHistory: boolean) => void; onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState<TableCell | null>(null);
  const [last, setLast] = useState<TableCell | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const root = useRef<HTMLElement>(null);
  const focusAfterChange = useRef<TableCell | null>(null);
  const { rows, headers, spans, anchors, covered } = useMemo(() => {
    const rows = manuscriptTableRows(node), spans = manuscriptTableSpans(node);
    const anchors = new Map(spans.map((span) => [`${span.row}:${span.col}`, span]));
    const covered = new Set<string>();
    for (const span of spans) for (let r = span.row; r < span.row + span.rowspan; r++) for (let c = span.col; c < span.col + span.colspan; c++) {
      if (r !== span.row || c !== span.col) covered.add(`${r}:${c}`);
    }
    return { rows, headers: manuscriptTableHeaderRows(node), spans, anchors, covered };
  }, [node]);
  const columns = Math.max(1, ...(rows ?? []).map((row) => row.length));
  const selection = first ? tableSelection(spans, first, last ?? first) : null;
  const selectedSpan = first && !last ? anchors.get(`${first.row}:${first.col}`) : undefined;
  const canMerge = selection && (selection.bottom > selection.top || selection.right > selection.left);
  const active = editing && editable;
  const hasStaleLayout = rows && Array.isArray(node.attributes?.tableSpans) && node.attributes.tableSpans.length > 0 && spans.length === 0;

  useEffect(() => {
    const cell = focusAfterChange.current;
    if (cell) root.current?.querySelector<HTMLTextAreaElement>(`textarea[data-cell="${cell.row}:${cell.col}"]`)?.focus();
    focusAfterChange.current = null;
  }, [node]);

  const apply = (change: () => BookNode, message = "", separateHistory = true) => {
    if (!editable) return;
    try { onChange(change(), separateHistory); setError(""); setStatus(message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update the table."); }
  };
  const select = (cell: TableCell) => {
    setError(""); setStatus("");
    if (!first || last) { setFirst(cell); setLast(null); }
    else setLast(cell);
  };
  const renderRow = (row: string[], r: number) => <tr key={r}>{Array.from({ length: columns }, (_, c) => {
    const key = `${r}:${c}`;
    if (covered.has(key)) return null;
    const span = anchors.get(key);
    const selected = Boolean(selection && r >= selection.top && r <= selection.bottom && c >= selection.left && c <= selection.right);
    const Cell = r < headers ? "th" : "td";
    return <Cell key={c} rowSpan={span?.rowspan} colSpan={span?.colspan} scope={r < headers ? "col" : undefined}
      className={`min-w-24 border border-black/20 p-2 text-left align-top ${selected && active ? "bg-amber-100 ring-1 ring-inset ring-amber-700/30" : r < headers ? "bg-stone-200/65 font-semibold" : ""}`}>
      {active ? <div className="space-y-2">
        <button type="button" aria-label={`Select row ${r + 1}, column ${c + 1}`} aria-pressed={selected}
          className="min-h-8 rounded border border-black/20 px-2 text-[11px] font-sans font-normal outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-black"
          onClick={() => select({ row: r, col: c })}>{selected ? "Selected" : "Select cell"}</button>
        {span && <span className="ml-2 text-[11px] font-sans font-normal text-black/60">{span.rowspan} {span.rowspan === 1 ? "row" : "rows"} × {span.colspan} {span.colspan === 1 ? "column" : "columns"}</span>}
        <textarea data-cell={key} aria-label={`Row ${r + 1}, column ${c + 1}`} value={row[c] ?? ""} maxLength={100000} rows={2}
          className="block min-h-11 w-full min-w-28 rounded border border-black/25 bg-white px-2 py-1 font-sans text-sm font-normal text-black outline-none focus-visible:ring-2 focus-visible:ring-black"
          onChange={(event) => apply(() => withTableRows(node, rows!.map((cells, index) => index === r ? Array.from({ length: columns }, (_, col) => col === c ? event.target.value : cells[col] ?? "") : cells)), "", false)} />
      </div> : <span className="whitespace-pre-wrap break-words">{row[c] || "\u00a0"}</span>}
    </Cell>;
  })}</tr>;

  return <section ref={root} aria-label="Manuscript table" className="min-w-0 rounded-lg border border-black/20 bg-white/30 p-3">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 font-sans text-xs">
      <span className="text-black/60">Table · {rows?.length ?? 0} rows{headers ? ` · ${headers} header ${headers === 1 ? "row" : "rows"}` : ""}{spans.length ? ` · ${spans.length} merged ${spans.length === 1 ? "cell" : "cells"}` : ""}</span>
      {editable && <div className="flex flex-wrap gap-2">
        {rows && <button type="button" className={button} aria-pressed={editing} onClick={() => { setEditing(!editing); setFirst(null); setLast(null); }}>{editing ? "Preview table" : "Edit table"}</button>}
        {rows && rows.length > 0 && <button type="button" className={button} aria-pressed={headers > 0} onClick={() => apply(() => withTableHeaderRows(node, headers ? 0 : 1))}>{headers ? "Remove header marking" : "Use first row as headers"}</button>}
        <button type="button" className={button} onClick={onRemove}>Remove table</button>
      </div>}
    </div>
    {active && <div className="mb-3 rounded-lg border border-black/10 bg-white/60 p-3 font-sans">
      <p className="text-xs text-black/65">Select the first and last cells of a rectangle to merge them. Text is kept in reading order.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={button} disabled={!canMerge} onClick={() => {
          if (!selection) return;
          apply(() => {
            const next = mergeTableCells(node, selection), cell = { row: selection.top, col: selection.left };
            setFirst(cell); setLast(null); focusAfterChange.current = cell;
            return next;
          }, "Cells merged. All text is kept in the first cell. Use Undo to restore the original cells.");
        }}>Merge selected</button>
        <button type="button" className={button} disabled={!selectedSpan} onClick={() => {
          if (first) apply(() => { focusAfterChange.current = first; return splitTableCell(node, first); }, "Cell split. Text remains in the first cell. Use Undo to restore the merge.");
        }}>Split selected cell</button>
        {first && <button type="button" className={button} onClick={() => { setFirst(null); setLast(null); }}>Clear selection</button>}
        {selection && <span className="text-xs text-black/60">Rows {selection.top + 1}–{selection.bottom + 1}, columns {selection.left + 1}–{selection.right + 1}</span>}
      </div>
    </div>}
    {error && <p role="alert" className="mb-3 text-sm text-red-800">{error}</p>}
    <p role="status" className="mb-2 text-xs text-black/65">{status || (hasStaleLayout ? "The merged layout no longer matches this table. All cells are shown so you can review the content." : "")}</p>
    {rows ? <div className="max-h-[32rem] overflow-auto" tabIndex={0} role="region" aria-label="Scrollable table cells">
      <table className="w-full border-collapse text-sm"><caption className="sr-only">Manuscript table content</caption>
        {headers > 0 && <thead>{rows.slice(0, headers).map(renderRow)}</thead>}
        <tbody>{rows.slice(headers).map((row, index) => renderRow(row, index + headers))}</tbody>
      </table>
    </div> : <div><p role="status" className="mb-3 font-sans text-xs text-black/65">Table text was changed outside the grid. Your latest text is preserved below; the old grid is not shown.</p><p className="whitespace-pre-wrap">{node.text}</p></div>}
    {active && rows && <div className="mt-3 flex flex-wrap gap-2 font-sans">
      <button type="button" className={button} disabled={rows.length >= 2000} onClick={() => apply(() => withTableRows(node, [...rows, Array(columns).fill("")]))}>Add row</button>
      <button type="button" className={button} disabled={columns >= 100} onClick={() => apply(() => withTableRows(node, (rows.length ? rows : [[]]).map((row) => [...Array.from({ length: columns }, (_, c) => row[c] ?? ""), ""])))}>Add column</button>
      <p className="basis-full text-xs text-black/60">Edits stay in this draft until you save the chapter. Use Undo to restore a change.</p>
    </div>}
  </section>;
}
