"use client";
import { useMemo, useState } from "react";
import { compareRevisionText } from "../lib/version-comparison";
import styles from "./VersionTimeline.module.css";

export interface VersionSummary {
  id: string; version_number: number; created_by?: string;
  change_summary?: string | null; created_at: string; plain_text?: string | null;
}
export interface VersionTimelineProps { versions: VersionSummary[]; onRestore: (versionId: string) => void; readOnly?: boolean }

export default function VersionTimeline({ versions, onRestore, readOnly }: VersionTimelineProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [compared, setCompared] = useState<string[] | null>(null);
  const available = selected.filter((id) => versions.some((v) => v.id === id));
  const comparison = useMemo(() => {
    const pair = compared?.map((id) => versions.find((v) => v.id === id));
    return pair?.[0] && pair[1] ? compareRevisionText(pair[0], pair[1]) : null;
  }, [compared, versions]);
  const toggle = (id: string) => {
    setSelected(available.includes(id) ? available.filter((value) => value !== id) : [...available.slice(-1), id]);
    setCompared(null);
  };
  return <aside aria-label="Versions" className={styles.ledger}>
    <header className={styles.header}><div><p className={styles.eyebrow}>Revision ledger</p><h3>Version history</h3></div><span className={styles.count}>{versions.length}</span></header>
    <p className={styles.hint}>Select two saved versions to compare their text. Newest first · up to 100 versions.</p>
    {versions.length === 0 && <p className={styles.empty}>No saved revisions yet. Save your chapter to begin its history.</p>}
    <ul className={styles.list}>{[...versions].sort((a, b) => b.version_number - a.version_number).map((v) => <li key={v.id} className={styles.row} data-selected={available.includes(v.id)}>
      <label><input type="checkbox" aria-label={`Select version ${v.version_number}`} checked={available.includes(v.id)} onChange={() => toggle(v.id)} />
        <span className={styles.entry}><strong>v{v.version_number}</strong><span>{v.change_summary || "Saved manuscript"}</span><time dateTime={v.created_at}>{new Date(v.created_at).toLocaleString()}</time></span>
      </label>
      {!readOnly && <button type="button" className={styles.restore} aria-label={`Restore version ${v.version_number}`} onClick={() => onRestore(v.id)}>Restore</button>}
    </li>)}</ul>
    <button type="button" className={styles.compare} disabled={available.length !== 2} onClick={() => setCompared([...available])}>Compare selected</button>
    <p className={styles.hint}>Saved text only. Formatting, images and unsaved edits are not compared. Restoring creates a new revision.</p>
    {compared && <section aria-label="Version comparison" className={styles.result} aria-live="polite">
      {comparison ? <><h4>v{comparison.before.version_number} → v{comparison.after.version_number}</h4>
        {comparison.identical ? <p>No text changes between these saved versions.</p> : <>
          <p className={styles.hint}>{comparison.mode === "full" ? "Large comparison: complete earlier and later text shown below." : "Removed text is struck through; added text is underlined."}</p>
          <div className={styles.text}>{comparison.changes.map((change, index) => change.kind === "del" ? <del key={index}>{change.text}</del> : change.kind === "add" ? <ins key={index}>{change.text}</ins> : <span key={index}>{change.text}</span>)}</div>
        </>}
      </> : <p>Text for a selected revision is unavailable. Reload its history before comparing.</p>}
      <button type="button" className={styles.restore} onClick={() => setCompared(null)}>Close comparison</button>
    </section>}
  </aside>;
}
