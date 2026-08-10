"use client";

import { useMemo, useState } from "react";
import type { Asset, Folder } from "@bookworm/types";

export interface AssetPermissions {
  edit: boolean;
  approve: boolean;
  manage: boolean;
}

export interface AssetBrowserProps {
  folders: Folder[];
  assets: Asset[];
  permissions: AssetPermissions;
  onMove: (assetId: string, folderId: string | null) => void;
  onOpen: (asset: Asset) => void;
  onUpload: (folderId: string | null) => void;
  onNewFolder?: (parentId: string | null, name: string) => void;
  onSeedTemplate?: () => void;
  onDelete?: (assetId: string) => void;
  onRestore?: (assetId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "#9e9e9e",
  in_review: "#1e88e5",
  approved: "#43a047",
  rejected: "#e53935",
  archived: "#757575",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      style={{
        background: STATUS_COLORS[status] ?? "#9e9e9e",
        color: "#fff",
        borderRadius: 8,
        padding: "1px 8px",
        fontSize: 11,
      }}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export default function AssetBrowser({
  folders,
  assets,
  permissions,
  onMove,
  onOpen,
  onUpload,
  onNewFolder,
  onSeedTemplate,
  onDelete,
  onRestore,
}: AssetBrowserProps) {
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const childrenOf = useMemo(() => {
    const m = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const arr = m.get(f.parent_folder_id) ?? [];
      arr.push(f);
      m.set(f.parent_folder_id, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [folders]);

  const visibleAssets = useMemo(
    () => assets.filter((a) => (a.folder_id ?? null) === activeFolder),
    [assets, activeFolder],
  );

  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderFolder = (f: Folder, depth: number) => {
    const kids = childrenOf.get(f.id) ?? [];
    const open = expanded.has(f.id);
    return (
      <li key={f.id} style={{ listStyle: "none" }}>
        <div style={{ display: "flex", gap: 4, paddingLeft: depth * 14 }}>
          {kids.length > 0 ? (
            <button aria-label={open ? "Collapse" : "Expand"} onClick={() => toggle(f.id)} style={{ border: 0, background: "none", cursor: "pointer" }}>
              {open ? "▾" : "▸"}
            </button>
          ) : (
            <span style={{ width: 16, display: "inline-block" }} />
          )}
          <button
            onClick={() => setActiveFolder(f.id)}
            style={{
              border: 0,
              background: activeFolder === f.id ? "#e3f2fd" : "none",
              cursor: "pointer",
              textAlign: "left",
              flex: 1,
              padding: "2px 4px",
              borderRadius: 4,
            }}
          >
            {f.name}
          </button>
        </div>
        {open && <ul style={{ margin: 0, padding: 0 }}>{kids.map((k) => renderFolder(k, depth + 1))}</ul>}
      </li>
    );
  };

  const newFolder = () => {
    const name = window.prompt("Folder name");
    if (name?.trim() && onNewFolder) onNewFolder(activeFolder, name.trim());
  };

  return (
    <div style={{ display: "flex", gap: 12, minHeight: 400 }}>
      <aside aria-label="Folders" style={{ width: 220, borderRight: "1px solid #eee", padding: 8 }}>
        <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
          <button onClick={() => setActiveFolder(null)} style={{ fontWeight: activeFolder === null ? 700 : 400 }}>
            Root
          </button>
          {permissions.manage && onNewFolder && <button onClick={newFolder}>+ Folder</button>}
        </div>
        {folders.length === 0 && permissions.manage && onSeedTemplate && (
          <button onClick={onSeedTemplate}>Seed 00_Admin…08_Archive template</button>
        )}
        <ul style={{ margin: 0, padding: 0 }}>{(childrenOf.get(null) ?? []).map((f) => renderFolder(f, 0))}</ul>
      </aside>

      <section style={{ flex: 1, padding: 8 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button onClick={() => setView(view === "grid" ? "list" : "grid")}>{view === "grid" ? "List view" : "Grid view"}</button>
          {permissions.edit && <button onClick={() => onUpload(activeFolder)}>Upload</button>}
        </div>
        {visibleAssets.length === 0 && <p style={{ color: "#777" }}>No assets here.</p>}
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: view === "grid" ? "grid" : "block",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 8,
          }}
        >
          {visibleAssets.map((a) => (
            <li key={a.id} style={{ border: "1px solid #eee", borderRadius: 6, padding: 8 }}>
              <button onClick={() => onOpen(a)} style={{ all: "unset", cursor: "pointer", display: "block", width: "100%" }}>
                <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</strong>
                <small style={{ color: "#777" }}>
                  {a.type} · {(a.size_bytes / 1024).toFixed(0)} KB
                </small>
              </button>
              <div style={{ display: "flex", gap: 4, marginTop: 4, alignItems: "center" }}>
                <StatusBadge status={a.status} />
                {permissions.manage && onDelete && (
                  <button onClick={() => onDelete(a.id)} title="Soft delete">Delete</button>
                )}
              </div>
              {permissions.edit && folders.length > 0 && (
                <select
                  aria-label="Move to folder"
                  value={a.folder_id ?? ""}
                  onChange={(e) => onMove(a.id, e.target.value || null)}
                  style={{ marginTop: 4, width: "100%" }}
                >
                  <option value="">(root)</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
