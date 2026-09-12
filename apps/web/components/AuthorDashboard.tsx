"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { DashboardOverview, DashboardRecentJob } from "@bookworm/api-client";
import type { Book, Workspace } from "@bookworm/types";
import { apiClient } from "./api";

function statusLabel(status: Book["status"]) {
  return status.replace("_", " ");
}

function statusClass(status: Book["status"]) {
  if (status === "published") return "border-emerald-400/25 bg-emerald-400/10 text-emerald-200";
  if (status === "approved") return "border-sky-400/25 bg-sky-400/10 text-sky-200";
  if (status === "in_review") return "border-amber-400/25 bg-amber-400/10 text-amber-200";
  return "border-white/10 bg-white/[0.05] text-[#c7c7c7]";
}

function jobStatusClass(status: DashboardRecentJob["status"]) {
  if (status === "succeeded") return "bg-emerald-400/10 text-emerald-100";
  if (status === "failed" || status === "cancelled") return "bg-red-400/10 text-red-100";
  return "bg-amber-300/10 text-amber-100";
}

export function dashboardMeter(overview: DashboardOverview | null, meter: string, quota: string) {
  const used = Number(overview?.usage.usage[meter] ?? 0);
  const limit = Number(overview?.usage.entitlements.entitlements[quota] ?? 0);
  return { used, limit, percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0 };
}

export function activityLabel(eventType: string) {
  return ({
    audiobook_segment_generated: "Audiobook segment generated",
    translation_project_adopted: "Translated draft created",
    publishing_package_created: "Retailer package prepared",
    retailer_sales_imported: "Retailer sales report imported",
    image_generated: "Image generated",
    manuscript_import_completed: "Manuscript import completed",
    ai_suggestion_applied: "AI suggestion applied",
  } as Record<string, string>)[eventType] ?? eventType.replaceAll("_", " ");
}

export default function AuthorDashboard() {
  const api = apiClient();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (requestedId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const spaces = await api.listWorkspaces();
      setWorkspaces(spaces.workspaces);
      const workspaceId = requestedId ?? new URLSearchParams(window.location.search).get("ws") ?? window.localStorage.getItem("bookworm:workspaceId");
      const selected = spaces.workspaces.find((item) => item.id === workspaceId) ?? spaces.workspaces[0] ?? null;
      if (!selected) {
        setBooks([]);
        setWorkspace(null);
        setOverview(null);
        return;
      }

      window.localStorage.setItem("bookworm:workspaceId", selected.id);
      const result = await api.getDashboardOverview(selected.id);
      setWorkspace(selected);
      setBooks(result.books);
      setOverview(result);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load your library.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setCreating(true); setError(null);
    const values = new FormData(event.currentTarget);
    try {
      const created = await api.createWorkspace({ name: String(values.get("name") ?? "").trim() });
      window.localStorage.setItem("bookworm:workspaceId", created.id);
      await load(created.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Workspace creation failed."); }
    finally { setCreating(false); }
  }

  useEffect(() => {
    void load();
  }, [load]);

  const activeBooks = books.filter((book) => book.status !== "archived").length;
  const inProduction = books.filter((book) => ["draft", "in_review"].includes(book.status)).length;
  const createHref = workspace?.id ? `/books/new?ws=${encodeURIComponent(workspace.id)}` : "/books/new";
  const usageMeters = [
    ["Writing & editing", "ai_credits", "ai_credits_monthly"],
    ["Illustrations", "image_credits", "image_credits_monthly"],
    ["Audiobook", "audio_credits", "audio_credits_monthly"],
    ["Translation", "translation_credits", "translation_credits_monthly"],
  ].map(([label, meter, quota]) => ({ label, ...dashboardMeter(overview, meter, quota) }));

  return (
    <main className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6 lg:px-8 lg:pt-12">
      <section className="flex flex-col justify-between gap-6 border-b border-white/[0.09] pb-8 sm:flex-row sm:items-end">
        <div>
          <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-[#8f8f8f]">Author workspace</p>
          <h1 className="max-w-[12ch] text-4xl font-medium leading-[0.94] tracking-[-0.06em] sm:text-5xl">
            Your publishing <span className="font-instrument instrument-italic font-normal italic text-[#bdbdbd]">desk.</span>
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-6 text-[#969696]">
            Write, shape, package, and prepare every book from one clear workspace.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/assets" className="glass-ghost metal-shine inline-flex h-12 items-center rounded-full px-5 text-sm font-medium text-white">
            Manage assets
          </Link>
          <Link href={createHref} className="glass-solid metal-shine inline-flex h-12 items-center rounded-full px-5 text-sm font-semibold text-black">
            <span className="relative z-10">Create or import</span>
          </Link>
        </div>
      </section>

      {workspaces.length > 0 && <div className="mt-6 flex flex-wrap items-center gap-3">
        <label htmlFor="workspace" className="text-sm text-[#aaa]">Workspace</label>
        <select id="workspace" disabled={loading} value={workspace?.id ?? ""} onChange={(event) => void load(event.target.value)} className="rounded-xl border border-white/15 bg-black px-4 py-2 text-sm">
          {workspaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
        </select>
      </div>}

      {!loading && !workspace && !error && <form onSubmit={(event) => void createWorkspace(event)} className="mt-8 rounded-2xl border border-white/15 bg-white/[0.035] p-6">
        <h2 className="text-2xl tracking-tight">Set up your publishing workspace</h2>
        <p className="mt-2 text-sm leading-6 text-[#aaa]">This is your private home for manuscripts, images, collaborators, and publishing projects.</p>
        <label htmlFor="workspaceName" className="mt-5 block text-sm">Workspace name</label>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          <input id="workspaceName" name="name" required maxLength={120} defaultValue="My publishing studio" className="min-h-12 flex-1 rounded-xl border border-white/15 bg-black px-4" />
          <button disabled={creating} className="rounded-full bg-white px-6 py-3 font-semibold text-black disabled:opacity-50">{creating ? "Creating…" : "Create workspace"}</button>
        </div>
      </form>}

      {error && (
        <div role="alert" className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-400/20 bg-red-400/[0.08] px-5 py-4 text-sm text-red-100">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} className="rounded-full border border-red-200/30 px-3 py-1.5 text-xs font-semibold hover:bg-red-200/10">
            Try again
          </button>
        </div>
      )}

      <section aria-label="Workspace summary" className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Active books", loading ? "…" : String(overview?.summary.activeBooks ?? activeBooks), `${overview?.summary.publishedBooks ?? 0} published`],
          ["In production", loading ? "…" : String(overview?.summary.inProductionBooks ?? inProduction), "Drafts and review-ready books"],
          ["Open jobs", loading ? "…" : String(overview?.summary.pendingJobs ?? 0), overview?.summary.failedJobs ? `${overview.summary.failedJobs} need attention` : "Generation and publishing pipeline"],
          ["Library assets", loading ? "…" : String(overview?.summary.assets ?? 0), `${overview?.summary.visualAssets ?? 0} cover and illustration assets`],
        ].map(([label, value, detail]) => (
          <div key={label} className="rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#777]">{label}</p>
            <p className="mt-4 text-3xl font-medium tracking-[-0.05em] text-white">{value}</p>
            <p className="mt-2 text-[13px] leading-5 text-[#888]">{detail}</p>
          </div>
        ))}
      </section>

      {overview && <section className="mt-8 grid gap-4 xl:grid-cols-[1.15fr_0.85fr]" aria-label="Publishing operations">
        <div className="rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#777]">Monthly usage</p><h2 className="mt-2 text-2xl font-medium tracking-[-0.04em]">AI studio capacity</h2></div>
            <Link href="/billing" className="rounded-full border border-white/15 px-4 py-2 text-xs font-semibold text-white/70 hover:border-white/30 hover:text-white">Manage billing</Link>
          </div>
          <div className="mt-7 grid gap-6 sm:grid-cols-2">
            {usageMeters.map((item) => <div key={item.label}>
              <div className="flex items-center justify-between gap-3 text-sm"><span>{item.label}</span><span className="tabular-nums text-white/45">{item.used.toLocaleString()} / {item.limit.toLocaleString()}</span></div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/[0.08]"><div className="h-full rounded-full bg-white transition-[width]" style={{ width: `${item.percent}%` }} /></div>
              {!item.limit && <p className="mt-2 text-[11px] text-amber-100/70">No paid allowance on the current plan.</p>}
            </div>)}
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] pt-5 text-sm"><span className="text-white/45">Current plan <strong className="ml-1 font-medium capitalize text-white/85">{overview.usage.entitlements.plan.name}</strong></span><span><strong className="font-medium">{overview.usage.creditBalance.toLocaleString()}</strong> ledger credits</span></div>
        </div>

        <div className="rounded-2xl border border-white/[0.09] bg-[linear-gradient(145deg,rgba(255,255,255,.055),rgba(255,255,255,.018))] p-5 sm:p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#777]">Distribution</p><div className="mt-2 flex items-end justify-between gap-4"><h2 className="text-2xl font-medium tracking-[-0.04em]">Retail desk</h2><span className="text-3xl font-medium tracking-[-0.05em]">{overview.summary.readyPackages}</span></div>
          <p className="mt-2 text-sm text-white/45">Retailer-ready packages created</p>
          <div className={`mt-6 rounded-xl border p-4 ${overview.sales.status === "imported" ? "border-emerald-200/15 bg-emerald-100/[0.04]" : "border-amber-200/15 bg-amber-100/[0.04]"}`}><p className={`text-sm font-medium ${overview.sales.status === "imported" ? "text-emerald-50" : "text-amber-50"}`}>{overview.sales.available === false ? "Sales reporting is unavailable" : overview.sales.status === "imported" ? `${overview.sales.imports} retailer report${overview.sales.imports === 1 ? "" : "s"} imported` : "Sales data is not connected"}</p><p className={`mt-2 text-xs leading-5 ${overview.sales.status === "imported" ? "text-emerald-100/60" : "text-amber-100/60"}`}>{overview.sales.message}</p></div>
          <div className="mt-5 flex flex-wrap gap-3"><Link href={books[0] ? `/books/${books[0].id}/publish` : createHref} className="rounded-full bg-white px-4 py-2 text-xs font-semibold text-black">Open publishing</Link><Link href={workspace ? `/analytics?ws=${encodeURIComponent(workspace.id)}` : "/analytics"} className="self-center text-xs text-white/55 underline underline-offset-4 hover:text-white">{overview.sales.available === false ? "View sales setup" : overview.sales.status === "imported" ? "View sales ledger" : "Import retailer report"}</Link></div>
        </div>
      </section>}

      {overview && <section className="mt-4 grid gap-4 lg:grid-cols-2" aria-label="Recent workspace state">
        <div className="rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 sm:p-6">
          <div className="flex items-center justify-between gap-4"><div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#777]">Pipeline</p><h2 className="mt-2 text-xl font-medium">Recent jobs</h2></div><Link href="/tasks" className="text-xs text-white/50 underline underline-offset-4 hover:text-white">Open workflow</Link></div>
          {overview.recentJobs.length ? <ul className="mt-5 divide-y divide-white/[0.08]">{overview.recentJobs.slice(0, 6).map((job) => <li key={`${job.kind}:${job.id}`} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"><div className="min-w-0"><p className="truncate text-sm font-medium">{job.label}</p><p className="mt-1 truncate text-xs text-white/40">{job.bookTitle ?? "Workspace task"} · {new Date(job.createdAt).toLocaleDateString()}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider ${jobStatusClass(job.status)}`}>{job.status}</span></li>)}</ul> : <p className="mt-5 text-sm text-white/40">No generation or publishing jobs yet.</p>}
        </div>

        <div className="rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 sm:p-6">
          <div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#777]">Workspace trail</p><h2 className="mt-2 text-xl font-medium">Recent activity</h2></div>
          {overview.activity.length ? <ol className="mt-5 divide-y divide-white/[0.08]">{overview.activity.slice(0, 6).map((event) => <li key={event.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white/70" /><div><p className="text-sm capitalize">{activityLabel(event.event_type)}</p><p className="mt-1 text-xs text-white/40">{new Date(event.created_at).toLocaleString()}</p></div></li>)}</ol> : <p className="mt-5 text-sm text-white/40">Activity will appear as the team edits, generates, and publishes.</p>}
        </div>
      </section>}

      <section id="books" className="mt-12 scroll-mt-24">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#8f8f8f]">Your library</p>
            <h2 className="mt-2 text-2xl font-medium tracking-[-0.045em]">Books in motion</h2>
          </div>
          <Link href={createHref} className="text-sm font-medium text-[#d6d6d6] underline decoration-white/30 underline-offset-4 hover:text-white">
            Add a book
          </Link>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-white/[0.09] bg-white/[0.025] px-5 py-12 text-center text-sm text-[#969696]">Loading your library…</div>
        ) : !workspace ? null : books.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/[0.16] bg-white/[0.02] px-6 py-14 text-center">
            <h3 className="text-xl font-medium tracking-[-0.035em]">Your library is ready for its first book.</h3>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[#969696]">Start from a blank manuscript or bring in a source file and set up the editorial workspace.</p>
            <Link href={createHref} className="glass-solid metal-shine mt-6 inline-flex h-11 items-center rounded-full px-5 text-sm font-semibold text-black">
              <span className="relative z-10">Create a book</span>
            </Link>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {books.map((book) => (
              <article key={book.id} className="group flex min-h-56 flex-col rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 transition-colors hover:border-white/[0.2] hover:bg-white/[0.04]">
                <div className="flex items-center justify-between gap-3">
                  <span className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.13em] ${statusClass(book.status)}`}>{statusLabel(book.status)}</span>
                  <span className="text-xs text-[#737373]">{book.language.toUpperCase()}</span>
                </div>
                <h3 className="mt-7 text-2xl font-medium leading-tight tracking-[-0.045em] text-white">{book.title}</h3>
                <p className="mt-2 text-sm text-[#919191]">{book.author_name}{book.genre ? ` · ${book.genre}` : ""}</p>
                <div className="mt-auto flex flex-wrap items-center gap-3 pt-8">
                  <Link href={`/books/${book.id}?title=${encodeURIComponent(book.title)}`} className="text-sm font-medium text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">
                    Open editor
                  </Link>
                  <Link href={`/books/${book.id}/publish`} className="rounded-full border border-white/[0.13] px-3 py-1.5 text-xs font-semibold text-[#dadada] transition-colors hover:border-white/30 hover:text-white">
                    Publish
                  </Link>
                  <Link href={`/books/${book.id}/memory`} className="rounded-full border border-white/[0.13] px-3 py-1.5 text-xs font-semibold text-[#dadada] transition-colors hover:border-white/30 hover:text-white">
                    Book Bible
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
