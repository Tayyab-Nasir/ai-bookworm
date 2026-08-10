"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import type { Asset, Folder } from "@bookworm/types";
import AssetBrowser from "../../components/AssetBrowser";
import { apiClient, DEMO_WORKSPACE } from "../../components/api";

interface VersionRow {
  id: string;
  version_number: number;
  checksum: string;
  created_by: string;
  created_at: string;
}

// ponytail: workspace comes from ?ws= until the WorkspaceSwitcher lands;
// without an API the page renders an empty offline shell.
function AssetsPageInner() {
  const workspaceId = useSearchParams().get("ws") ?? DEMO_WORKSPACE;
  const api = apiClient();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [open, setOpen] = useState<Asset | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [usage, setUsage] = useState<{ id: string; entity_type: string; entity_id: string; usage_role: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const [f, a] = await Promise.all([api.listFolders(workspaceId), api.listAssets(workspaceId)]);
      setFolders(f.folders);
      setAssets(a.assets);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openAsset = async (a: Asset) => {
    setOpen(a);
    if (!api) return;
    const [v, u] = await Promise.all([api.listAssetVersions(a.id), api.getAssetUsage(a.id)]);
    setVersions(v.versions);
    setUsage(u.links);
  };

  const upload = (folderId: string | null) => {
    if (!api) return;
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const { uploadUrl, assetId } = await api.createAssetUploadUrl({
        workspaceId,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        folderId,
      });
      const buf = await file.arrayBuffer();
      await fetch(uploadUrl, { method: "PUT", body: buf });
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const checksumSha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      await api.confirmAssetUpload(assetId, { checksumSha256, sizeBytes: file.size });
      await load();
    };
    input.click();
  };

  return (
    <main style={{ padding: 16 }}>
      <h1>Assets</h1>
      {error && <p role="alert" style={{ color: "#e53935" }}>{error}</p>}
      {!api && <p style={{ color: "#777" }}>Offline demo — set NEXT_PUBLIC_API_URL/NEXT_PUBLIC_API_TOKEN and pass ?ws=&lt;workspaceId&gt;.</p>}
      <AssetBrowser
        folders={folders}
        assets={assets}
        permissions={{ edit: true, approve: true, manage: true }}
        onMove={async (assetId, folderId) => {
          await api?.updateAsset(assetId, { folderId });
          await load();
        }}
        onOpen={(a) => void openAsset(a)}
        onUpload={upload}
        onNewFolder={async (parentId, name) => {
          await api?.createFolder(workspaceId, { name, parentFolderId: parentId });
          await load();
        }}
        onSeedTemplate={async () => {
          await api?.seedFolderTemplate(workspaceId);
          await load();
        }}
        onDelete={async (assetId) => {
          await api?.deleteAsset(assetId);
          await load();
        }}
      />
      {open && (
        <div
          role="dialog"
          aria-label={`Asset ${open.name}`}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "grid", placeItems: "center" }}
          onClick={() => setOpen(null)}
        >
          <div style={{ background: "#fff", padding: 16, borderRadius: 8, maxWidth: 560, width: "90%" }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>{open.name}</h2>
            <p>
              <small>
                {open.mime_type} · {(open.size_bytes / 1024).toFixed(0)} KB · sha256 {open.checksum.slice(0, 12)}…
              </small>
            </p>
            {open.mime_type.startsWith("image/") ? (
              <p style={{ color: "#777" }}>Preview requires a signed download URL (TODO).</p>
            ) : null}
            <h3>Versions</h3>
            <ul>
              {versions.map((v) => (
                <li key={v.id}>
                  v{v.version_number} · {new Date(v.created_at).toLocaleString()} · {v.checksum.slice(0, 12)}…
                </li>
              ))}
            </ul>
            <h3>Used in</h3>
            {usage.length === 0 ? (
              <p style={{ color: "#777" }}>Not linked anywhere.</p>
            ) : (
              <ul>
                {usage.map((l) => (
                  <li key={l.id}>{l.entity_type} {l.entity_id.slice(0, 8)}{l.usage_role ? ` (${l.usage_role})` : ""}</li>
                ))}
              </ul>
            )}
            <button onClick={() => setOpen(null)}>Close</button>
          </div>
        </div>
      )}
    </main>
  );
}

export default function AssetsPage() {
  return (
    <Suspense>
      <AssetsPageInner />
    </Suspense>
  );
}
