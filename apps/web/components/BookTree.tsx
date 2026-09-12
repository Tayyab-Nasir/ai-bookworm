"use client";

import type { Chapter } from "@bookworm/types";

export interface BookTreeProps {
  chapters: Chapter[];
  activeId: string | null;
  onSelect: (chapterId: string) => void;
  onReorder: (orderedIds: string[]) => void;
  disabled?: boolean;
  readOnly?: boolean;
}

export default function BookTree({ chapters, activeId, onSelect, onReorder, disabled, readOnly }: BookTreeProps) {
  const move = (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= chapters.length) return;
    const ids = chapters.map((c) => c.id);
    [ids[index], ids[j]] = [ids[j], ids[index]];
    onReorder(ids);
  };

  return (
    <nav aria-label="Chapters" className="p-2">
      <div className="flex items-center justify-between gap-3 px-2 pb-3 pt-1">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-white/35">Manuscript</p>
          <h3 className="mt-1 text-sm font-medium text-white">Chapters</h3>
        </div>
        <span className="rounded-full border border-white/10 bg-white/[0.035] px-2 py-1 text-[10px] tabular-nums text-white/45">{chapters.length}</span>
      </div>
      <ul className="space-y-1">
        {chapters.map((c, i) => (
          <li
            key={c.id}
            className={`group flex items-center gap-1 rounded-xl border px-1 py-1 transition-colors ${c.id === activeId ? "border-white/[0.14] bg-white/[0.09]" : "border-transparent hover:border-white/[0.08] hover:bg-white/[0.035]"}`}
          >
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSelect(c.id)}
              aria-current={c.id === activeId ? "page" : undefined}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-xs outline-none transition focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-45 ${c.id === activeId ? "font-medium text-white" : "text-white/60 hover:text-white"}`}
            >
              <span className="w-4 shrink-0 text-[10px] tabular-nums text-white/30">{String(i + 1).padStart(2, "0")}</span>
              <span className="truncate">{c.title || "Untitled"}</span>
            </button>
            {!readOnly && <div className="flex shrink-0 gap-0.5 pr-1 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
              <button type="button" aria-label={`Move ${c.title} up`} disabled={disabled || i === 0} onClick={() => move(i, -1)} className="grid size-7 place-items-center rounded-md text-sm text-white/55 outline-none transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-25">↑</button>
              <button type="button" aria-label={`Move ${c.title} down`} disabled={disabled || i === chapters.length - 1} onClick={() => move(i, 1)} className="grid size-7 place-items-center rounded-md text-sm text-white/55 outline-none transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-25">↓</button>
            </div>}
          </li>
        ))}
      </ul>
    </nav>
  );
}
