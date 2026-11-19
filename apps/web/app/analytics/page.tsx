"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, type DashboardOverview, type RetailerSalesRowInput } from "@bookworm/api-client";
import type { Workspace } from "@bookworm/types";
import { AuthorHeader, AuthorPage } from "../../components/AuthorShell";
import { apiClient } from "../../components/api";
import { parseRetailerSalesCsv } from "../../lib/sales-csv";
import { buildSalesTrend } from "../../lib/sales-analytics";
import { readBrowserSession } from "../../lib/browser-session";
import { rememberWorkspace, replaceWorkspaceQuery, resolveWorkspace } from "../../lib/workspace-selection";

const sources = [
  ["amazon_kdp", "Amazon KDP"], ["barnes_noble", "Barnes & Noble Press"], ["apple_books", "Apple Books"],
  ["google_play", "Google Play Books"], ["lulu", "Lulu"], ["other", "Other retailer"],
] as const;
type SalesSelection = { requested: string | null; selected?: string };
type SalesResponse = Awaited<ReturnType<ReturnType<typeof apiClient>["listRetailerSalesImports"]>>;
type SalesSnapshot =
  | { kind: "loading" }
  | { kind: "no-workspace"; context: SalesSelection }
  | { kind: "unavailable"; context: SalesSelection; workspaceId: string; workspaces: Workspace[]; message: string }
  | { kind: "ready"; context: SalesSelection; workspaceId: string; workspaces: Workspace[]; actor: string; generation: number; dashboard: DashboardOverview; sales: SalesResponse };
type ImportAction = { generation: number; context: SalesSelection; workspaceId: string; actor: string; confirmation?: string };

function formatCents(cents: number | null, currency: string | null) {
  if (cents === null || !currency) return "—";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(cents / 100); }
  catch { return `${currency} ${(cents / 100).toFixed(2)}`; }
}

function sourceLabel(source: string) { return sources.find(([value]) => value === source)?.[1] ?? source.replaceAll("_", " "); }
function monthLabel(month: string) { return new Date(`${month}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" }); }

function AnalyticsPageInner() {
  const requested = useSearchParams().get("ws"); const selectionVersion = useRef(0); const requestVersion = useRef(0); const input = useRef<HTMLInputElement>(null);
  const [snapshot, setSnapshot] = useState<SalesSnapshot>({ kind: "loading" });
  const [source, setSource] = useState<(typeof sources)[number][0]>("amazon_kdp");
  const [salesCurrency, setSalesCurrency] = useState("");
  const [bookId, setBookId] = useState(""); const [supersedeImportId, setSupersedeImportId] = useState(""); const [file, setFile] = useState<File | null>(null); const [rows, setRows] = useState<RetailerSalesRowInput[]>([]);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<string | null>(null); const [actionError, setActionError] = useState<string | null>(null);
  const mounted = useRef(true); const currentAction = useRef<ImportAction | null>(null);
  const verifiedActor = useRef<string | null>(null);
  const currentContext = useRef<SalesSelection>({ requested });
  if (currentContext.current.requested !== requested) {
    // Keep the verified selection when its own URL update is observed.
    if (currentContext.current.selected === requested) currentContext.current.requested = requested;
    else currentContext.current = { requested };
  }
  const context = currentContext.current;
  const view = snapshot.kind === "loading" || snapshot.context === context ? snapshot : { kind: "loading" } as const;
  const ready = view.kind === "ready" ? view : null;
  const loading = view.kind === "loading";
  const workspaces = view.kind === "ready" || view.kind === "unavailable" ? view.workspaces : [];
  const workspaceId = view.kind === "ready" || view.kind === "unavailable" ? view.workspaceId : "";
  const { summary, analytics, imports = [] } = ready?.sales ?? {};
  const books = ready?.dashboard.books ?? [];
  const error = view.kind === "unavailable" ? view.message : ready ? actionError : null;
  const actionIsCurrent = (action: ImportAction) => mounted.current && currentAction.current === action
    && action.context === currentContext.current && action.generation === requestVersion.current;
  const viewIsCurrent = () => mounted.current && context === currentContext.current && ready?.generation === requestVersion.current;

  const load = useCallback(async (nextWorkspaceId?: string, owner?: ImportAction) => {
    if (!mounted.current || context !== currentContext.current || (owner && !actionIsCurrent(owner))) return;
    if (!owner) { currentAction.current = null; setBusy(false); }
    const current = ++requestVersion.current;
    // The accepted import retains ownership through its own receipt reload.
    if (owner) owner.generation = current;
    const isCurrent = () => mounted.current && context === currentContext.current && current === requestVersion.current;
    if (nextWorkspaceId !== undefined) context.selected = nextWorkspaceId;
    const target = owner?.workspaceId ?? context.selected ?? context.requested;
    verifiedActor.current = null;
    selectionVersion.current++; if (input.current) input.current.value = "";
    setBookId(""); setSupersedeImportId(""); setFile(null); setRows([]); setNotice(null);
    setSnapshot({ kind: "loading" }); setActionError(null);
    let verifiedWorkspaces: Workspace[] = [];
    let verifiedWorkspaceId = "";
    try {
      const { id: actor } = await readBrowserSession();
      if (!isCurrent()) return;
      const api = apiClient(actor);
      let workspaces: Workspace[] = [];
      let workspaceId = "";
      const [result] = await Promise.allSettled([(async () => {
        workspaces = (await api.listWorkspaces()).workspaces;
        if (!isCurrent()) return null;
        const selected = resolveWorkspace(workspaces, target);
        if (!selected) return null;
        workspaceId = selected.id;
        const [dashboard, sales] = await Promise.all([api.getDashboardOverview(workspaceId), api.listRetailerSalesImports(workspaceId)]);
        if (dashboard.viewerId !== actor || dashboard.workspace.id !== workspaceId
          || dashboard.books.some(book => book.workspace_id !== workspaceId)
          || sales.imports.some(report => report.workspace_id !== workspaceId)) {
          throw new Error("Sales data did not match the selected account and workspace.");
        }
        return { dashboard, sales };
      })()]);
      if (!isCurrent()) return;
      // A failed ledger read can coexist with a confirmed import for this actor.
      await readBrowserSession(actor);
      if (!isCurrent()) return;
      verifiedActor.current = actor;
      verifiedWorkspaces = workspaces;
      verifiedWorkspaceId = workspaceId;
      if (owner?.actor === actor && owner.confirmation) setNotice(owner.confirmation);
      if (result.status === "rejected") throw result.reason;
      if (!result.value) { setSnapshot({ kind: "no-workspace", context }); return; }
      rememberWorkspace(workspaces, workspaceId);
      if (nextWorkspaceId !== undefined) replaceWorkspaceQuery(workspaceId);
      setSnapshot({ kind: "ready", context, actor, generation: current, workspaces, workspaceId, ...result.value });
    } catch (reason) {
      if (isCurrent()) setSnapshot({ kind: "unavailable", context, workspaces: verifiedWorkspaces, workspaceId: verifiedWorkspaceId,
        message: reason instanceof Error ? reason.message : "Could not load sales data." });
    }
  }, [context]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const recheck = async () => {
      const actor = verifiedActor.current;
      const current = requestVersion.current;
      if (!actor || document.visibilityState === "hidden") return;
      try { await readBrowserSession(actor); }
      catch { if (mounted.current && current === requestVersion.current) void load(); }
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      mounted.current = false; requestVersion.current++; selectionVersion.current++;
      currentAction.current = null; verifiedActor.current = null;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [load]);

  const salesAvailable = summary?.available === true;
  const canImport = salesAvailable && ["owner", "admin", "editor", "writer"].includes(ready?.dashboard.workspace.role ?? "");
  const previewCurrencies = [...new Set(rows.map((row) => row.currency))];
  const previewDates = rows.map((row) => row.soldOn).sort();
  const analyticsCurrencies = [...new Set([
    ...(analytics?.monthly.map((item) => item.currency) ?? []),
    ...(analytics?.books.map((item) => item.currency) ?? []),
    ...(analytics?.sources.map((item) => item.currency) ?? []),
  ])].sort();
  const activeSalesCurrency = analyticsCurrencies.includes(salesCurrency) ? salesCurrency : analyticsCurrencies[0] ?? "";
  const trend = analytics && activeSalesCurrency
    ? buildSalesTrend(analytics.monthly, activeSalesCurrency, analytics.windowStart, analytics.monthCount)
    : [];
  const booksForCurrency = analytics?.books.filter((item) => item.currency === activeSalesCurrency) ?? [];
  const sourcesForCurrency = analytics?.sources.filter((item) => item.currency === activeSalesCurrency) ?? [];
  const maxRoyaltyMagnitude = Math.max(1, ...trend.map((item) => Math.abs(item.royaltyCents ?? 0)));

  async function chooseFile(next: File | null) {
    if (!viewIsCurrent() || currentAction.current || !canImport) return;
    const selection = ++selectionVersion.current;
    setFile(next); setRows([]); setActionError(null); setNotice(null);
    if (!next) return;
    try {
      const parsed = parseRetailerSalesCsv(await next.text());
      if (!viewIsCurrent() || selectionVersion.current !== selection) return;
      setRows(parsed);
    } catch (reason) {
      if (!viewIsCurrent() || selectionVersion.current !== selection) return;
      setFile(null); if (input.current) input.current.value = ""; setActionError(reason instanceof Error ? reason.message : "Could not read this CSV.");
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || !viewIsCurrent() || currentAction.current || !file || !rows.length || !canImport) return;
    const owner: ImportAction = { generation: ready.generation, context, workspaceId, actor: ready.actor };
    currentAction.current = owner;
    const isCurrent = () => actionIsCurrent(owner);
    setBusy(true); setActionError(null); setNotice(null);
    try {
      const importedRows = rows.map((row) => ({ ...row, bookId: bookId || null }));
      const result = await apiClient(owner.actor).importRetailerSales({ workspaceId, source, fileName: file.name, supersedeImportId: supersedeImportId || null, rows: importedRows });
      if (!isCurrent()) return;
      if (typeof result.importId !== "string" || !result.importId || result.rowCount !== importedRows.length || typeof result.duplicate !== "boolean") {
        throw new Error("The sales import receipt could not be verified.");
      }
      const count = `${result.rowCount} ${result.rowCount === 1 ? "row" : "rows"}`;
      owner.confirmation = result.duplicate ? `This report was already imported (${count}).` : `Imported ${count} from the retailer report.`;
      await load(undefined, owner);
    } catch (reason) {
      if (!isCurrent()) return;
      if (reason instanceof ApiClientError && (reason.status === 401 || reason.status === 403 || (reason.status === 409 && reason.code === "auth_error"))) {
        await load(undefined, owner);
      } else {
        const problem = reason instanceof Error ? reason.message : "The sales import could not be confirmed.";
        const rejected = reason instanceof ApiClientError && reason.status >= 400 && reason.status < 500
          && reason.status !== 408 && reason.code !== "invalid_response";
        setActionError(rejected ? problem : `${problem} Refresh reports to check what was saved before changing this import.`);
      }
    }
    finally { if (isCurrent()) { currentAction.current = null; setBusy(false); } }
  }

  const multiCurrency = Boolean(summary?.currencies.length && !summary.currency);
  const salesStatus = loading ? "Checking" : view.kind === "no-workspace" ? "Choose a workspace"
    : !salesAvailable ? "Unavailable" : summary?.status === "imported" ? "Imported" : "Awaiting report";
  return <AuthorPage><AuthorHeader workspaceId={workspaceId || undefined} /><main className="mx-auto max-w-7xl px-4 pb-20 pt-8 sm:px-6 lg:px-8 lg:pt-12">
    <section className="relative overflow-hidden border-b border-white/[0.11] pb-10">
      <div className="pointer-events-none absolute -right-10 top-0 select-none font-instrument text-[13rem] italic leading-none text-white/[0.035]">$</div>
      <p className="relative text-[11px] font-medium uppercase tracking-[0.22em] text-[#8f8f8f]">Retailer ledger</p>
      <div className="relative mt-3 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between"><div>
        <h1 className="max-w-[11ch] text-5xl font-medium leading-[0.88] tracking-[-0.065em] sm:text-6xl">Sales, <span className="font-instrument font-normal italic text-[#c5c5c5]">with receipts.</span></h1>
        <p className="mt-5 max-w-xl text-[15px] leading-6 text-[#989898]">Import retailer reports. Bookworm preserves source-backed totals and keeps currencies separate instead of guessing at conversion.</p>
      </div><Link href={workspaceId ? `/dashboard?ws=${encodeURIComponent(workspaceId)}` : "/dashboard"} className="glass-ghost relative inline-flex h-11 items-center rounded-full px-5 text-sm text-white/75">Back to desk</Link></div>
    </section>

    <div className="mt-6 flex flex-wrap items-center gap-3">
      {workspaces.length > 0 && <label className="inline-flex items-center gap-3 text-sm text-white/60">Workspace <select value={workspaceId} disabled={loading || busy} onChange={(event) => void load(event.target.value)} className="rounded-xl border border-white/15 bg-black px-4 py-2 text-white"><option value="" disabled>Select a workspace</option>{workspaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>}
      <button type="button" disabled={loading || busy} onClick={() => void load()} className="glass-ghost min-h-11 rounded-full px-4 py-2 text-sm disabled:opacity-40">Refresh reports</button>
    </div>
    {error && <div role="alert" className="mt-6 rounded-2xl border border-red-400/20 bg-red-400/[0.08] px-5 py-4 text-sm text-red-100">{error}</div>}
    {!loading && notice && <div role="status" className="mt-6 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.08] px-5 py-4 text-sm text-emerald-100">{notice}</div>}

    <section className="mt-8 grid gap-4 lg:grid-cols-[1.16fr_0.84fr]" aria-label="Retail sales summary" aria-busy={loading}>
      <div className="rounded-3xl border border-white/[0.11] bg-[linear-gradient(135deg,rgba(255,255,255,.09),rgba(255,255,255,.018)_52%,rgba(255,255,255,.05))] p-6 sm:p-8">
        <div className="flex items-start justify-between gap-4"><div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">Reported royalty</p><p className="mt-4 text-5xl font-medium tracking-[-0.07em]">{loading ? "…" : formatCents(summary?.royaltyCents ?? null, summary?.currency ?? null)}</p></div><span className={`rounded-full border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] ${salesStatus === "Imported" ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100" : "border-amber-200/20 bg-amber-100/[0.06] text-amber-100"}`}>{salesStatus}</span></div>
        <div className="mt-10 grid gap-5 border-t border-white/[0.1] pt-5 sm:grid-cols-3"><div><p className="text-xs text-white/45">Net units</p><p className="mt-2 text-2xl font-medium">{summary?.units?.toLocaleString() ?? "—"}</p></div><div><p className="text-xs text-white/45">Reported proceeds</p><p className="mt-2 text-2xl font-medium">{formatCents(summary?.reportedProceedsCents ?? null, summary?.currency ?? null)}</p></div><div><p className="text-xs text-white/45">Reports</p><p className="mt-2 text-2xl font-medium">{salesAvailable ? summary?.imports : "—"}</p></div></div>
        {multiCurrency && <p className="mt-6 border-t border-amber-100/10 pt-5 text-xs leading-5 text-amber-100/70">Multiple currencies found. Top-line money totals stay blank; use the separate currency records below.</p>}
      </div>
      <form onSubmit={(event) => void submit(event)} aria-busy={busy} className="rounded-3xl border border-white/[0.11] bg-white/[0.025] p-6 sm:p-7"><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#858585]">Import report</p><h2 className="mt-2 text-2xl font-medium tracking-[-0.045em]">Add a sales receipt</h2><p className="mt-3 text-sm leading-6 text-white/45">CSV only. Use ISO dates (`YYYY-MM-DD`), ISO currency codes, whole-number units, and decimal royalty amounts.</p>
        {summary?.available === false && <p className="mt-4 rounded-xl border border-amber-200/15 bg-amber-100/[0.05] p-3 text-xs leading-5 text-amber-100/75">{summary.message}</p>}
        {salesAvailable && !canImport && <p className="mt-4 rounded-xl border border-white/[0.1] bg-white/[0.03] p-3 text-xs leading-5 text-white/50">Your workspace role can view sales reports, but only owners, admins, editors, and writers can import one.</p>}
        <fieldset disabled={!canImport || busy} className="disabled:opacity-45"><label className="mt-5 block text-xs text-white/55">Retailer<select value={source} onChange={(event) => setSource(event.target.value as typeof source)} className="mt-2 block w-full rounded-xl border border-white/15 bg-black px-3 py-2.5 text-sm text-white">{sources.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="mt-4 block text-xs text-white/55">Apply rows to one book <span className="text-white/30">optional</span><select value={bookId} onChange={(event) => setBookId(event.target.value)} className="mt-2 block w-full rounded-xl border border-white/15 bg-black px-3 py-2.5 text-sm text-white"><option value="">Leave unmatched</option>{books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}</select></label>
        <label className="mt-4 block text-xs text-white/55">Replace a prior report <span className="text-white/30">optional</span><select value={supersedeImportId} onChange={(event) => setSupersedeImportId(event.target.value)} className="mt-2 block w-full rounded-xl border border-white/15 bg-black px-3 py-2.5 text-sm text-white"><option value="">Add alongside current reports</option>{imports.filter((item) => !item.superseded_at).map((item) => <option key={item.id} value={item.id}>{item.file_name} · {item.period_start} — {item.period_end}</option>)}</select></label>
        <label className="mt-4 block cursor-pointer rounded-2xl border border-dashed border-white/20 bg-white/[0.025] p-4 text-sm text-white/65 hover:border-white/40"><input ref={input} required type="file" accept=".csv,text/csv" onChange={(event) => void chooseFile(event.target.files?.[0] ?? null)} className="sr-only" /><span className="block font-medium text-white">{ready && file ? file.name : "Choose retailer CSV"}</span><span className="mt-1 block text-xs text-white/40">Maximum 256 KB · maximum 2,000 rows</span></label>
        {ready && rows.length > 0 && <div className="mt-4 rounded-xl border border-white/[0.1] bg-black/30 p-3 text-xs text-white/55"><p className="font-medium text-white/85">{rows.length.toLocaleString()} rows ready · {previewCurrencies.join(", ")}</p><p className="mt-1">{previewDates[0]} — {previewDates.at(-1)} · {bookId ? "Will match selected book" : "Rows remain unmatched"}</p><ul className="mt-3 space-y-1 border-t border-white/[0.08] pt-2 text-white/40">{rows.slice(0, 3).map((row, index) => <li key={`${row.soldOn}-${index}`} className="truncate">{row.soldOn} · {row.title} · {row.units} units</li>)}</ul></div>}
        <button disabled={!workspaceId || !file || !rows.length || busy} className="glass-solid metal-shine mt-5 min-h-11 w-full rounded-full px-5 text-sm font-semibold text-black disabled:opacity-40"><span className="relative z-10">{busy ? "Importing report…" : rows.length ? `Import ${rows.length.toLocaleString()} verified rows` : "Import verified rows"}</span></button></fieldset>
      </form>
    </section>

    {summary?.currencies.length ? <section className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Currency breakdown">{summary.currencies.map((currency) => <article key={currency.currency} className="rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5"><p className="text-[11px] font-medium uppercase tracking-[0.16em] text-white/45">{currency.currency}</p><p className="mt-3 text-2xl font-medium">{formatCents(currency.royaltyCents, currency.currency)}</p><p className="mt-2 text-xs text-white/45">{currency.units.toLocaleString()} net units · reported {formatCents(currency.reportedProceedsCents, currency.currency)}</p></article>)}</section> : null}

    <section className="mt-12 border-t border-white/[0.11] pt-10" aria-labelledby="sales-performance-title" aria-busy={loading}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#858585]">Performance</p><h2 id="sales-performance-title" className="mt-2 text-2xl font-medium tracking-[-0.045em]">Reported activity</h2><p className="mt-2 max-w-xl text-sm leading-6 text-white/45">Trends reflect imported retailer rows only. Missing report months stay unknown, and currencies are never combined.</p></div>
        {analyticsCurrencies.length > 0 && <label htmlFor="sales-currency" className="text-xs text-white/50">View currency<select id="sales-currency" value={activeSalesCurrency} onChange={(event) => setSalesCurrency(event.target.value)} className="mt-2 block min-h-10 rounded-xl border border-white/15 bg-black px-3 text-sm text-white">{analyticsCurrencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}</select></label>}
      </div>

      {loading && <p role="status" className="mt-5 rounded-2xl border border-white/[0.09] bg-white/[0.025] p-6 text-sm text-white/50">Loading imported sales analytics…</p>}
      {!loading && analytics?.available === false && <p role="status" className="mt-5 rounded-2xl border border-amber-200/15 bg-amber-100/[0.04] p-5 text-sm leading-6 text-amber-100/70">{analytics.message}</p>}
      {!loading && analytics?.available && analyticsCurrencies.length === 0 && <div className="mt-5 rounded-2xl border border-dashed border-white/[0.14] p-7 text-sm leading-6 text-white/50">{imports.length === 0 ? "No retailer rows are imported yet. Add a verified report above to build your performance history." : `No imported rows fall within this ${analytics.monthCount}-month view. Older reports remain listed below; an empty month is not treated as zero sales.`}</div>}

      {!loading && analytics?.available && activeSalesCurrency && <>
        <div className="mt-5 grid gap-4 xl:grid-cols-[1.3fr_.7fr]">
          <article className="min-w-0 rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 sm:p-6">
            <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-sm font-medium text-white/85">Reported royalties by month</h3><p className="mt-1 text-xs text-white/40">{analytics.monthCount} calendar months · {activeSalesCurrency}</p></div><span className="text-[11px] text-white/40">Positive / correction</span></div>
            <div className="mt-5 overflow-x-auto" aria-hidden="true"><div className="flex min-w-[690px] items-stretch justify-between gap-2">
              {trend.map((point) => {
                const amount = point.royaltyCents ?? 0;
                const barHeight = amount === 0 ? 0 : Math.max(3, Math.abs(amount) / maxRoyaltyMagnitude * 46);
                return <div key={point.month} className="flex min-w-10 flex-1 flex-col items-center text-center">
                  <div className="relative h-28 w-full max-w-11">
                    <span className="absolute inset-x-0 top-1/2 border-t border-white/[0.14]" />
                    {barHeight > 0 && <span className={`absolute inset-x-1 rounded-sm ${amount < 0 ? "top-1/2 bg-amber-200/70" : "bottom-1/2 bg-emerald-200/70"}`} style={{ height: `${barHeight}%` }} />}
                  </div><span className="mt-2 whitespace-nowrap text-[10px] text-white/45">{monthLabel(point.month)}</span>
                </div>;
              })}
            </div></div>
            <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[600px] border-collapse text-left text-xs">
              <caption className="sr-only">Imported retailer activity by month in {activeSalesCurrency}</caption>
              <thead className="text-[10px] uppercase tracking-[0.12em] text-white/35"><tr className="border-b border-white/[0.08]"><th scope="col" className="py-2 pr-3 font-medium">Month</th><th scope="col" className="py-2 pr-3 font-medium">Report rows</th><th scope="col" className="py-2 pr-3 text-right font-medium">Net units</th><th scope="col" className="py-2 pr-3 text-right font-medium">Proceeds</th><th scope="col" className="py-2 text-right font-medium">Royalties</th></tr></thead>
              <tbody className="divide-y divide-white/[0.06]">{trend.map((point) => <tr key={point.month}>
                <th scope="row" className="py-3 pr-3 font-medium text-white/70">{monthLabel(point.month)}</th>
                <td className="py-3 pr-3 text-white/45">{point.hasImportedRows ? "Imported" : "No imported rows"}</td>
                <td className="py-3 pr-3 text-right tabular-nums text-white/65">{point.units?.toLocaleString() ?? "—"}</td>
                <td className="py-3 pr-3 text-right tabular-nums text-white/65">{formatCents(point.reportedProceedsCents, activeSalesCurrency)}</td>
                <td className="py-3 text-right tabular-nums text-white/80">{formatCents(point.royaltyCents, activeSalesCurrency)}</td>
              </tr>)}</tbody>
            </table></div>
          </article>

          <article className="rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 sm:p-6">
            <div><h3 className="text-sm font-medium text-white/85">Retailer breakdown</h3><p className="mt-1 text-xs text-white/40">Imported royalties · {activeSalesCurrency}</p></div>
            {sourcesForCurrency.length ? <ul className="mt-4 divide-y divide-white/[0.07]">{sourcesForCurrency.map((item) => <li key={item.source} className="flex items-center justify-between gap-4 py-3"><div><p className="text-sm text-white/75">{sourceLabel(item.source)}</p><p className="mt-1 text-xs text-white/40">{item.units.toLocaleString()} net units</p></div><p className="shrink-0 text-sm tabular-nums text-white/80">{formatCents(item.royaltyCents, item.currency)}</p></li>)}</ul> : <p className="mt-5 text-sm text-white/45">No retailer totals in this currency yet.</p>}
          </article>
        </div>

        <article className="mt-4 rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-sm font-medium text-white/85">Book performance</h3><p className="mt-1 text-xs text-white/40">Highest reported royalties · {activeSalesCurrency}</p></div>{analytics.booksTruncated && <span className="text-[11px] text-amber-100/65">Breakdown is capped at 100 book/currency groups; some groups may be omitted.</span>}</div>
          {booksForCurrency.length ? <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[620px] border-collapse text-left text-sm">
            <caption className="sr-only">Imported retailer performance by book in {activeSalesCurrency}</caption>
            <thead className="text-[10px] uppercase tracking-[0.12em] text-white/35"><tr className="border-b border-white/[0.08]"><th scope="col" className="py-2 pr-4 font-medium">Book / report title</th><th scope="col" className="py-2 pr-4 text-right font-medium">Net units</th><th scope="col" className="py-2 pr-4 text-right font-medium">Proceeds</th><th scope="col" className="py-2 pr-4 text-right font-medium">Royalties</th><th scope="col" className="py-2 text-right font-medium">Reported dates</th></tr></thead>
            <tbody className="divide-y divide-white/[0.06]">{booksForCurrency.slice(0, 10).map((item, index) => <tr key={`${item.bookId ?? "unmatched"}:${item.title}:${index}`}>
              <th scope="row" className="py-3 pr-4 font-medium text-white/75">{item.title}{!item.bookId && <span className="ml-2 text-[10px] font-normal uppercase tracking-wide text-white/35">Unmatched</span>}</th>
              <td className="py-3 pr-4 text-right tabular-nums text-white/60">{item.units.toLocaleString()}</td>
              <td className="py-3 pr-4 text-right tabular-nums text-white/60">{formatCents(item.reportedProceedsCents, item.currency)}</td>
              <td className="py-3 pr-4 text-right tabular-nums text-white/80">{formatCents(item.royaltyCents, item.currency)}</td>
              <td className="whitespace-nowrap py-3 text-right text-xs text-white/40">{item.firstSoldOn} — {item.lastSoldOn}</td>
            </tr>)}</tbody>
          </table>{booksForCurrency.length > 10 && <p className="mt-3 text-xs text-white/35">Showing 10 of {booksForCurrency.length} returned book groups in {activeSalesCurrency}.</p>}</div> : <p className="mt-5 text-sm text-white/45">No book-level totals in this currency yet.</p>}
        </article>
      </>}
    </section>

    <section className="mt-12" aria-busy={loading}><div className="flex items-end justify-between gap-4"><div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#858585]">Source trail</p><h2 className="mt-2 text-2xl font-medium tracking-[-0.045em]">Imported reports</h2></div>{salesAvailable && <span className="text-xs text-white/40">{imports.length} saved</span>}</div>
      <div className="mt-5 overflow-hidden rounded-2xl border border-white/[0.09]">{imports.length && salesAvailable ? <ul className="divide-y divide-white/[0.08]">{imports.map((item) => <li key={item.id} className="grid gap-2 p-5 text-sm sm:grid-cols-[1.2fr_.8fr_.7fr_.5fr]"><div><p className="font-medium">{item.file_name}</p><p className="mt-1 text-xs text-white/40">{sourceLabel(item.source)}{item.superseded_at ? " · superseded" : ""}</p></div><p className="text-white/55">{item.period_start} — {item.period_end}</p><p className="text-white/55">{item.row_count.toLocaleString()} rows</p><p className="text-white/40">{new Date(item.created_at).toLocaleDateString()}</p></li>)}</ul> : <div className="p-8 text-sm text-white/45">
        {loading ? "Checking saved reports…" : view.kind === "no-workspace" ? "Create a workspace to view its reports." : !salesAvailable
          ? "Saved reports could not be verified." : "No retailer report saved yet. Import a source file above to record sales."}
      </div>}</div>
    </section>
  </main></AuthorPage>;
}

export default function AnalyticsPage() {
  return <Suspense fallback={<AuthorPage><AuthorHeader /><main className="mx-auto max-w-7xl px-4 py-12 text-sm text-white/50 sm:px-6 lg:px-8">Loading sales ledger…</main></AuthorPage>}><AnalyticsPageInner /></Suspense>;
}
