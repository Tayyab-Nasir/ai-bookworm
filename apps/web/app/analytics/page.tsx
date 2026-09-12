"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { RetailerSalesImport, RetailerSalesRowInput, RetailerSalesSummary } from "@bookworm/api-client";
import type { Book, Workspace } from "@bookworm/types";
import { AuthorHeader, AuthorPage } from "../../components/AuthorShell";
import { apiClient } from "../../components/api";
import { parseRetailerSalesCsv } from "../../lib/sales-csv";

const sources = [
  ["amazon_kdp", "Amazon KDP"], ["barnes_noble", "Barnes & Noble Press"], ["apple_books", "Apple Books"],
  ["google_play", "Google Play Books"], ["lulu", "Lulu"], ["other", "Other retailer"],
] as const;

function formatCents(cents: number | null, currency: string | null) {
  if (cents === null || !currency) return "—";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(cents / 100); }
  catch { return `${currency} ${(cents / 100).toFixed(2)}`; }
}

function sourceLabel(source: string) { return sources.find(([value]) => value === source)?.[1] ?? source.replaceAll("_", " "); }

function AnalyticsPageInner() {
  const api = apiClient(); const requested = useSearchParams().get("ws"); const selectionVersion = useRef(0); const input = useRef<HTMLInputElement>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]); const [workspaceId, setWorkspaceId] = useState("");
  const [books, setBooks] = useState<Book[]>([]); const [role, setRole] = useState(""); const [summary, setSummary] = useState<RetailerSalesSummary | null>(null);
  const [imports, setImports] = useState<RetailerSalesImport[]>([]); const [source, setSource] = useState<(typeof sources)[number][0]>("amazon_kdp");
  const [bookId, setBookId] = useState(""); const [supersedeImportId, setSupersedeImportId] = useState(""); const [file, setFile] = useState<File | null>(null); const [rows, setRows] = useState<RetailerSalesRowInput[]>([]); const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextWorkspaceId?: string) => {
    setLoading(true); setError(null);
    try {
      const spaces = await api.listWorkspaces(); setWorkspaces(spaces.workspaces);
      const selected = nextWorkspaceId ?? requested ?? window.localStorage.getItem("bookworm:workspaceId") ?? spaces.workspaces[0]?.id ?? "";
      const id = spaces.workspaces.some((space) => space.id === selected) ? selected : spaces.workspaces[0]?.id ?? "";
      setWorkspaceId(id); if (!id) { setBooks([]); setRole(""); setImports([]); setSummary(null); return; }
      window.localStorage.setItem("bookworm:workspaceId", id);
      const [dashboard, salesResult] = await Promise.all([api.getDashboardOverview(id), api.listRetailerSalesImports(id)]);
      setBooks(dashboard.books); setRole(dashboard.workspace.role); setImports(salesResult.imports); setSummary(salesResult.summary);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load sales data."); }
    finally { setLoading(false); }
  }, [api, requested]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { selectionVersion.current += 1; if (input.current) input.current.value = ""; setBookId(""); setSupersedeImportId(""); setFile(null); setRows([]); setNotice(null); }, [workspaceId]);

  const salesAvailable = summary?.available !== false;
  const canImport = salesAvailable && ["owner", "admin", "editor", "writer"].includes(role);
  const previewCurrencies = [...new Set(rows.map((row) => row.currency))];
  const previewDates = rows.map((row) => row.soldOn).sort();

  async function chooseFile(next: File | null) {
    const selection = ++selectionVersion.current;
    setFile(next); setRows([]); setError(null); setNotice(null);
    if (!next) return;
    try {
      const parsed = parseRetailerSalesCsv(await next.text());
      if (selectionVersion.current !== selection) return;
      setRows(parsed);
    } catch (reason) {
      if (selectionVersion.current !== selection) return;
      setFile(null); if (input.current) input.current.value = ""; setError(reason instanceof Error ? reason.message : "Could not read this CSV.");
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!workspaceId || !file || !rows.length || busy || !canImport) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const importedRows = rows.map((row) => ({ ...row, bookId: bookId || null }));
      const result = await api.importRetailerSales({ workspaceId, source, fileName: file.name, supersedeImportId: supersedeImportId || null, rows: importedRows });
      setNotice(result.duplicate ? `This report was already imported (${result.rowCount} rows).` : `${result.rowCount} retailer sales rows imported.`);
      setFile(null); setRows([]); if (input.current) input.current.value = ""; await load(workspaceId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not import retailer report."); }
    finally { setBusy(false); }
  }

  const multiCurrency = Boolean(summary?.currencies.length && !summary.currency);
  return <AuthorPage><AuthorHeader /><main className="mx-auto max-w-7xl px-4 pb-20 pt-8 sm:px-6 lg:px-8 lg:pt-12">
    <section className="relative overflow-hidden border-b border-white/[0.11] pb-10">
      <div className="pointer-events-none absolute -right-10 top-0 select-none font-instrument text-[13rem] italic leading-none text-white/[0.035]">$</div>
      <p className="relative text-[11px] font-medium uppercase tracking-[0.22em] text-[#8f8f8f]">Retailer ledger</p>
      <div className="relative mt-3 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between"><div>
        <h1 className="max-w-[11ch] text-5xl font-medium leading-[0.88] tracking-[-0.065em] sm:text-6xl">Sales, <span className="font-instrument font-normal italic text-[#c5c5c5]">with receipts.</span></h1>
        <p className="mt-5 max-w-xl text-[15px] leading-6 text-[#989898]">Import retailer reports. Bookworm preserves source-backed totals and keeps currencies separate instead of guessing at conversion.</p>
      </div><Link href="/dashboard" className="glass-ghost relative inline-flex h-11 items-center rounded-full px-5 text-sm text-white/75">Back to desk</Link></div>
    </section>

    {workspaces.length > 1 && <label className="mt-6 inline-flex items-center gap-3 text-sm text-white/60">Workspace <select value={workspaceId} disabled={loading} onChange={(event) => void load(event.target.value)} className="rounded-xl border border-white/15 bg-black px-4 py-2 text-white">{workspaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>}
    {error && <div role="alert" className="mt-6 rounded-2xl border border-red-400/20 bg-red-400/[0.08] px-5 py-4 text-sm text-red-100">{error}</div>}
    {notice && <div role="status" className="mt-6 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.08] px-5 py-4 text-sm text-emerald-100">{notice}</div>}

    <section className="mt-8 grid gap-4 lg:grid-cols-[1.16fr_0.84fr]" aria-label="Retail sales summary">
      <div className="rounded-3xl border border-white/[0.11] bg-[linear-gradient(135deg,rgba(255,255,255,.09),rgba(255,255,255,.018)_52%,rgba(255,255,255,.05))] p-6 sm:p-8">
        <div className="flex items-start justify-between gap-4"><div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">Reported royalty</p><p className="mt-4 text-5xl font-medium tracking-[-0.07em]">{loading ? "…" : formatCents(summary?.royaltyCents ?? null, summary?.currency ?? null)}</p></div><span className={`rounded-full border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] ${summary?.status === "imported" ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100" : "border-amber-200/20 bg-amber-100/[0.06] text-amber-100"}`}>{summary?.available === false ? "Unavailable" : summary?.status === "imported" ? "Imported" : "Awaiting report"}</span></div>
        <div className="mt-10 grid gap-5 border-t border-white/[0.1] pt-5 sm:grid-cols-3"><div><p className="text-xs text-white/45">Net units</p><p className="mt-2 text-2xl font-medium">{summary?.units?.toLocaleString() ?? "—"}</p></div><div><p className="text-xs text-white/45">Reported proceeds</p><p className="mt-2 text-2xl font-medium">{formatCents(summary?.reportedProceedsCents ?? null, summary?.currency ?? null)}</p></div><div><p className="text-xs text-white/45">Reports</p><p className="mt-2 text-2xl font-medium">{summary?.imports ?? 0}</p></div></div>
        {multiCurrency && <p className="mt-6 border-t border-amber-100/10 pt-5 text-xs leading-5 text-amber-100/70">Multiple currencies found. Top-line money totals stay blank; use the separate currency records below.</p>}
      </div>
      <form onSubmit={(event) => void submit(event)} aria-busy={busy} className="rounded-3xl border border-white/[0.11] bg-white/[0.025] p-6 sm:p-7"><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#858585]">Import report</p><h2 className="mt-2 text-2xl font-medium tracking-[-0.045em]">Add a sales receipt</h2><p className="mt-3 text-sm leading-6 text-white/45">CSV only. Use ISO dates (`YYYY-MM-DD`), ISO currency codes, whole-number units, and decimal royalty amounts.</p>
        {!loading && !salesAvailable && <p className="mt-4 rounded-xl border border-amber-200/15 bg-amber-100/[0.05] p-3 text-xs leading-5 text-amber-100/75">{summary?.message}</p>}
        {!loading && salesAvailable && !canImport && <p className="mt-4 rounded-xl border border-white/[0.1] bg-white/[0.03] p-3 text-xs leading-5 text-white/50">Your workspace role can view sales reports, but only owners, admins, editors, and writers can import one.</p>}
        <fieldset disabled={!canImport || busy} className="disabled:opacity-45"><label className="mt-5 block text-xs text-white/55">Retailer<select value={source} onChange={(event) => setSource(event.target.value as typeof source)} className="mt-2 block w-full rounded-xl border border-white/15 bg-black px-3 py-2.5 text-sm text-white">{sources.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="mt-4 block text-xs text-white/55">Apply rows to one book <span className="text-white/30">optional</span><select value={bookId} onChange={(event) => setBookId(event.target.value)} className="mt-2 block w-full rounded-xl border border-white/15 bg-black px-3 py-2.5 text-sm text-white"><option value="">Leave unmatched</option>{books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}</select></label>
        <label className="mt-4 block text-xs text-white/55">Replace a prior report <span className="text-white/30">optional</span><select value={supersedeImportId} onChange={(event) => setSupersedeImportId(event.target.value)} className="mt-2 block w-full rounded-xl border border-white/15 bg-black px-3 py-2.5 text-sm text-white"><option value="">Add alongside current reports</option>{imports.filter((item) => !item.superseded_at).map((item) => <option key={item.id} value={item.id}>{item.file_name} · {item.period_start} — {item.period_end}</option>)}</select></label>
        <label className="mt-4 block cursor-pointer rounded-2xl border border-dashed border-white/20 bg-white/[0.025] p-4 text-sm text-white/65 hover:border-white/40"><input ref={input} required type="file" accept=".csv,text/csv" onChange={(event) => void chooseFile(event.target.files?.[0] ?? null)} className="sr-only" /><span className="block font-medium text-white">{file ? file.name : "Choose retailer CSV"}</span><span className="mt-1 block text-xs text-white/40">Maximum 256 KB · maximum 2,000 rows</span></label>
        {rows.length > 0 && <div className="mt-4 rounded-xl border border-white/[0.1] bg-black/30 p-3 text-xs text-white/55"><p className="font-medium text-white/85">{rows.length.toLocaleString()} rows ready · {previewCurrencies.join(", ")}</p><p className="mt-1">{previewDates[0]} — {previewDates.at(-1)} · {bookId ? "Will match selected book" : "Rows remain unmatched"}</p><ul className="mt-3 space-y-1 border-t border-white/[0.08] pt-2 text-white/40">{rows.slice(0, 3).map((row, index) => <li key={`${row.soldOn}-${index}`} className="truncate">{row.soldOn} · {row.title} · {row.units} units</li>)}</ul></div>}
        <button disabled={!workspaceId || !file || !rows.length || busy} className="glass-solid metal-shine mt-5 min-h-11 w-full rounded-full px-5 text-sm font-semibold text-black disabled:opacity-40"><span className="relative z-10">{busy ? "Importing report…" : rows.length ? `Import ${rows.length.toLocaleString()} verified rows` : "Import verified rows"}</span></button></fieldset>
      </form>
    </section>

    {summary?.currencies.length ? <section className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Currency breakdown">{summary.currencies.map((currency) => <article key={currency.currency} className="rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5"><p className="text-[11px] font-medium uppercase tracking-[0.16em] text-white/45">{currency.currency}</p><p className="mt-3 text-2xl font-medium">{formatCents(currency.royaltyCents, currency.currency)}</p><p className="mt-2 text-xs text-white/45">{currency.units.toLocaleString()} net units · reported {formatCents(currency.reportedProceedsCents, currency.currency)}</p></article>)}</section> : null}
    <section className="mt-12"><div className="flex items-end justify-between gap-4"><div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#858585]">Source trail</p><h2 className="mt-2 text-2xl font-medium tracking-[-0.045em]">Imported reports</h2></div><span className="text-xs text-white/40">{imports.length} saved</span></div>
      <div className="mt-5 overflow-hidden rounded-2xl border border-white/[0.09]">{imports.length ? <ul className="divide-y divide-white/[0.08]">{imports.map((item) => <li key={item.id} className="grid gap-2 p-5 text-sm sm:grid-cols-[1.2fr_.8fr_.7fr_.5fr]"><div><p className="font-medium">{item.file_name}</p><p className="mt-1 text-xs text-white/40">{sourceLabel(item.source)}{item.superseded_at ? " · superseded" : ""}</p></div><p className="text-white/55">{item.period_start} — {item.period_end}</p><p className="text-white/55">{item.row_count.toLocaleString()} rows</p><p className="text-white/40">{new Date(item.created_at).toLocaleDateString()}</p></li>)}</ul> : <div className="p-8 text-sm text-white/45">No retailer report saved yet. Import a source file above; publishing packages do not count as sales.</div>}</div>
    </section>
  </main></AuthorPage>;
}

export default function AnalyticsPage() {
  return <Suspense fallback={<AuthorPage><AuthorHeader /><main className="mx-auto max-w-7xl px-4 py-12 text-sm text-white/50 sm:px-6 lg:px-8">Loading sales ledger…</main></AuthorPage>}><AnalyticsPageInner /></Suspense>;
}
