"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "./api";

const tabs = ["users", "jobs", "flags", "support", "audit", "usage"] as const;
type Tab = typeof tabs[number];
type Row = Record<string, unknown>;
type TicketStatus = "open" | "pending" | "resolved" | "closed";
const ticketStatuses: TicketStatus[] = ["open", "pending", "resolved", "closed"];
const input = "rounded-xl border border-white/15 bg-[#101010] px-3 py-2.5 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-white";
const button = "rounded-full border border-white/15 px-4 py-2 text-sm text-white/80 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-40";
const value = (row: Row, key: string, fallback = "—") => typeof row[key] === "string" || typeof row[key] === "number" ? String(row[key]) : fallback;
function date(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "Date unavailable";
  return new Date(value).toLocaleString();
}

export default function AdminConsole() {
  const api = apiClient();
  const [tab, setTab] = useState<Tab>("users");
  const [offset, setOffset] = useState(0);
  const [jobType, setJobType] = useState<"ai" | "publishing" | "document">("ai");
  const [documentHealth, setDocumentHealth] = useState<Row | null>(null);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true); setError(null); setRows([]);
    try {
      const result = tab === "usage"
        ? (await api.adminUsageSummary(30)).orgs as unknown as Row[]
        : await api.adminList(tab, {
          limit: 50, offset,
          ...(tab === "jobs" ? { type: jobType, status } : {}),
          ...(tab === "support" ? { status } : {}),
          ...(tab === "users" ? { search } : {}),
        });
      const health = tab === "jobs" && jobType === "document"
        ? (await api.adminDocumentJobHealth()).health as unknown as Row
        : null;
      if (current !== requestId.current) return false;
      setRows(result); setDocumentHealth(health); setForbidden(false);
      return true;
    } catch (reason) {
      if (current !== requestId.current) return false;
      setForbidden((reason as { status?: number } | null)?.status === 403);
      setError(reason instanceof Error ? reason.message : "Unable to load the admin console.");
      return false;
    } finally { if (current === requestId.current) setLoading(false); }
  }, [api, tab, offset, jobType, status, search]);

  useEffect(() => { void load(); return () => { requestId.current++; }; }, [load]);

  async function update(id: string, action: () => Promise<unknown>, message: string) {
    if (busy || loading) return;
    setBusy(id); setError(null); setNotice(null);
    try {
      await action();
      if (await load()) setNotice(message);
      else setNotice("Change saved. Refresh to reload the latest data.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The change could not be saved."); }
    finally { setBusy(null); }
  }

  function changeTab(next: Tab) {
    if (busy) return;
    setTab(next); setOffset(0); setStatus(""); setSearch(""); setSearchDraft(""); setNotice(null);
  }

  if (forbidden) return <main className="mx-auto max-w-3xl px-6 py-20">
    <p className="text-xs uppercase tracking-[0.18em] text-white/40">Platform administration</p>
    <h1 className="mt-4 text-4xl font-medium tracking-tight">Administrator access required</h1>
    <p className="mt-5 text-sm leading-6 text-white/60">This account does not have platform administrator access. Workspace owner and team roles do not grant access to this console.</p>
    <Link href="/dashboard" className={`${button} mt-8 inline-flex`}>Back to dashboard</Link>
  </main>;

  return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
    <div className="flex flex-wrap items-end justify-between gap-5 border-b border-white/10 pb-8">
      <div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">Platform operations</p><h1 className="mt-3 text-4xl font-medium tracking-[-0.055em]">Admin console</h1><p className="mt-3 max-w-xl text-sm leading-6 text-white/55">Manage platform settings and support, inspect jobs, and review activity across accounts.</p></div>
      <button type="button" disabled={loading || !!busy} onClick={() => void load()} className={button}>Refresh</button>
    </div>

    <nav aria-label="Administration sections" className="mt-6 flex flex-wrap gap-2">
      {tabs.map((item) => <button type="button" key={item} disabled={!!busy} onClick={() => changeTab(item)} aria-current={tab === item ? "page" : undefined} className={`rounded-full px-4 py-2.5 text-sm capitalize outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40 ${tab === item ? "bg-white font-semibold text-black" : "border border-white/15 text-white/60 hover:text-white"}`}>{item === "flags" ? "Feature flags" : item}</button>)}
    </nav>
    {error && <p role="alert" className="mt-6 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-100">{error}</p>}
    {notice && <p role="status" className="mt-6 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">{notice}</p>}

    <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
      <div><h2 className="text-xl font-medium capitalize">{tab === "flags" ? "Feature flags" : tab === "usage" ? "Usage by organization" : tab}</h2><p className="mt-1 text-xs text-white/40">{tab === "usage" ? "Last 30 days · up to 10,000 usage events · top 50 organizations" : tab === "flags" ? "Changes apply only to the selected scope and are recorded in the audit log." : "50 records per page · newest first"}</p></div>
      {tab === "users" && <form onSubmit={(event) => { event.preventDefault(); setOffset(0); setSearch(searchDraft.trim()); }} className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-white/50">Find a user<input value={searchDraft} disabled={!!busy} onChange={(event) => setSearchDraft(event.target.value)} maxLength={200} placeholder="Display name or full user ID" className={`${input} mt-2 block w-64 max-w-full`} /></label><button disabled={!!busy} className={button}>Search</button>
      </form>}
      {(tab === "jobs" || tab === "support") && <div className="flex gap-3">
        {tab === "jobs" && <label className="text-xs text-white/50">Job type<select value={jobType} disabled={!!busy} onChange={(event) => { setJobType(event.target.value as "ai" | "publishing" | "document"); setOffset(0); }} className={`${input} mt-2 block`}><option value="ai">AI generation</option><option value="publishing">Publishing packages</option><option value="document">Manuscript imports</option></select></label>}
        <label className="text-xs text-white/50">Status<select value={status} disabled={!!busy} onChange={(event) => { setStatus(event.target.value); setOffset(0); }} className={`${input} mt-2 block`}><option value="">All statuses</option>{(tab === "support" ? ticketStatuses : ["queued", "running", "succeeded", "failed", "cancelled"]).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      </div>}
    </div>

    {tab === "jobs" && jobType === "document" && documentHealth && <section aria-label="Document queue health" className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[["Ready now", "due_queued"], ["Running", "running"], ["Expired leases", "expired_running"], ["Dead letters", "dead_letters"]].map(([label, key]) => <div key={key} className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><p className="text-xs text-white/45">{label}</p><p className="mt-2 text-2xl font-medium tabular-nums">{Number(documentHealth[key] ?? 0).toLocaleString()}</p></div>)}
      <p className="sm:col-span-2 lg:col-span-4 text-xs text-white/35">Snapshot {date(documentHealth.generated_at)}. Expired leases and dead letters require operator investigation; recovery remains book-scoped.</p>
    </section>}

    <section aria-label={`${tab} records`} aria-busy={loading} className="mt-5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
      {loading ? <p role="status" className="p-12 text-center text-sm text-white/45">Loading {tab}…</p> : !rows.length ? <div className="p-12 text-center"><p className="text-base text-white/80">{error ? "Data unavailable" : "No matching records"}</p><p className="mt-2 text-sm text-white/40">{error ? "Use Refresh to try again." : "Records will appear here when there is activity. Adjust filters or check another page."}</p></div> : <div className="divide-y divide-white/10">
        {rows.map((row, index) => {
          const id = value(row, "id", String(index));
          const stamp = date(row.created_at);
          return <article key={id} className="p-5 sm:p-6">
            {tab === "users" && <div><h3 className="font-medium">{value(row, "display_name", "Unnamed author")}</h3><p className="mt-2 break-all font-mono text-xs text-white/45">{id}</p><p className="mt-2 text-xs text-white/40">Joined {stamp}</p></div>}
            {tab === "jobs" && <div className="flex flex-wrap justify-between gap-4"><div><h3 className="text-sm font-medium">{value(row, "job_type", value(row, "channel", jobType === "ai" ? "AI generation" : "Publishing package"))}</h3><p className="mt-2 break-all font-mono text-xs text-white/40">{id}</p><p className="mt-2 text-xs text-white/40">{stamp} · Attempts: {value(row, "attempts", "0")}</p></div><span className="h-fit rounded-full border border-white/15 px-3 py-1.5 text-xs capitalize text-white/70">{value(row, "status")}</span></div>}
            {tab === "flags" && <div className="flex flex-wrap items-center justify-between gap-4"><div><h3 className="font-medium">{value(row, "key")}</h3><p className="mt-2 break-all text-xs text-white/45">{value(row, "scope_type", "global")} {row.scope_id ? `· ${value(row, "scope_id")}` : ""}</p></div><button type="button" role="switch" aria-checked={row.enabled === true} aria-label={`Enable ${value(row, "key")} for ${value(row, "scope_type", "global")} ${value(row, "scope_id", "")}`} disabled={loading || !!busy} onClick={() => void update(id, () => api.adminToggleFlag(String(row.key), row.enabled !== true, { scopeType: value(row, "scope_type", "global"), scopeId: typeof row.scope_id === "string" ? row.scope_id : null }), "Feature flag saved.")} className={button}>{busy === id ? "Saving…" : row.enabled === true ? "Enabled" : "Disabled"}</button></div>}
            {tab === "support" && <div><div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="font-medium">{value(row, "subject", "Support request")}</h3><p className="mt-2 text-xs capitalize text-white/45">{value(row, "category", "general")} · {value(row, "priority", "normal")} priority · {stamp}</p><p className="mt-2 break-all text-xs text-white/35">User {value(row, "user_id")}</p></div><label className="text-xs text-white/50">Ticket status<select value={value(row, "status", "open")} disabled={loading || !!busy} onChange={(event) => void update(id, () => api.adminUpdateTicket(id, event.target.value as TicketStatus), "Ticket status saved.")} className={`${input} mt-2 block`}>{ticketStatuses.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div><details className="mt-4 text-sm text-white/60"><summary className="w-fit cursor-pointer rounded focus-visible:outline focus-visible:outline-white">Read request</summary><p className="mt-3 whitespace-pre-wrap break-words leading-6">{value(row, "body", "No message supplied.")}</p></details></div>}
            {tab === "audit" && <div><h3 className="text-sm font-medium">{value(row, "action")}</h3><p className="mt-2 break-all text-xs text-white/45">{value(row, "entity_type")} · {value(row, "entity_id")}</p><p className="mt-2 break-all text-xs text-white/35">Actor {value(row, "actor_id", "System")} · {stamp}</p></div>}
            {tab === "usage" && <div><h3 className="break-all text-sm font-medium">{value(row, "organizationId")}</h3><dl className="mt-4 flex flex-wrap gap-6">{Object.entries(row.byMeter && typeof row.byMeter === "object" ? row.byMeter : {}).map(([meter, quantity]) => <div key={meter}><dt className="text-xs capitalize text-white/45">{meter.replaceAll("_", " ")}</dt><dd className="mt-1 text-lg">{Number(quantity).toLocaleString()}</dd></div>)}</dl></div>}
          </article>;
        })}
      </div>}
    </section>
    {tab !== "flags" && tab !== "usage" && <div className="mt-5 flex items-center justify-between gap-3"><button type="button" disabled={offset === 0 || loading || !!busy} onClick={() => setOffset((page) => Math.max(0, page - 50))} className={button}>Previous</button><p className="text-xs text-white/40">Page {Math.floor(offset / 50) + 1}</p><button type="button" disabled={rows.length < 50 || loading || !!busy} onClick={() => setOffset((page) => page + 50)} className={button}>Next</button></div>}
  </main>;
}
