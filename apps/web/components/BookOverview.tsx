"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseBookOverview, type BookOverview as Overview } from "@bookworm/api-client";
import { apiClient } from "./api";
import styles from "./BookOverview.module.css";
import { jobLink } from "../lib/job-link";

async function viewer() {
  const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
  const body = await response.json();
  if (!response.ok || typeof body?.user?.id !== "string") throw Error("Session unavailable");
  return body.user.id as string;
}
const format = (value: number) => value.toLocaleString("en-US");
const quantity = (value: number, unit: string, plural = `${unit}s`) => `${format(value)} ${value === 1 ? unit : plural}`;
const editRoles = new Set(["owner", "admin", "editor", "writer", "illustrator", "designer"]);

export default function BookOverview({ bookId }: { bookId: string }) {
  const api = apiClient();
  const [saved, setSaved] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const request = useRef<object | null>(null);
  const load = useCallback(async () => {
    const attempt = {};
    request.current = attempt;
    const current = () => request.current === attempt;
    setSaved(null); setLoading(true); setFailed(false);
    try {
      const account = await viewer();
      if (!current()) return;
      const overview = parseBookOverview(await api.getBookOverview(bookId), bookId);
      if (!current()) return;
      if (overview.viewerId !== account || await viewer() !== account) throw Error("Session changed");
      if (current()) setSaved(overview);
    } catch { if (current()) setFailed(true); }
    finally { if (current()) setLoading(false); }
  }, [api, bookId]);
  useEffect(() => {
    void load();
    // Returning from another tab rechecks identity instead of keeping another account's desk.
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    return () => { request.current = null; window.removeEventListener("focus", refresh); };
  }, [load]);

  const overview = saved?.book.id === bookId ? saved : null;
  const root = `/books/${encodeURIComponent(bookId)}`;
  const editable = Boolean(overview && editRoles.has(overview.workspace.role));
  const next = !overview ? null : !editable
    ? { title: "Return to the manuscript.", copy: "Read the saved chapters and follow this book’s progress. Your workspace role is read-only.", label: "Read manuscript", href: root }
    : overview.manuscript.wordCount === 0
      ? { title: "Give the story its first page.", copy: "Open the editor to start a chapter, or shape a chapter plan before writing. Nothing is generated or charged by opening this desk.", label: "Start your manuscript", href: root }
      : !overview.listing.description
        ? { title: "Introduce your book to readers.", copy: "Your manuscript is saved. Review its Book Bible and add the description, keywords, and categories for your listing.", label: "Prepare book details", href: `${root}/memory` }
        : overview.editionsTotal === 0
          ? { title: "Shape the reading experience.", copy: "Choose an ebook or print edition. Set typography, spacing, artwork, cover, and an optional QR destination, then save a proof.", label: "Create an edition", href: `${root}/publish` }
          : { title: "Review the next proof.", copy: "Open your saved editions, check the current manuscript and cover, and run preflight for your chosen channel. A saved package is not a published book.", label: "Open publishing studio", href: `${root}/publish` };

  return <main className={styles.desk} aria-busy={loading}>
    <div className={styles.toolbar}>
      <Link href={overview ? `/dashboard?ws=${encodeURIComponent(overview.workspace.id)}` : "/dashboard"}>← Library</Link>
      <button type="button" aria-disabled={loading} onClick={() => { if (!loading) void load(); }} className={styles.button}>
        {loading ? "Refreshing desk…" : "Refresh book desk"}
      </button>
    </div>
    {loading && <section className={styles.empty} aria-label="Loading book desk"><p className={styles.eyebrow}>Book desk</p><h1>Opening your book.</h1><p role="status">Loading saved progress and verifying your session…</p></section>}
    {failed && !loading && <section className={styles.empty} role="alert"><p className={styles.eyebrow}>Book desk unavailable</p><h1>Your saved work stays put.</h1><p>Book progress could not be verified. Retry, or return to your library to choose a book. No changes were made.</p><button type="button" className={styles.button} onClick={() => void load()}>Retry book desk</button></section>}
    {overview && <>
      <section className={styles.hero} aria-label="Book overview">
        <div className={styles.identity}>
          <p className={styles.eyebrow}>Book desk <span>·</span> {overview.workspace.name}</p>
          <h1><bdi>{overview.book.title}</bdi></h1>
          {overview.book.subtitle && <p className={styles.subtitle}><bdi>{overview.book.subtitle}</bdi></p>}
          <p className={styles.byline}>By <bdi>{overview.book.authorName}</bdi><span> / </span>{overview.book.language.toUpperCase()}{overview.book.genre ? ` / ${overview.book.genre}` : ""}</p>
          <p className={styles.tag}>Book status: {overview.book.status.replaceAll("_", " ")} · {editable ? "Editing access" : "Read-only access"}</p>
          <dl className={styles.metrics} aria-label="Saved manuscript totals">
            <div><dt>Saved words</dt><dd>{format(overview.manuscript.wordCount)}</dd></div>
            <div><dt>Chapters</dt><dd>{format(overview.manuscript.chapterCount)}</dd></div>
            <div><dt>Bible entries</dt><dd>{format(overview.bibleItems)}</dd></div>
          </dl>
        </div>
        {next && <aside className={styles.paper} aria-labelledby="next-book-step">
          <p className={styles.eyebrow}>Next at your desk</p><h2 id="next-book-step">{next.title}</h2><p>{next.copy}</p>
          <Link href={next.href} className={styles.primary}>{next.label}<span aria-hidden="true">↗</span></Link>
          <span className={styles.paperNote}>Suggested next step · your order, your book</span>
        </aside>}
      </section>

      <nav aria-label="Book tools" className={styles.tools}>
        <Link href={root}>Open manuscript</Link><Link href={`${root}/plan`}>Story Blueprint</Link><Link href={`${root}/memory`}>Book Bible & listing</Link>
        <Link href={`/assets?ws=${encodeURIComponent(overview.workspace.id)}`}>Workspace artwork</Link><Link href={`${root}/publish`}>Layout & publishing</Link><Link href={`${root}/translate`}>Translation</Link>
      </nav>

      <div className={styles.workspace}>
        <section aria-labelledby="book-workflow-title" className={styles.workflow}>
          <div className={styles.sectionHeading}><p className={styles.eyebrow}>From draft to handoff</p><h2 id="book-workflow-title">Keep the whole book in view.</h2></div>
          <ol className={styles.steps}>
            {[
              { title: "Manuscript", detail: `${quantity(overview.manuscript.chapterCount, "chapter")} · ${quantity(overview.manuscript.wordCount, "saved word")}`, note: "Only saved chapter versions count. Unsaved drafts stay in the editor.", href: root, label: "Open editor" },
              { title: "Canon & listing", detail: `${quantity(overview.bibleItems, "Bible entry", "Bible entries")} · ${overview.listing.description ? "Description saved" : "No description yet"}`, note: `${quantity(overview.listing.keywords, "keyword")} · ${quantity(overview.listing.categories, "category", "categories")}. Review these before listing with a retailer.`, href: `${root}/memory`, label: "Review book details" },
              { title: "Artwork & layout", detail: quantity(overview.editionsTotal, "saved edition"), note: "Choose private artwork, compose a cover, set type and spacing, then inspect the rendered pages.", href: `${root}/publish`, label: "Review editions" },
              { title: "Preflight & handoff", detail: `${quantity(overview.history.packages, "package")} in saved history`, note: "Source and settings may have changed. Recheck current proofs and channel preflight; retailer submission remains separate.", href: `${root}/publish`, label: "Review publishing handoff" },
            ].map((step, i) => <li key={step.title}><span className={styles.stepNumber} aria-hidden="true">0{i + 1}</span><div><h3>{step.title}</h3><p>{step.detail}</p><p className={styles.note}>{step.note}</p><Link href={step.href}>{step.label}<span aria-hidden="true"> ↗</span></Link></div></li>)}
          </ol>
          <p className={styles.footnote}>Book Bible and artwork needs depend on your book. This desk does not score quality, certify compliance, register an ISBN, or publish on your behalf.</p>
        </section>

        <div className={styles.side}>
          <section className={styles.panel} aria-labelledby="chapter-ledger-title">
            <div className={styles.panelHeading}><h2 id="chapter-ledger-title">Chapter ledger</h2><span>{format(overview.chapters.length)}</span></div>
            {overview.chapters.length === 0 ? <p className={styles.note}>No chapters yet. Start in the editor or create a Story Blueprint.</p> : <ol className={styles.chapters}>
              {overview.chapters.map((chapter, i) => <li key={chapter.id}><Link href={`${root}?chapter=${encodeURIComponent(chapter.id)}`}><span className={styles.chapterNumber}>{String(i + 1).padStart(2, "0")}</span><span><bdi>{chapter.title}</bdi><small>{chapter.versionNumber === null ? "No saved version" : `v${chapter.versionNumber} · ${format(chapter.wordCount)} words`}</small></span><span aria-hidden="true">↗</span></Link></li>)}
            </ol>}
            {overview.manuscript.chaptersWithoutSavedVersion > 0 && <p className={styles.footnote}>{quantity(overview.manuscript.chaptersWithoutSavedVersion, "chapter")} {overview.manuscript.chaptersWithoutSavedVersion === 1 ? "has" : "have"} no saved document version yet.</p>}
          </section>

          <section className={styles.panel} aria-labelledby="saved-editions-title"><div className={styles.panelHeading}><h2 id="saved-editions-title">Saved editions</h2><span>{format(overview.editionsTotal)}</span></div>
            {overview.editions.length === 0 ? <p className={styles.note}>No edition settings saved yet. Ebook, print, and audiobook workflows live in Publishing Studio.</p> : <ul className={styles.editions}>{overview.editions.map(e => <li key={e.id}><Link href={`${root}/publish`}><span>{e.kind === "ebook" ? "Ebook" : e.kind === "print" ? "Print" : "Audiobook"}<small>{e.status.replaceAll("_", " ")} · {e.coverArtworkChosen ? "Cover artwork chosen" : "No cover choice saved"}</small></span><span aria-hidden="true">↗</span></Link></li>)}</ul>}
            {overview.editionsTotal > overview.editions.length && <p className={styles.footnote}>Showing the latest {overview.editions.length}. Open Publishing Studio for all saved editions.</p>}
            <p className={styles.footnote}>{quantity(overview.history.renders, "successful render")} in history. Stored job history does not verify current files or retailer acceptance.</p>
          </section>
        </div>
      </div>

      <section className={styles.activity} aria-labelledby="book-jobs-title"><div className={styles.sectionHeading}><p className={styles.eyebrow}>Recent pipeline activity</p><h2 id="book-jobs-title">What’s moving.</h2><p>Newest 12 jobs, sampled from the latest four per pipeline. Opening a workflow starts no job or paid generation.</p></div>
        {overview.jobs.length === 0 ? <p className={styles.note}>No import, AI, publishing, or audiobook export jobs recorded for this book yet.</p> : <ul className={styles.jobs}>{overview.jobs.map(job => <li key={`${job.kind}:${job.id}`}><Link href={jobLink({ ...job, bookId }, overview.workspace.id) ?? `${root}/overview`}><span>{job.label}<small>{job.kind === "import" ? "Import pipeline" : job.kind === "ai" ? "AI pipeline" : job.kind === "audiobook_export" ? "Audiobook export pipeline" : "Publishing pipeline"}</small></span><span className={styles.jobStatus} data-status={job.status}>{job.status}</span><span aria-hidden="true">↗</span></Link></li>)}</ul>}
      </section>
      <footer className={styles.footer}><span>Saved-state snapshot · <time dateTime={overview.observedAt}>{new Date(overview.observedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</time></span><span>Refresh after changes in another tab.</span></footer>
    </>}
  </main>;
}
