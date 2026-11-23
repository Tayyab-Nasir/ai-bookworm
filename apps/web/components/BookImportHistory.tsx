"use client";

import { useEffect, useRef, useState } from "react";
import type { ManuscriptImportJob, ManuscriptImportResult } from "@bookworm/api-client";
import { readBrowserSession } from "../lib/browser-session";
import { apiClient } from "./api";
import styles from "./BookOverview.module.css";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = { queued: "Queued", running: "Processing", succeeded: "Completed", failed: "Stopped" };
type Report = ManuscriptImportResult["report"];
type History = { status: "idle" | "loading" | "unavailable" } | { status: "ready"; jobs: ManuscriptImportJob[] };

export default function BookImportHistory({ bookId, actor, loadOnOpen }: { bookId: string; actor: string; loadOnOpen: boolean }) {
  const api = apiClient(actor);
  const [read, setRead] = useState(loadOnOpen ? 1 : 0);
  const [history, setHistory] = useState<History>({ status: loadOnOpen ? "loading" : "idle" });
  const [selection, setSelection] = useState<
    { id: string; status: "loading" }
    | { id: string; status: "unavailable" }
    | { id: string; status: "ready"; report: Report }
    | null
  >(null);
  const attempt = useRef(0);

  useEffect(() => {
    if (window.location.hash.startsWith("#import-job-")) setRead(value => value || 1);
  }, []);

  useEffect(() => {
    if (!read) return;
    const revision = ++attempt.current;
    setHistory({ status: "loading" }); setSelection(null);
    void (async () => {
      try {
        await readBrowserSession(actor);
        if (attempt.current !== revision) return;
        const { jobs } = await api.listManuscriptImports(bookId, actor);
        await readBrowserSession(actor);
        if (attempt.current !== revision) return;
        if (!Array.isArray(jobs) || jobs.length > 50 || jobs.some(item => item?.book_id !== bookId
          || !uuid.test(item.id) || !uuid.test(item.source_asset_id) || !Object.hasOwn(statuses, item.status)
          || typeof item.created_at !== "string" || !Number.isFinite(Date.parse(item.created_at)))
          || new Set(jobs.map(item => item.id)).size !== jobs.length) throw Error("Import history could not be verified.");
        setHistory({ status: "ready", jobs });
      } catch { if (attempt.current === revision) setHistory({ status: "unavailable" }); }
    })();
    return () => { attempt.current++; };
  }, [actor, api, bookId, read]);

  useEffect(() => {
    if (history.status !== "ready") return;
    const locate = () => {
      const match = /^#import-job-([a-f0-9-]+)$/i.exec(window.location.hash);
      if (match && history.jobs.some(job => job.id === match[1])) {
        document.getElementById(`import-job-${match[1]}`)?.scrollIntoView({ block: "nearest" });
      }
    };
    locate();
    window.addEventListener("hashchange", locate);
    return () => window.removeEventListener("hashchange", locate);
  }, [history]);

  async function openReport(job: ManuscriptImportJob) {
    const revision = ++attempt.current;
    setSelection({ id: job.id, status: "loading" });
    try {
      await readBrowserSession(actor);
      if (attempt.current !== revision) return;
      const result = await api.getManuscriptImport(bookId, job.source_asset_id, actor);
      await readBrowserSession(actor);
      if (attempt.current !== revision) return;
      const report = result.import?.report;
      if (result.import?.sourceAssetId !== job.source_asset_id || !report
        || !Number.isSafeInteger(report.chapterCount) || report.chapterCount < 1 || report.chapterCount > 500
        || report.imageCount !== undefined && (!Number.isSafeInteger(report.imageCount) || report.imageCount < 0 || report.imageCount > 100)
        || !Array.isArray(report.warnings) || report.warnings.length > 100 || report.warnings.some(item => typeof item !== "string" || item.length > 2000)) {
        throw Error("The report did not match the saved import.");
      }
      setSelection({ id: job.id, status: "ready", report });
    } catch { if (attempt.current === revision) setSelection({ id: job.id, status: "unavailable" }); }
  }

  return <section className={styles.panel} id="manuscript-imports" aria-labelledby="manuscript-imports-title">
    <div className={styles.panelHeading}><h2 id="manuscript-imports-title">Manuscript imports</h2></div>
    {history.status === "loading" && <p role="status" className={styles.note}>Checking saved imports…</p>}
    {history.status === "unavailable" && <p role="status" className={styles.note}>Saved imports are temporarily unavailable.</p>}
    {history.status !== "loading" && <button type="button" className={styles.button} onClick={() => setRead(value => value + 1)}>
      {history.status === "idle" ? "View import history" : "Refresh import history"}
    </button>}
    {history.status === "ready" && (history.jobs.length === 0
      ? <p className={styles.note}>No saved import jobs for this book.</p>
      : <ul className="mt-4 space-y-4">{history.jobs.map(job => <li key={job.id} id={`import-job-${job.id}`} className="scroll-mt-20 border-t border-white/10 pt-3">
        <p className={styles.note}>{statuses[job.status]} · <time dateTime={job.created_at}>{new Date(job.created_at).toLocaleString()}</time></p>
        {job.status === "succeeded" && <button type="button" className={styles.button}
          disabled={selection?.id === job.id && selection.status === "loading"} onClick={() => void openReport(job)}>Read import report</button>}
        {selection?.id === job.id && (selection.status === "loading" ? <p role="status">Checking the saved report…</p>
          : selection.status === "unavailable" ? <p role="alert">This saved report is unavailable. Try opening it again.</p>
          : <div className="mt-3 break-words text-sm">
            <p>{selection.report.chapterCount} {selection.report.chapterCount === 1 ? "chapter" : "chapters"} imported
              {selection.report.imageCount !== undefined && ` · ${selection.report.imageCount} ${selection.report.imageCount === 1 ? "image" : "images"} imported`}</p>
            {selection.report.warnings.length ? <ul className="mt-2 list-disc space-y-1 pl-5">
              {selection.report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
            </ul> : <p>No parser warnings reported.</p>}
          </div>)}
      </li>)}</ul>)}
  </section>;
}
