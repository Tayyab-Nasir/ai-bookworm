"use client";

import type { Chapter } from "@bookworm/types";

export interface BookTreeProps {
  chapters: Chapter[];
  activeId: string | null;
  onSelect: (chapterId: string) => void;
  onReorder: (orderedIds: string[]) => void;
}

export default function BookTree({ chapters, activeId, onSelect, onReorder }: BookTreeProps) {
  const move = (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= chapters.length) return;
    const ids = chapters.map((c) => c.id);
    [ids[index], ids[j]] = [ids[j], ids[index]];
    onReorder(ids);
  };

  return (
    <nav aria-label="Chapters" style={{ padding: 8 }}>
      <h3 style={{ margin: "4px 8px" }}>Chapters</h3>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {chapters.map((c, i) => (
          <li
            key={c.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 8px",
              borderRadius: 4,
              background: c.id === activeId ? "#e0ecff" : "transparent",
            }}
          >
            <button
              onClick={() => onSelect(c.id)}
              style={{ flex: 1, textAlign: "left", border: 0, background: "none", cursor: "pointer", fontWeight: c.id === activeId ? 600 : 400 }}
            >
              {i + 1}. {c.title || "Untitled"}
            </button>
            <button aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button aria-label="Move down" disabled={i === chapters.length - 1} onClick={() => move(i, 1)}>↓</button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
