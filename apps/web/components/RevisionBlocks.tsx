"use client";

import { useEffect, useRef, useState } from "react";
import type { DocumentVersionSnapshot } from "@bookworm/api-client";
import { compareRevisionBlocks, readRevisionSnapshot, type RevisionText } from "../lib/version-comparison";
import styles from "./VersionTimeline.module.css";

const labels: Record<string, string> = { type: "Block type", text: "Text", level: "Heading level", attributes: "Formatting & list settings",
  assetId: "Image reference", assetVersionNumber: "Image revision", altText: "Alternative text", caption: "Caption", rows: "Table cells" };
function FieldValue({ value }: { value: unknown }) {
  const text = value === undefined ? "(not set)" : typeof value === "string" ? value || "(empty)" : JSON.stringify(value, null, 2);
  return <><pre>{text.slice(0, 2000)}</pre>{text.length > 2000 && <small>Preview limited to 2,000 characters. The full value remains saved.</small>}</>;
}

export default function RevisionBlocks({ chapterId, before, after, loadVersion }: {
  chapterId: string; before: RevisionText; after: RevisionText;
  loadVersion: (versionId: string) => Promise<DocumentVersionSnapshot>;
}) {
  const [result, setResult] = useState<ReturnType<typeof compareRevisionBlocks> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(20);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => () => { sequence.current++; inFlight.current = false; }, []);

  async function compare() {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = ++sequence.current;
    setBusy(true); setResult(null); setError(null); setVisible(20);
    try {
      const [left, right] = await Promise.all([loadVersion(before.id), loadVersion(after.id)]);
      if (request !== sequence.current) return;
      setResult(compareRevisionBlocks(readRevisionSnapshot(left, chapterId, before), readRevisionSnapshot(right, chapterId, after)));
    } catch (reason) {
      if (request === sequence.current) setError(reason instanceof Error ? reason.message : "Could not read saved revisions. Try again.");
    } finally {
      if (request === sequence.current) { inFlight.current = false; setBusy(false); }
    }
  }

  return <section aria-label="Saved block comparison" className={styles.blocks}>
    <h5>Blocks & formatting</h5>
    <p className={styles.hint}>Read both saved revisions to compare images, tables, formatting and block order. No image files are downloaded.</p>
    <button type="button" className={styles.compare} disabled={busy} onClick={() => void compare()}>
      {busy ? "Reading saved revisions…" : result ? "Refresh saved comparison" : error ? "Retry block comparison" : "Compare blocks & formatting"}
    </button>
    {busy && <p role="status" className={styles.hint}>Reading v{before.version_number} and v{after.version_number}. Your editor is unchanged.</p>}
    {error && <p role="alert" className={styles.failure}>{error}</p>}
    {result && <div aria-live="polite">
      {result.identical ? <p>No block, formatting or image-reference changes between these saved versions.</p> : <>
        <p className={styles.stats}>{result.added} added · {result.removed} removed · {result.changed} changed · {result.moved} reordered</p>
        <p className={styles.hint}>Reordered counts relative order among retained blocks. Image references identify saved assets, not a visual pixel comparison.</p>
        <ol className={styles.blockList}>{result.changes.slice(0, visible).map(change => {
          const fields = change.fields.length ? change.fields : change.kind === "moved" ? [] : Object.keys(change.after ?? change.before ?? {}).filter(key => key !== "id");
          return <li key={change.id}><details>
            <summary><strong>{(change.after ?? change.before)?.type}</strong><span>{change.kind}{change.moved && change.kind !== "moved" ? ", reordered" : ""} · {change.beforePosition ?? "new"} → {change.afterPosition ?? "removed"}</span></summary>
            <p className={styles.hint}>Block <code>{change.id}</code></p>
            {fields.slice(0, 20).map(field => <div className={styles.field} key={field}><h6>{labels[field] ?? field}</h6>
              <div className={styles.valuePair}>
                <div><span>v{before.version_number}</span><FieldValue value={change.before?.[field]} /></div>
                <div><span>v{after.version_number}</span><FieldValue value={change.after?.[field]} /></div>
              </div>
            </div>)}
            {fields.length > 20 && <p className={styles.hint}>{fields.length - 20} additional fields changed. Field previews are limited to 20 per block.</p>}
            {change.kind === "moved" && <p className={styles.hint}>Content is unchanged. Only its position changed.</p>}
          </details></li>;
        })}</ol>
        {visible < result.changes.length && <button type="button" className={styles.restore} onClick={() => setVisible(value => value + 20)}>Show next {Math.min(20, result.changes.length - visible)} changes</button>}
        <p className={styles.hint}>Showing {Math.min(visible, result.changes.length)} of {result.changes.length} changed blocks.</p>
      </>}
    </div>}
  </section>;
}
