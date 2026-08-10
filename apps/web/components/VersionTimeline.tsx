"use client";

import { useState } from "react";

export interface VersionSummary {
  id: string;
  version_number: number;
  created_by: string;
  change_summary?: string | null;
  created_at: string;
  /** present when loaded for diffing */
  plain_text?: string;
}

export interface VersionTimelineProps {
  versions: VersionSummary[];
  onCompare: (aId: string, bId: string) => void;
  onRestore: (versionId: string) => void;
}

// ponytail: LCS word diff, O(n*m). Fine for chapter-sized texts; swap in the
// `diff` package if large docs get slow.
function wordDiff(a: string, b: string) {
  const wa = a.split(/\s+/).filter(Boolean);
  const wb = b.split(/\s+/).filter(Boolean);
  const dp: number[][] = Array.from({ length: wa.length + 1 }, () => new Array(wb.length + 1).fill(0));
  for (let i = wa.length - 1; i >= 0; i--)
    for (let j = wb.length - 1; j >= 0; j--)
      dp[i][j] = wa[i] === wb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { kind: "same" | "add" | "del"; word: string }[] = [];
  let i = 0, j = 0;
  while (i < wa.length && j < wb.length) {
    if (wa[i] === wb[j]) { out.push({ kind: "same", word: wa[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: "del", word: wa[i] }); i++; }
    else { out.push({ kind: "add", word: wb[j] }); j++; }
  }
  while (i < wa.length) out.push({ kind: "del", word: wa[i++] });
  while (j < wb.length) out.push({ kind: "add", word: wb[j++] });
  return out;
}

export default function VersionTimeline({ versions, onCompare, onRestore }: VersionTimelineProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [diff, setDiff] = useState<ReturnType<typeof wordDiff> | null>(null);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]));

  const compare = () => {
    const [a, b] = selected.map((id) => versions.find((v) => v.id === id));
    if (!a || !b) return;
    onCompare(a.id, b.id);
    setDiff(wordDiff(a.plain_text ?? "", b.plain_text ?? ""));
  };

  return (
    <aside aria-label="Versions" style={{ padding: 8 }}>
      <h3 style={{ margin: "4px 8px" }}>Versions</h3>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {[...versions].sort((x, y) => y.version_number - x.version_number).map((v) => (
          <li key={v.id} style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
              <input type="checkbox" checked={selected.includes(v.id)} onChange={() => toggle(v.id)} />
              <span>
                <strong>v{v.version_number}</strong> — {new Date(v.created_at).toLocaleString()}
                <br />
                <small>{v.created_by}{v.change_summary ? ` · ${v.change_summary}` : ""}</small>
              </span>
            </label>
            <button style={{ marginLeft: 22 }} onClick={() => onRestore(v.id)}>Restore</button>
          </li>
        ))}
      </ul>
      <button disabled={selected.length !== 2} onClick={compare} style={{ margin: 8 }}>
        Compare selected
      </button>
      {diff && (
        <div style={{ margin: 8, padding: 8, border: "1px solid #ddd", borderRadius: 4, fontSize: 14, lineHeight: 1.6 }}>
          {diff.map((d, i) => (
            <span
              key={i}
              style={
                d.kind === "add"
                  ? { background: "#d4f7d4", textDecoration: "none" }
                  : d.kind === "del"
                    ? { background: "#fbd5d5", textDecoration: "line-through" }
                    : undefined
              }
            >
              {d.word}{" "}
            </span>
          ))}
        </div>
      )}
    </aside>
  );
}
