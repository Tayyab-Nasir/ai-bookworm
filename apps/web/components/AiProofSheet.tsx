import type { SuggestionPreview } from "../lib/ai-suggestion-preview";
import styles from "./AiProofSheet.module.css";

export default function AiProofSheet({ preview }: { preview: SuggestionPreview }) {
  if (preview.state !== "ready") return <p className={styles.warning}>{preview.message}</p>;
  return <section className={styles.proof} aria-label="Proposed manuscript text change">
    <header className={styles.header}><span>Editorial proof</span><span>Characters {preview.from}–{preview.to}</span></header>
    <div className={styles.slips}>
      <div className={styles.slip}>
        <p className={styles.label}>01 / Current saved text</p>
        <p className={styles.passage}>{preview.leading && "…"}{preview.prefix}<del className={styles.removed}>{preview.original || <span aria-label="insertion point">│</span>}</del>{preview.suffix}{preview.trailing && "…"}</p>
      </div>
      <div className={styles.slip}>
        <p className={styles.label}>02 / Proposed text</p>
        <p className={styles.passage}>{preview.leading && "…"}{preview.prefix}<ins className={styles.added}>{preview.replacement || <span aria-label="empty replacement">∅</span>}</ins>{preview.suffix}{preview.trailing && "…"}</p>
      </div>
    </div>
    <p className={styles.note}>Saved plain text only. Review formatting in the manuscript after applying.</p>
  </section>;
}
