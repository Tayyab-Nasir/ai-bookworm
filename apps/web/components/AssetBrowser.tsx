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

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
        status === "approved"
          ? "bg-green-500/20 text-green-400"
          : status === "in_review"
          ? "bg-amber-400/20 text-amber-400"
          : status === "rejected"
          ? "bg-red-500/20 text-red-400"
          : status === "archived"
          ? "bg-ink-600/20 text-ink-400"
          : "bg-ink-600/20 text-ink-400"
      }`}
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
            <button
              aria-label={open ? "Collapse" : "Expand"}
              onClick={() => toggle(f.id)}
              style={{
                border: 0,
                background: "none",
                cursor: "pointer",
                color: "var(--color-ink-300)",
                fontSize: "18px",
              }}
            >
              {open ? "▾" : "▸"}
            </button>
          ) : (
            <span style={{ width: 16, display: "inline-block", color: "var(--color-ink-300)" }} />
          )}
          <button
            onClick={() => setActiveFolder(f.id)}
            style={{
              border: 0,
              background: activeFolder === f.id ? "var(--color-amber-400)" : "none",
              cursor: "pointer",
              textAlign: "left",
              flex: 1,
              padding: "4px 8px",
              borderRadius: 6,
              color: activeFolder === f.id ? "#0b1220" : "var(--color-ink-100)",
              fontWeight: activeFolder === f.id ? 600 : 400,
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
    <div className="flex gap-6 min-h-[400px]">
      {/* Folders Sidebar */}
      <aside aria-label="Folders" className="w-64 border-r border-ink-700 pr-4">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-sm font-semibold text-ink-300 uppercase tracking-wider">Folders</h2>
          {permissions.manage && onNewFolder && (
            <button onClick={newFolder} className="btn btn-primary" style={{ padding: "4px 8px", fontSize: "14px" }}>
              + New
            </button>
          )}
        </div>

        {folders.length === 0 && permissions.manage && onSeedTemplate && (
          <button onClick={onSeedTemplate} className="btn btn-secondary mb-4 w-full justify-center">
            Seed template
          </button>
        )}

        <nav>
          <button
            onClick={() => setActiveFolder(null)}
            className="w-full text-left px-2 py-1.5 rounded-lg mb-1"
            style={{
              fontWeight: activeFolder === null ? 600 : 400,
              background: activeFolder === null ? "var(--color-ink-800)" : "none",
              color: "var(--color-ink-100)",
            }}
          >
            Root
          </button>
          <ul style={{ margin: 0, padding: 0 }}>{(childrenOf.get(null) ?? []).map((f) => renderFolder(f, 0))}</ul>
        </nav>
      </aside>

      {/* Assets Grid/List */}
      <section className="flex-1">
        <div className="flex justify-between items-center mb-4">
          <div className="flex gap-2">
            <button
              onClick={() => setView("list")}
              className={`btn ${view === "list" ? "btn-primary" : "btn-secondary"}`}
              style={{ padding: "6px 12px", fontSize: "14px" }}
            >
              List
            </button>
            <button
              onClick={() => setView("grid")}
              className={`btn ${view === "grid" ? "btn-primary" : "btn-secondary"}`}
              style={{ padding: "6px 12px", fontSize: "14px" }}
            >
              Grid
            </button>
          </div>

          {permissions.edit && (
            <button className="btn btn-primary text-sm" onClick={() => onUpload(activeFolder)}>
              Upload Asset
            </button>
          )}
        </div>

        {visibleAssets.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-ink-400 mb-2" style={{ fontSize: "48px" }}>
              📁
            </div>
            <h3 className="text-lg font-semibold text-white mb-2">No assets here</h3>
            <p className="text-ink-400">
              {activeFolder === null ? "Upload files to the root folder" : "Folder is empty"}
            </p>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: view === "grid" ? "repeat(auto-fill, minmax(180px, 1fr))" : "1fr",
              gap: "1rem",
            }}
          >
            {visibleAssets.map((a) => (
              <div
                key={a.id}
                className="card hover:border-amber-400/30 transition-all duration-200"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <button
                  onClick={() => onOpen(a)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                  }}
                >
                  <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.name}
                  </strong>
                  <small style={{ color: "var(--color-ink-400)" }}>
                    {a.type} · {(a.size_bytes / 1024).toFixed(0)} KB
                  </small>
                </button>

                <div className="flex justify-between items-center mt-2">
                  <StatusBadge status={a.status} />
                  {permissions.manage && onDelete && (
                    <button
                      onClick={() => onDelete(a.id)}
                      title="Delete"
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        color: "var(--color-ink-400)",
                        fontSize: "16px",
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>

                {permissions.manage && folders.length > 0 && (
                  <select
                    aria-label="Move to folder"
                    value={a.folder_id ?? ""}
                    onChange={(e) => onMove(a.id, e.target.value || null)}
                    style={{
                      marginTop: "8px",
                      width: "100%",
                      padding: "6px 8px",
                      borderRadius: "6px",
                      border: "1px solid var(--color-ink-700)",
                      background: "var(--color-ink-800)",
                      color: "var(--color-ink-100)",
                      fontSize: "13px",
                    }}
                  >
                    <option value="">(root)</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}