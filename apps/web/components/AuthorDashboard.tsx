"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
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

export default function AuthorDashboard() {
  const api = apiClient();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credits, setCredits] = useState<number | null>(null);

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
        setCredits(null);
        return;
      }

      window.localStorage.setItem("bookworm:workspaceId", selected.id);
      const [bookResult, usageResult] = await Promise.all([
        api.listBooks(selected.id),
        api.getUsage(selected.organization_id).catch(() => null),
      ]);
      setWorkspace(selected);
      setBooks(bookResult.books);
      setCredits(usageResult?.creditBalance ?? null);
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

      <section aria-label="Workspace summary" className="mt-8 grid gap-3 sm:grid-cols-3">
        {[
          ["Active books", loading ? "…" : String(activeBooks), "Books you can take forward"],
          ["In production", loading ? "…" : String(inProduction), "Drafts and review-ready books"],
          ["Available credits", credits === null ? "…" : String(credits), credits === null ? "Usage is not available yet" : "Available for AI work · manage billing"],
        ].map(([label, value, detail]) => (
          <div key={label} className="rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#777]">{label}</p>
            <p className="mt-4 text-3xl font-medium tracking-[-0.05em] text-white">{value}</p>
            <p className="mt-2 text-[13px] leading-5 text-[#888]">{detail}</p>
          </div>
        ))}
      </section>

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
