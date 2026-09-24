"use client";

import { NodeViewWrapper, useEditorState, type NodeViewProps } from "@tiptap/react";
import { useEffect, useId, useRef, useState } from "react";
import type { BookNode } from "@bookworm/book-model";
import type { Asset } from "@bookworm/types";
import { apiClient } from "./api";
import { manuscriptTableHeaderRows, manuscriptTableRows, withTableRows } from "./book-editor-model";

const field = "mt-1 block min-h-11 w-full rounded-lg border border-black/20 bg-white px-3 py-2 text-sm text-black outline-none focus-visible:ring-2 focus-visible:ring-black";
const action = "min-h-11 rounded-lg border border-black/20 px-3 py-2 text-sm text-black outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-black disabled:opacity-40";

function usePrivateImage(assetId: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ id: string | null; url: string | null; error: string | null }>({ id: null, url: null, error: null });
  useEffect(() => {
    let cancelled = false;
    setState({ id: assetId, url: null, error: null });
    if (assetId) void apiClient().getAssetDownloadUrl(assetId).then(({ url }) => {
      if (!cancelled) setState({ id: assetId, url, error: null });
    }).catch((reason) => {
      if (!cancelled) setState({ id: assetId, url: null, error: reason instanceof Error ? reason.message : "Artwork preview unavailable." });
    });
    return () => { cancelled = true; };
  }, [assetId, attempt]);
  return {
    url: state.id === assetId ? state.url : null,
    error: state.id === assetId ? state.error : null,
    fail: () => setState({ id: assetId, url: null, error: "The private preview expired or could not be loaded. Refresh to try again." }),
    retry: () => setAttempt((value) => value + 1),
  };
}

export function ManuscriptBlockView({ node, editor, selected, updateAttributes, deleteNode }: NodeViewProps) {
  const original = node.attrs.canonical as BookNode | undefined;
  const assetId = original?.type === "image" && typeof original.assetId === "string" ? original.assetId : null;
  const preview = usePrivateImage(assetId);
  const editable = useEditorState({ editor, selector: ({ editor: current }) => current.isEditable });
  const [settings, setSettings] = useState(false);
  const id = useId();
  const alt = typeof original?.altText === "string" ? original.altText : "";
  const caption = typeof original?.caption === "string" ? original.caption : "";
  const decorative = original?.attributes?.decorative === true;
  const printPlacement = original?.attributes?.printPlacement === "fullBleed" ? "fullBleed" : "inline";
  const focalX = typeof original?.attributes?.printFocalX === "number" ? original.attributes.printFocalX : 50;
  const focalY = typeof original?.attributes?.printFocalY === "number" ? original.attributes.printFocalY : 50;
  const width = typeof original?.attributes?.widthPercent === "number" ? Math.min(100, Math.max(25, original.attributes.widthPercent)) : 100;
  const change = (patch: Partial<BookNode>) => { if (editor.isEditable && original) updateAttributes({ canonical: { ...original, ...patch } }); };

  return <NodeViewWrapper contentEditable={false} className={`my-8 rounded-lg ${selected ? "ring-2 ring-black/40 ring-offset-4 ring-offset-[#f5f1e8]" : ""}`}>
    {original?.type === "image" ? <>
      <figure className="mx-auto" style={{ width: `${printPlacement === "fullBleed" ? 100 : width}%` }}>
        {preview.url ? <img src={preview.url} alt={decorative ? "" : alt} onError={preview.fail} referrerPolicy="no-referrer" className="mx-auto max-h-[540px] w-auto max-w-full rounded-sm object-contain" /> : <div role="status" className="flex min-h-36 flex-col items-center justify-center gap-3 rounded-lg bg-black/5 p-5 text-center font-sans text-sm text-black/60">
          <span>{preview.error ?? "Loading private artwork…"}</span>
          {preview.error && <button type="button" onClick={preview.retry} className={action}>Refresh preview</button>}
        </div>}
        {caption && <figcaption className="mt-3 text-center text-sm italic text-black/65">{caption}</figcaption>}
      </figure>
      {editable && <div className="mt-3 font-sans">
        <button type="button" aria-expanded={settings} aria-controls={`${id}-settings`} className={`${action} text-xs`} onClick={() => setSettings((open) => !open)}>Artwork settings</button>
        {settings && <div id={`${id}-settings`} className="mt-3 grid gap-4 rounded-xl border border-black/15 bg-white/55 p-4">
          <label className="text-xs text-black/70">Image description (alt text)<input className={field} value={alt} disabled={decorative} maxLength={1000} onChange={(event) => change({ altText: event.target.value })} /></label>
          <label className="flex min-h-11 items-center gap-2 text-xs text-black/70"><input type="checkbox" checked={decorative} onChange={(event) => change({ attributes: { ...original.attributes, decorative: event.target.checked } })} />This picture is purely decorative</label>
          <label className="text-xs text-black/70">Caption<input className={field} value={caption} maxLength={2000} onChange={(event) => change({ caption: event.target.value })} /></label>
          <label className="text-xs text-black/70">Print placement<select className={field} value={printPlacement} onChange={(event) => change({ attributes: { ...original.attributes, printPlacement: event.target.value } })}><option value="inline">Inside the text area</option><option value="fullBleed">Dedicated full-bleed page</option></select></label>
          {printPlacement === "inline" ? <label className="text-xs text-black/70">Width<select className={field} value={width} onChange={(event) => change({ attributes: { ...original.attributes, widthPercent: Number(event.target.value) } })}><option value={100}>Full text width</option><option value={75}>Three-quarter width</option><option value={50}>Half width</option><option value={25}>Quarter width</option></select></label> : <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-black/70">Horizontal focus<select className={field} value={focalX} onChange={(event) => change({ attributes: { ...original.attributes, printFocalX: Number(event.target.value) } })}><option value={0}>Left</option><option value={50}>Center</option><option value={100}>Right</option></select></label>
            <label className="text-xs text-black/70">Vertical focus<select className={field} value={focalY} onChange={(event) => change({ attributes: { ...original.attributes, printFocalY: Number(event.target.value) } })}><option value={0}>Top</option><option value={50}>Center</option><option value={100}>Bottom</option></select></label>
            <p className="text-xs leading-5 text-black/55 sm:col-span-2">Print editions place this on its own page and crop it through the bleed. Preflight requires enough pixels for 300 DPI. Ebook placement remains inline.</p>
          </div>}
          <button type="button" className={`${action} justify-self-start`} onClick={() => { if (editor.isEditable) deleteNode(); }}>Remove from chapter</button>
          <p className="text-xs text-black/55">Changes stay in your draft until you save the chapter. Removing artwork here keeps the original file in Assets.</p>
        </div>}
      </div>}
    </> : original?.type === "table" ? <ManuscriptTable node={original} editable={editable} onChange={change} onRemove={() => { if (editor.isEditable) deleteNode(); }} /> : <div className="flex items-center gap-4 border-y border-dashed border-black/25 py-4 font-sans text-xs text-black/60">
      <span className="flex-1">{original?.type === "pageBreak" ? "Page break · starts a new printed page" : `${original?.type ?? "Imported block"} · preserved in manuscript`}</span>
      {editable && <button type="button" aria-label={`Remove ${original?.type === "pageBreak" ? "page break" : "imported block"}`} className={action} onClick={() => { if (editor.isEditable) deleteNode(); }}>Remove</button>}
    </div>}
  </NodeViewWrapper>;
}

function ManuscriptTable({ node, editable, onChange, onRemove }: {
  node: BookNode; editable: boolean; onChange: (node: BookNode) => void; onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const rows = manuscriptTableRows(node);
  const headerRows = manuscriptTableHeaderRows(node);
  const columns = Math.max(1, ...(rows ?? []).map((row) => row.length));
  const changeRows = (next: string[][]) => { if (editable) onChange(withTableRows(node, next)); };
  return <section aria-label="Manuscript table" className="min-w-0 rounded-lg border border-black/20 bg-white/30 p-3">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 font-sans text-xs">
      <span className="text-black/60">Table · {rows?.length ?? 0} rows{headerRows ? ` · ${headerRows} header ${headerRows === 1 ? "row" : "rows"}` : ""}</span>
      {editable && <div className="flex flex-wrap gap-2">
        {rows && <button type="button" className={action} aria-pressed={editing} onClick={() => setEditing((value) => !value)}>{editing ? "Preview table" : "Edit table"}</button>}
        {rows && rows.length > 0 && <button type="button" className={action} aria-pressed={headerRows > 0} onClick={() => onChange({ ...node, attributes: { ...node.attributes, tableHeaderRows: headerRows ? 0 : 1 } })}>{headerRows ? "Remove header marking" : "Use first row as headers"}</button>}
        <button type="button" className={action} onClick={onRemove}>Remove table</button>
      </div>}
    </div>
    {rows ? <div className="max-h-[32rem] overflow-auto" tabIndex={0} role="region" aria-label="Scrollable table cells">
      <table className="w-full border-collapse text-sm"><caption className="sr-only">Manuscript table content</caption><tbody>
        {rows.map((row, r) => <tr key={r}>{Array.from({ length: columns }, (_, c) => {
          const content = editing && editable ? <textarea aria-label={`Row ${r + 1}, column ${c + 1}`} value={row[c] ?? ""} maxLength={100000} rows={2} className="min-h-11 w-full min-w-28 rounded border border-black/25 bg-white px-2 py-1 font-sans text-sm text-black outline-none focus-visible:ring-2 focus-visible:ring-black" onChange={(event) => changeRows(rows.map((cells, index) => index === r ? Array.from({ length: columns }, (_, col) => col === c ? event.target.value : cells[col] ?? "") : cells))} /> : <span className="whitespace-pre-wrap break-words">{row[c] || "\u00a0"}</span>;
          return r < headerRows ? <th key={c} scope="col" className="min-w-24 border border-black/20 bg-stone-200/65 p-2 text-left font-semibold align-top">{content}</th> : <td key={c} className="min-w-24 border border-black/20 p-2 align-top">{content}</td>;
        })}</tr>)}
      </tbody></table>
    </div> : <div><p role="status" className="mb-3 font-sans text-xs text-black/65">Table text was changed outside the grid. Your latest text is preserved below; the old grid is not shown.</p><p className="whitespace-pre-wrap">{node.text}</p></div>}
    {editing && editable && rows && <div className="mt-3 flex flex-wrap gap-2 font-sans">
      <button type="button" className={action} disabled={rows.length >= 2000} onClick={() => changeRows([...rows, Array(columns).fill("")])}>Add row</button>
      <button type="button" className={action} disabled={columns >= 100} onClick={() => changeRows((rows.length ? rows : [[]]).map((row) => [...Array.from({ length: columns }, (_, c) => row[c] ?? ""), ""]))}>Add column</button>
      <p className="basis-full text-xs text-black/60">Edits stay in this draft until you save the chapter. Use Undo to restore a change.</p>
    </div>}
  </section>;
}

export function ArtworkPicker({ workspaceId, onInsert, onClose }: { workspaceId: string; onInsert: (node: BookNode) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [alt, setAlt] = useState("");
  const [decorative, setDecorative] = useState(false);
  const [caption, setCaption] = useState("");
  const [width, setWidth] = useState(100);
  const [printPlacement, setPrintPlacement] = useState<"inline" | "fullBleed">("inline");
  const [focalX, setFocalX] = useState(50);
  const [focalY, setFocalY] = useState(50);
  const preview = usePrivateImage(selected || null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const titleId = useId();
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setSelected("");
    void apiClient().listAssets(workspaceId).then(({ assets: rows }) => {
      if (!cancelled) setAssets(rows.filter((asset) => !asset.deleted_at && asset.checksum !== "pending" && !["archived", "rejected"].includes(asset.status) && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(asset.mime_type)));
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load artwork."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, refresh]);

  return <dialog ref={dialog} aria-labelledby={titleId} onCancel={onClose} className="fixed inset-0 m-auto max-h-[90dvh] w-[min(92vw,780px)] overflow-y-auto rounded-2xl bg-[#f5f1e8] p-5 text-black shadow-2xl backdrop:bg-black/75 sm:p-8">
    <div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-black/50">Manuscript / artwork</p><h2 id={titleId} className="mt-2 font-serif text-3xl">Give this page a picture.</h2></div><button type="button" className={action} onClick={onClose}>Close</button></div>
    <p className="mt-3 text-sm leading-6 text-black/65">Choose a private image from this workspace. Upload or generate artwork in Assets first. Only files cleared for use can be placed.</p>
    {loading ? <p className="py-10 text-sm" role="status">Loading workspace artwork…</p> : error ? <div role="alert" className="py-6"><p>{error}</p><button type="button" className={`${action} mt-3`} onClick={() => setRefresh((v) => v + 1)}>Retry artwork list</button></div> : !assets.length ? <div className="my-6 rounded-xl border border-dashed border-black/25 p-6 text-sm leading-6">No usable images in this workspace yet. Save your chapter before opening Assets to upload or generate an illustration.<button type="button" className={`${action} mt-3 block`} onClick={() => setRefresh((v) => v + 1)}>Refresh library</button></div> : <form className="mt-6 grid gap-6 sm:grid-cols-2" onSubmit={(event) => {
      event.preventDefault();
      if (!selected || !preview.url || loadedUrl !== preview.url || (!decorative && !alt.trim())) return;
      onInsert({ id: crypto.randomUUID(), type: "image", assetId: selected, altText: decorative ? "" : alt.trim(), caption: caption.trim(), attributes: { widthPercent: width, decorative, printPlacement, printFocalX: focalX, printFocalY: focalY } });
    }}>
      <div className="space-y-4">
        <label className="block text-xs text-black/70">Workspace image<select autoFocus required className={field} value={selected} onChange={(event) => { setSelected(event.target.value); setLoadedUrl(null); }}><option value="">Choose artwork…</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
        <label className="block text-xs text-black/70">Image description (alt text)<textarea required={!decorative} disabled={decorative} value={alt} onChange={(event) => setAlt(event.target.value)} maxLength={1000} rows={3} className={field} placeholder="Describe what a reader should know about this picture." /></label>
        <label className="flex min-h-11 items-center gap-2 text-xs text-black/70"><input type="checkbox" checked={decorative} onChange={(event) => setDecorative(event.target.checked)} />This picture is purely decorative</label>
        <label className="block text-xs text-black/70">Caption (optional)<input className={field} value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={2000} /></label>
        <label className="block text-xs text-black/70">Print placement<select value={printPlacement} onChange={(event) => setPrintPlacement(event.target.value as "inline" | "fullBleed")} className={field}><option value="inline">Inside the text area</option><option value="fullBleed">Dedicated full-bleed page</option></select></label>
        {printPlacement === "inline" ? <label className="block text-xs text-black/70">Width<select value={width} onChange={(event) => setWidth(Number(event.target.value))} className={field}><option value={100}>Full text width</option><option value={75}>Three-quarter width</option><option value={50}>Half width</option><option value={25}>Quarter width</option></select></label> : <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs text-black/70">Horizontal focus<select value={focalX} onChange={(event) => setFocalX(Number(event.target.value))} className={field}><option value={0}>Left</option><option value={50}>Center</option><option value={100}>Right</option></select></label><label className="block text-xs text-black/70">Vertical focus<select value={focalY} onChange={(event) => setFocalY(Number(event.target.value))} className={field}><option value={0}>Top</option><option value={50}>Center</option><option value={100}>Bottom</option></select></label><p className="text-xs leading-5 text-black/55 sm:col-span-2">Use with a print edition that has bleed enabled. Preflight checks a 300-DPI source before publishing.</p></div>}
      </div>
      <div className="flex min-h-52 flex-col items-center justify-center rounded-xl border border-black/10 bg-black/[0.035] p-4">
        {preview.url ? <img src={preview.url} alt={decorative ? "" : alt} onLoad={() => setLoadedUrl(preview.url)} onError={preview.fail} referrerPolicy="no-referrer" className="max-h-80 max-w-full object-contain" /> : <p role="status" className="text-center text-sm text-black/60">{preview.error ?? (selected ? "Checking private image access…" : "Your illustration will appear here.")}</p>}
        {preview.error && <button type="button" className={`${action} mt-3`} onClick={preview.retry}>Refresh preview</button>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-black/15 pt-4 sm:col-span-2"><p className="text-xs text-black/60">Inserted at your cursor. Save the chapter to keep it.</p><button type="submit" disabled={!selected || !preview.url || loadedUrl !== preview.url || (!decorative && !alt.trim())} className="min-h-11 rounded-full bg-black px-5 py-2 text-sm font-medium text-white disabled:opacity-40">Insert illustration</button></div>
    </form>}
  </dialog>;
}
