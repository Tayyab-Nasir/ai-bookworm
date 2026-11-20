"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { type DashboardOverview, type DashboardRecentJob } from "@bookworm/api-client";
import type { Book, Workspace } from "@bookworm/types";
import { apiClient } from "./api";
import { AuthorHeader } from "./AuthorShell";
import { rememberWorkspace, replaceWorkspaceQuery, resolveWorkspace } from "../lib/workspace-selection";
import { jobLink } from "../lib/job-link";
import { readBrowserSession } from "../lib/browser-session";
import { clearPendingWorkspaceCreation, readPendingWorkspaceCreation, savePendingWorkspaceCreation } from "../lib/workspace-creation-recovery";

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

type WorkspaceCreation =
  | { kind: "created"; actor: string; workspaceId: string }
  | { kind: "unconfirmed"; actor: string; operationId: string; checked: boolean };

export default function AuthorDashboard() {
  const api = apiClient();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("My publishing studio");
  const [verifiedActor, setVerifiedActor] = useState<string | null>(null);
  const [creation, setCreation] = useState<WorkspaceCreation | null>(null);
  const currentLoad = useRef<object | null>(null);
  const requestedWorkspace = useRef<string | null>(null);
  const loadedAccount = useRef<string | null>(null);
  const formAccount = useRef<string | null>(null);
  const createFlight = useRef<object | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (requestedId?: string, recovery?: WorkspaceCreation) => {
    if (!mounted.current) return;
    const request = {};
    currentLoad.current = request;
    loadedAccount.current = null;
    const current = () => currentLoad.current === request;
    if (requestedId !== undefined) requestedWorkspace.current = requestedId;
    if (requestedWorkspace.current === null) {
      requestedWorkspace.current = new URLSearchParams(window.location.search).get("ws");
    }
    setLoading(true);
    setError(null);
    setWorkspace(null);
    setWorkspaces([]);
    setBooks([]);
    setOverview(null);
    setVerifiedActor(null);
    let checkingActor: string | undefined;
    try {
      const account = await readBrowserSession();
      if (!current()) return;
      checkingActor = account.id;
      let pendingOperation: string | null = null, recoveryStorageError: string | null = null;
      try { pendingOperation = readPendingWorkspaceCreation(account.id); }
      catch (reason) { recoveryStorageError = reason instanceof Error ? reason.message : "Workspace recovery storage is unavailable."; }
      const spaces = await api.listWorkspaces(account.id);
      if (!current()) return;
      // Keep unavailable explicit selections recoverable, but do not expose even
      // workspace names until the response is bound to the current account.
      let selectionError: unknown;
      let selected: Workspace | null = null;
      const created = recovery?.kind === "created" && recovery.actor === account.id ? recovery : null;
      try { selected = resolveWorkspace(spaces.workspaces, created?.workspaceId ?? requestedWorkspace.current); }
      catch (reason) { selectionError = reason; }
      const result = selected ? await api.getDashboardOverview(selected.id, account.id) : null;
      if (!current()) return;
      if (result && (result.viewerId !== account.id || result.workspace.id !== selected!.id
        || result.books.some((book) => book.workspace_id !== selected!.id))) {
        throw new Error("Dashboard response does not match the requested account and workspace. Reload before continuing.");
      }
      checkingActor = undefined;
      await readBrowserSession(account.id);
      if (!current()) return;
      setVerifiedActor(account.id);
      setWorkspaces(spaces.workspaces);
      setCreation((outcome) => {
        if (outcome?.actor === account.id && outcome.kind === "created") return selected?.id === outcome.workspaceId ? null : outcome;
        if (recoveryStorageError) return outcome?.actor === account.id ? outcome : null;
        if (!pendingOperation) return null;
        return { kind: "unconfirmed", actor: account.id, operationId: pendingOperation,
          checked: outcome?.actor === account.id && outcome.kind === "unconfirmed" && outcome.operationId === pendingOperation && outcome.checked };
      });
      if (selectionError) throw selectionError;
      loadedAccount.current = account.id;
      if (formAccount.current !== account.id) setWorkspaceName("My publishing studio");
      formAccount.current = account.id;
      if (!selected) {
        requestedWorkspace.current = null;
        if (recoveryStorageError) setError(recoveryStorageError);
        return;
      }

      requestedWorkspace.current = selected.id;
      if (requestedId !== undefined || created) replaceWorkspaceQuery(selected.id);
      setWorkspace(selected);
      setBooks(result!.books);
      setOverview(result);
      setError(recoveryStorageError);
      rememberWorkspace(spaces.workspaces, selected.id);
    } catch (reason) {
      // A failed dashboard read is independent of a confirmed workspace save.
      if (checkingActor && current()) {
        const stillSignedIn = await readBrowserSession(checkingActor).catch(() => null);
        if (current()) setVerifiedActor(stillSignedIn?.id ?? null);
      }
      if (current()) {
        setError(reason instanceof Error ? reason.message : "Could not load your library.");
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, [api]);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const actor = verifiedActor;
    if (!actor || error || loadedAccount.current !== actor || createFlight.current || creation?.actor === actor) return;
    const flight = {};
    createFlight.current = flight;
    setCreating(true); setError(null);
    const request = currentLoad.current;
    const ownsFlight = () => mounted.current && createFlight.current === flight;
    const current = () => ownsFlight() && currentLoad.current === request;
    const name = workspaceName.trim();
    let dispatched = false;
    try {
      await readBrowserSession(actor);
      if (!current()) return;
      const operationId = crypto.randomUUID();
      savePendingWorkspaceCreation(actor, operationId);
      setCreation({ kind: "unconfirmed", actor, operationId, checked: false });
      dispatched = true;
      const created = await api.createOnboardingWorkspace({ name, operationId }, actor, AbortSignal.timeout(15_000));
      if (!ownsFlight()) return;
      const outcome: WorkspaceCreation = { kind: "created", actor, workspaceId: created.workspace.id };
      setCreation(outcome);
      clearPendingWorkspaceCreation(actor, operationId);
      await load(undefined, outcome);
    } catch (reason) {
      if (!ownsFlight()) return;
      if (!dispatched && current()) setError(reason instanceof Error ? reason.message : "Workspace creation failed. Reload before trying again.");
    }
    finally {
      if (createFlight.current === flight) {
        createFlight.current = null;
        if (mounted.current) setCreating(false);
      }
    }
  }

  async function recoverCreation(close: boolean) {
    const outcome = creation, actor = verifiedActor;
    if (!actor || outcome?.kind !== "unconfirmed" || outcome.actor !== actor || loading || createFlight.current) return;
    const flight = {}, request = currentLoad.current;
    createFlight.current = flight; setCreating(true); setError(null);
    const current = () => mounted.current && createFlight.current === flight && currentLoad.current === request;
    try {
      await readBrowserSession(actor);
      if (!current()) return;
      const receipt = await api.recoverWorkspaceCreation(outcome.operationId, actor, close, AbortSignal.timeout(15_000));
      await readBrowserSession(actor);
      if (!current()) return;
      if (receipt.status === "created") {
        const confirmed: WorkspaceCreation = { kind: "created", actor, workspaceId: receipt.workspaceId };
        setCreation(confirmed);
        clearPendingWorkspaceCreation(actor, outcome.operationId);
        await load(undefined, confirmed);
      } else if (receipt.status === "closed") {
        clearPendingWorkspaceCreation(actor, outcome.operationId);
        setCreation(null);
        await load();
      } else {
        setCreation({ ...outcome, checked: true });
      }
    } catch {
      if (current()) setError("Workspace request status is unavailable. Check again before starting another request.");
    } finally {
      if (createFlight.current === flight) {
        createFlight.current = null;
        if (mounted.current) setCreating(false);
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    const focus = () => { void load(); };
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false; currentLoad.current = null; loadedAccount.current = null; createFlight.current = null;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);

  const visibleCreation = !loading && creation?.actor === verifiedActor ? creation : null;
  const checkCreation = visibleCreation?.kind === "unconfirmed" ? visibleCreation : null;
  const reload = () => void load(undefined, visibleCreation ?? undefined);
  const createHref = workspace?.id ? `/books/new?ws=${encodeURIComponent(workspace.id)}` : "/books/new";
  const usageMeters = [
    ["Writing & editing", "ai_credits", "ai_credits_monthly"],
    ["Illustrations", "image_credits", "image_credits_monthly"],
    ["Audiobook", "audio_credits", "audio_credits_monthly"],
    ["Translation", "translation_credits", "translation_credits_monthly"],
  ].map(([label, meter, quota]) => ({ label, ...dashboardMeter(overview, meter, quota) }));

  return (
    <>
    <AuthorHeader workspaceId={workspace?.id} />
    <main aria-busy={loading} className="mx-auto min-w-0 max-w-7xl [overflow-wrap:anywhere] px-4 pb-16 pt-8 sm:px-6 lg:px-8 lg:pt-12">
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
          <button type="button" aria-label="Reload dashboard" aria-disabled={loading || creating} onClick={() => { if (!loading && !creating) reload(); }} className="glass-ghost inline-flex min-h-12 items-center rounded-full px-5 text-sm font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 aria-disabled:opacity-50">
            {loading ? "Refreshing…" : "Reload dashboard"}
          </button>
          <Link href={workspace ? `/assets?ws=${encodeURIComponent(workspace.id)}` : "/assets"} className="glass-ghost metal-shine inline-flex h-12 items-center rounded-full px-5 text-sm font-medium text-white">
            Manage assets
          </Link>
          <Link href={createHref} className="glass-solid metal-shine inline-flex h-12 items-center rounded-full px-5 text-sm font-semibold text-black">
            <span className="relative z-10">Create or import</span>
          </Link>
        </div>
      </section>

      {workspaces.length > 0 && <div className="mt-6 flex flex-wrap items-center gap-3">
        <label htmlFor="workspace" className="text-sm text-[#aaa]">Workspace</label>
        <select id="workspace" disabled={loading || creating} value={workspace?.id ?? ""} onChange={(event) => void load(event.target.value)} className="min-h-11 min-w-0 max-w-full rounded-xl border border-white/15 bg-black px-4 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
          <option value="" disabled>Select a workspace</option>
          {workspaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
        </select>
      </div>}

      {!loading && !workspace && !error && !visibleCreation && <form onSubmit={(event) => void createWorkspace(event)} className="mt-8 rounded-2xl border border-white/15 bg-white/[0.035] p-6">
        <h2 className="text-2xl tracking-tight">Set up your publishing workspace</h2>
        <p className="mt-2 text-sm leading-6 text-[#aaa]">This is your private home for manuscripts, images, collaborators, and publishing projects.</p>
        <label htmlFor="workspaceName" className="mt-5 block text-sm">Workspace name</label>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          <input id="workspaceName" name="name" required maxLength={120} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} className="min-h-12 flex-1 rounded-xl border border-white/15 bg-black px-4" />
          <button disabled={creating} className="rounded-full bg-white px-6 py-3 font-semibold text-black disabled:opacity-50">{creating ? "Creating…" : "Create workspace"}</button>
        </div>
      </form>}

      {checkCreation && <section aria-labelledby="check-workspace-creation" className="mt-8 rounded-2xl border border-white/15 bg-white/[0.035] p-6">
        <h2 id="check-workspace-creation" className="text-2xl tracking-tight">Check workspace creation</h2>
        <p role="status" className="mt-2 text-sm leading-6 text-[#ccc]">{creating
          ? "Your workspace request is being checked. Please wait."
          : checkCreation.checked && !error
          ? "The request is not confirmed yet and may still finish. Check again or close it before starting another request."
          : "We could not confirm whether your workspace was created. Check this request before starting another."}</p>
        <p className="mt-2 text-sm leading-6 text-[#aaa]">Closing stops this request if it has not finished. If it already created a workspace, we will open it instead.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" disabled={creating} onClick={() => void recoverCreation(false)} className="glass-solid min-h-11 rounded-full px-5 text-sm font-semibold text-black disabled:opacity-50">Check request status</button>
          <button type="button" disabled={creating} onClick={() => void recoverCreation(true)} className="glass-ghost min-h-11 rounded-full px-5 text-sm font-medium text-white disabled:opacity-50">Close unconfirmed request</button>
        </div>
      </section>}

      {!workspace && visibleCreation?.kind === "created" && <p role="status" className="mt-6 rounded-2xl border border-white/15 bg-white/[0.035] px-5 py-4 text-sm text-white">Your workspace was created. Reload the dashboard to open it.</p>}

      {error && (
        <div role="alert" className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-400/20 bg-red-400/[0.08] px-5 py-4 text-sm text-red-100">
          <span>{error}</span>
          <button type="button" disabled={loading || creating} onClick={reload} className="min-h-11 rounded-full border border-red-200/30 px-4 py-2 text-xs font-semibold hover:bg-red-200/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 disabled:opacity-50">
            Try again
          </button>
        </div>
      )}

      {overview && <section aria-label="Workspace summary" className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Active books", String(overview.summary.activeBooks), `${overview.summary.publishedBooks} published`],
          ["In production", String(overview.summary.inProductionBooks), "Drafts and review-ready books"],
          ["Open jobs", String(overview.summary.pendingJobs), overview.summary.failedJobs ? `${overview.summary.failedJobs} failed in saved history` : "Imports, AI, publishing & audiobook exports"],
          ["Library assets", String(overview.summary.assets), `${overview.summary.visualAssets} cover and illustration assets`],
        ].map(([label, value, detail]) => (
          <div key={label} className="rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#777]">{label}</p>
            <p className="mt-4 text-3xl font-medium tracking-[-0.05em] text-white">{value}</p>
            <p className="mt-2 text-[13px] leading-5 text-[#888]">{detail}</p>
          </div>
        ))}
      </section>}

      {overview && <section className="mt-8 grid gap-4 xl:grid-cols-[1.15fr_0.85fr]" aria-label="Publishing operations">
        <div className="rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#777]">Monthly usage</p><h2 className="mt-2 text-2xl font-medium tracking-[-0.04em]">AI studio capacity</h2></div>
            <Link href={workspace ? `/billing?ws=${encodeURIComponent(workspace.id)}` : "/billing"} className="rounded-full border border-white/15 px-4 py-2 text-xs font-semibold text-white/70 hover:border-white/30 hover:text-white">Manage billing</Link>
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
          <p className="mt-2 text-sm text-white/45">Packages in publishing history</p>
          <p className="mt-2 text-xs leading-5 text-white/45">Historical package jobs are not current-file checks, retailer approval, or sales. Audiobook exports appear in the pipeline below.</p>
          <div className={`mt-6 rounded-xl border p-4 ${overview.sales.status === "imported" ? "border-emerald-200/15 bg-emerald-100/[0.04]" : "border-amber-200/15 bg-amber-100/[0.04]"}`}><p className={`text-sm font-medium ${overview.sales.status === "imported" ? "text-emerald-50" : "text-amber-50"}`}>{overview.sales.available === false ? "Sales reporting is unavailable" : overview.sales.status === "imported" ? `${overview.sales.imports} retailer report${overview.sales.imports === 1 ? "" : "s"} imported` : "Sales data is not connected"}</p><p className={`mt-2 text-xs leading-5 ${overview.sales.status === "imported" ? "text-emerald-100/60" : "text-amber-100/60"}`}>{overview.sales.message}</p></div>
          <div className="mt-5 flex flex-wrap gap-3"><Link href={books[0] ? `/books/${books[0].id}/publish` : createHref} className="rounded-full bg-white px-4 py-2 text-xs font-semibold text-black">Open publishing</Link><Link href={workspace ? `/analytics?ws=${encodeURIComponent(workspace.id)}` : "/analytics"} className="self-center text-xs text-white/55 underline underline-offset-4 hover:text-white">{overview.sales.available === false ? "View sales setup" : overview.sales.status === "imported" ? "View sales ledger" : "Import retailer report"}</Link></div>
        </div>
      </section>}

      {overview && <section className="mt-4 grid items-start gap-4 lg:grid-cols-2" aria-label="Recent workspace state">
        <div className="rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 sm:p-6">
          <div className="flex items-center justify-between gap-4"><div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#777]">Pipeline</p><h2 className="mt-2 text-xl font-medium">Recent jobs</h2></div><Link href={workspace ? `/tasks?ws=${encodeURIComponent(workspace.id)}` : "/tasks"} className="text-xs text-white/50 underline underline-offset-4 hover:text-white">Open workflow</Link></div>
          {overview.pipeline && <dl aria-label="Execution queue totals" className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-b border-white/[0.08] pb-5">
            {overview.pipeline.map(queue => <div key={queue.kind} className="min-w-0"><dt className="text-xs text-white/60">{queue.label}</dt><dd className="mt-1 text-sm tabular-nums">{queue.pending.toLocaleString()} open <span className="text-white/50">· {queue.failed.toLocaleString()} failed</span></dd></div>)}
          </dl>}
          <p className="mt-4 text-xs leading-5 text-white/50">Latest 12 execution jobs. Totals include older queued, running, and failed jobs. Quote preparation stays in each book’s studio.</p>
          {overview.recentJobs.length ? <ul className="mt-3 divide-y divide-white/[0.08]">{overview.recentJobs.map(job => {
            const href = (!job.bookId || books.some(book => book.id === job.bookId)) ? jobLink(job, overview.workspace.id) : null;
            return <li key={`${job.kind}:${job.id}`} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"><div className="min-w-0 flex-1">{href ? <Link href={href} aria-label={`Open ${job.label} workflow${job.bookTitle ? ` for ${job.bookTitle}` : ""}`} className="inline-flex min-h-11 max-w-full items-center rounded-md text-sm font-medium text-white underline decoration-white/25 underline-offset-4 hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"><span className="min-w-0 break-words">{job.label}</span></Link> : <p className="text-sm font-medium">{job.label}</p>}<p className="mt-1 text-xs leading-5 text-white/50"><bdi>{job.bookTitle ?? "Workspace task"}</bdi> · {new Date(job.createdAt).toLocaleDateString()}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider ${jobStatusClass(job.status)}`}>{job.status}</span></li>;
          })}</ul> : <p className="mt-5 text-sm text-white/50">No import, AI, publishing, or audiobook export jobs yet.</p>}
        </div>

        <div className="rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 sm:p-6">
          <div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#777]">Workspace trail</p><h2 className="mt-2 text-xl font-medium">Recent activity</h2></div>
          {overview.activity.length ? <ol className="mt-5 divide-y divide-white/[0.08]">{overview.activity.slice(0, 6).map((event) => <li key={event.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white/70" /><div><p className="text-sm capitalize">{activityLabel(event.event_type)}</p><p className="mt-1 text-xs text-white/40">{new Date(event.created_at).toLocaleString()}</p></div></li>)}</ol> : <p className="mt-5 text-sm text-white/40">Activity will appear as the team edits, generates, and publishes.</p>}
        </div>
      </section>}

      {(loading || workspace) && <section id="books" className="mt-12 scroll-mt-24">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#8f8f8f]">Your library</p>
            <h2 className="mt-2 text-2xl font-medium tracking-[-0.045em]">Books in motion</h2>
          </div>
          {workspace && <Link href={createHref} className="text-sm font-medium text-[#d6d6d6] underline decoration-white/30 underline-offset-4 hover:text-white">
            Add a book
          </Link>}
        </div>

        {loading ? (
          <div role="status" className="rounded-2xl border border-white/[0.09] bg-white/[0.025] px-5 py-12 text-center text-sm text-[#969696]">Loading your library…</div>
        ) : books.length === 0 ? (
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
                  <Link href={`/books/${book.id}/overview`} className="text-sm font-medium text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">Book desk</Link>
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
      </section>}
    </main>
    </>
  );
}
