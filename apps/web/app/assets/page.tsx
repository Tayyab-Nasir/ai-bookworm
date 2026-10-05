"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { AuthorHeader, AuthorPage } from "../../components/AuthorShell";
import type { Asset, Book, Folder, Workspace } from "@bookworm/types";
import AssetBrowser from "../../components/AssetBrowser";
import ImageQuoteStudio from "../../components/ImageQuoteStudio";
import { apiClient } from "../../components/api";
import type { ImageGenerationJob } from "@bookworm/api-client";

interface VersionRow {
  id: string;
  version_number: number;
  checksum: string;
  scan_status: "pending" | "clean" | "infected" | "error" | "trusted_generated";
  detected_mime_type?: string | null;
  created_by: string;
  created_at: string;
}

function AssetsPageInner() {
  const requestedWorkspaceId = useSearchParams().get("ws");
  const api = apiClient();
  const [workspaceId, setWorkspaceId] = useState(requestedWorkspaceId ?? "");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetAccess, setAssetAccess] = useState<{ workspaceId: string; canEdit: boolean } | null>(null);
  const [accessError, setAccessError] = useState(false);
  const [accessRevision, setAccessRevision] = useState(0);
  const canEdit = assetAccess?.workspaceId === workspaceId && assetAccess.canEdit;
  const [books, setBooks] = useState<Book[]>([]);
  const [open, setOpen] = useState<Asset | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [usage, setUsage] = useState<{ id: string; entity_type: string; entity_id: string; usage_role: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [imageJobs, setImageJobs] = useState<ImageGenerationJob[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [finalizingImage, setFinalizingImage] = useState<string | null>(null);
  const [uploadStage, setUploadStage] = useState<"uploading" | "scanning" | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeDialogRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    setAssetAccess(null); setAccessError(false);
    if (workspaceId) void api.getAssetAccess(workspaceId).then(access => {
      if (live) setAssetAccess({ workspaceId, canEdit: access.canEdit });
    }).catch(() => { if (live) setAccessError(true); });
    return () => { live = false; };
  }, [api, workspaceId, accessRevision]);

  useEffect(() => {
    let live = true;
    setImageJobs([]); setHistoryError(null);
    if (!workspaceId) return;
    setHistoryLoading(true);
    void api.listImageGenerationJobs(workspaceId).then(result => {
      if (live) setImageJobs(result.jobs);
    }).catch(() => {
      if (live) setHistoryError("Image request history is temporarily unavailable. Your asset files are unchanged.");
    }).finally(() => { if (live) setHistoryLoading(false); });
    return () => { live = false; };
  }, [api, workspaceId, historyRevision]);

  useEffect(() => {
    let live = true;
    void api.listWorkspaces().then(({ workspaces: available }) => {
      if (!live) return;
      setWorkspaces(available);
      if (!requestedWorkspaceId) setWorkspaceId(available[0]?.id ?? "");
    }).catch((e: unknown) => {
      if (live) setError(e instanceof Error ? e.message : "Could not load workspaces");
    });
    return () => { live = false; };
  }, [api, requestedWorkspaceId]);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const [f, a, b] = await Promise.all([api.listFolders(workspaceId), api.listAssets(workspaceId), api.listBooks(workspaceId)]);
      setFolders(f.folders);
      setAssets(a.assets);
      setBooks(b.books);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeDialogRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(null);
        setPreviewUrl(null);
      }
      if (event.key === "Tab") {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      previouslyFocused?.focus();
    };
  }, [open]);

  useEffect(() => {
    setBooks([]);
    setFolders([]);
    setAssets([]);
    setOpen(null);
    setPreviewUrl(null);
  }, [workspaceId]);

  const openAsset = async (a: Asset) => {
    setOpen(a);
    setPreviewUrl(null);
    try {
      const [v, u, preview] = await Promise.all([
        api.listAssetVersions(a.id),
        api.getAssetUsage(a.id),
        a.mime_type.startsWith("image/") && a.checksum !== "pending" ? api.getAssetDownloadUrl(a.id) : Promise.resolve(null),
      ]);
      setVersions(v.versions);
      setUsage(u.links);
      setPreviewUrl(preview?.url ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open asset");
    }
  };

  const upload = (folderId: string | null) => {
    if (!workspaceId || !canEdit || uploadStage) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,.md,.markdown,.pdf,.docx,.epub,.png,.jpg,.jpeg,.webp,.gif";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setUploadStage("uploading");
      setUploadNotice(null);
      setError(null);
      try {
        const { uploadUrl, assetId } = await api.createAssetUploadUrl({
          workspaceId,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          folderId,
        });
        const buf = await file.arrayBuffer();
        const uploaded = await fetch(uploadUrl, { method: "PUT", body: buf });
        if (!uploaded.ok) throw new Error("Upload failed before verification.");
        const digest = await crypto.subtle.digest("SHA-256", buf);
        const checksumSha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        setUploadStage("scanning");
        await api.confirmAssetUpload(assetId, { checksumSha256, sizeBytes: file.size });
        await load();
        setUploadNotice(`${file.name} passed integrity checks and malware screening.`);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Upload failed";
        await load();
        setError(message);
      } finally {
        setUploadStage(null);
      }
    };
    input.click();
  };

  return (
    <AuthorPage>
      <AuthorHeader />
      <div className="mx-auto max-w-7xl px-4 pb-16 pt-10 sm:px-6 lg:px-8">
        <div className="mb-8 flex flex-col items-start justify-between gap-5 border-b border-white/[0.09] pb-8 sm:flex-row sm:items-end">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#777]">Visual library</p>
            <h1 className="mt-2 text-4xl font-medium tracking-[-0.055em] text-white">Assets</h1>
            {workspaces.length > 1 && (
              <label className="mt-3 block text-sm text-[#9a9a9a]">Workspace
                <select disabled={!!finalizingImage} value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} className="ml-3 rounded-lg border border-white/10 bg-black px-3 py-2 text-white">
                  {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="glass-solid metal-shine min-h-11 rounded-full px-5 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50" disabled={!workspaceId || !canEdit || Boolean(uploadStage)} onClick={() => upload(null)}>
              {uploadStage === "uploading" ? "Uploading..." : uploadStage === "scanning" ? "Checking file..." : "Upload asset"}
            </button>
            <Link href={workspaceId ? `/assets?ws=${workspaceId}` : "/assets"} className="glass-ghost inline-flex min-h-11 items-center rounded-full px-5 text-sm font-medium">
              Refresh
            </Link>
          </div>
        </div>

        {error && (
          <div role="alert" className="rounded-lg border border-red-300/20 bg-red-300/[0.06] px-6 py-4 mb-6 text-red-100">
            <p className="font-medium">{error}</p>
          </div>
        )}
        {(uploadStage || uploadNotice) && (
          <div aria-live="polite" className="mb-6 rounded-lg border border-white/10 bg-white/[0.04] px-6 py-4 text-sm text-[#c5c5c5]">
            {uploadStage === "uploading" ? "Uploading private bytes..." : uploadStage === "scanning" ? "Verifying checksum, file type, and malware status..." : uploadNotice}
          </div>
        )}

        <ImageQuoteStudio workspaceId={workspaceId} books={books} assets={assets} canEdit={Boolean(canEdit)} onCompleted={load} />
        <section className="mb-8 rounded-2xl border border-white/10 p-5" aria-labelledby="image-history-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="image-history-title" className="text-lg font-semibold">Your recent image requests</h2>
            <button type="button" disabled={!workspaceId || historyLoading} onClick={() => setHistoryRevision(value => value + 1)} className="text-sm text-[#bbb] underline disabled:opacity-50">Refresh image history</button>
          </div>
          <p className="mt-2 text-xs leading-5 text-[#999]">Latest 20 requests by you in this workspace. A pending request may still be processing or need recovery; refresh before submitting another image. This list never retries or spends credits.</p>
          {historyError && <p role="alert" className="mt-3 text-sm text-amber-200">{historyError}</p>}
          {historyLoading ? <p role="status" className="mt-3 text-sm text-[#999]">Loading image history…</p> : !historyError && !imageJobs.length ? <p className="mt-3 text-sm text-[#999]">No image requests found.</p> : null}
          <ul className="mt-3 divide-y divide-white/10">{imageJobs.map(job => <li key={job.id} className="py-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2"><span>{job.kind === "front_cover" ? "Cover artwork" : "Illustration"}</span><span>{job.status === "succeeded" ? "Saved to asset library" : job.status === "failed" ? "Failed — review before starting again" : job.billingMode === "quoted" ? `${job.status} · token-priced request` : "Pending confirmation"}</span></div>
            <p className="mt-1 break-all text-xs text-[#888]">{job.createdAt} · Request {job.id}</p>
            {job.status === "running" && job.billingMode !== "quoted" && canEdit && <div className="mt-2"><button type="button" disabled={!!finalizingImage} className="text-sm underline disabled:opacity-50" onClick={async () => {
              setFinalizingImage(job.id); setHistoryError(null);
              try { await api.finalizeImageJob(job.id); await load(); setHistoryRevision(value => value + 1); }
              catch (reason) { setHistoryError(reason instanceof Error ? reason.message : "Image finalization is unavailable."); }
              finally { setFinalizingImage(null); }
            }}>{finalizingImage === job.id ? "Finalizing…" : "Finalize saved image"}</button><p className="mt-1 text-xs text-[#999]">Uses the existing generated file, if available. Records the original image credit once; never starts another AI generation.</p></div>}
          </li>)}</ul>
        </section>
        <AssetBrowser
          folders={folders}
          assets={assets}
          permissions={{ edit: canEdit, approve: canEdit, manage: canEdit }}
          onMove={async (assetId, folderId) => {
            await api.updateAsset(assetId, { folderId });
            await load();
          }}
          onOpen={(a) => void openAsset(a)}
          onUpload={upload}
          onNewFolder={async (parentId, name) => {
            await api.createFolder(workspaceId, { name, parentFolderId: parentId });
            await load();
          }}
          onSeedTemplate={async () => {
            await api.seedFolderTemplate(workspaceId);
            await load();
          }}
          onDelete={async (assetId) => {
            await api.deleteAsset(assetId);
            await load();
          }}
        />
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="asset-detail-title" className="relative max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-[#080808] p-6 shadow-2xl">
            <div className="flex justify-between items-start mb-4">
              <h2 id="asset-detail-title" className="text-2xl font-medium tracking-[-0.035em] text-white">{open.name}</h2>
              <button
                ref={closeDialogRef}
                type="button"
                onClick={() => { setOpen(null); setPreviewUrl(null); }}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 text-xl text-[#9a9a9a] transition-colors hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                aria-label="Close asset details"
              >
                ×
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              <div>
                {previewUrl && open.mime_type.startsWith("image/") && (
                  <img src={previewUrl} alt={open.name} className="mb-4 max-h-96 w-full rounded-xl border border-white/10 bg-white/5 object-contain" />
                )}
                <p className="text-sm text-[#9a9a9a]">
                  <span className="font-medium">Type:</span> {open.mime_type}
                </p>
                <p className="text-sm text-[#9a9a9a]">
                  <span className="font-medium">Size:</span> {(open.size_bytes / 1024).toFixed(0)} KB
                </p>
                <p className="text-sm text-[#9a9a9a]">
                  <span className="font-medium">Checksum:</span> {open.checksum.slice(0, 12)}…
                </p>
                {open.mime_type.startsWith("image/") && !previewUrl && <p className="mt-2 text-sm text-[#9a9a9a]">Preview unavailable.</p>}
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-white mb-2">Versions</h3>
                <div className="space-y-2">
                  {versions.length > 0 ? (
                    versions.map((v) => (
                      <div key={v.id} className="p-3 bg-white/5 rounded-lg border border-white/10">
                        <div className="flex justify-between text-sm">
                          <span>v{v.version_number}</span>
                          <span className="text-[#9a9a9a]">{new Date(v.created_at).toLocaleString()}</span>
                        </div>
                        <div className="text-[#9a9a9a]">{v.checksum.slice(0, 12)}…</div>
                        <div className="mt-1 text-xs text-[#7f7f7f]">{v.scan_status === "trusted_generated" ? "Trusted internal artifact" : v.scan_status === "clean" ? "Malware scan passed" : v.scan_status === "infected" ? "Rejected by malware scan" : v.scan_status === "error" ? "Scan unavailable, quarantined" : "Awaiting scan"}</div>
                      </div>
                    ))
                  ) : (
                    <p className="text-[#9a9a9a] text-center py-4">No versions yet</p>
                  )}
                </div>
              </div>
            </div>

            <div className="mb-6">
              <h3 className="text-lg font-semibold text-white mb-2">Used in</h3>
              {usage.length === 0 ? (
                <p className="text-[#9a9a9a] text-center py-4">Not linked anywhere.</p>
              ) : (
                <div className="space-y-2">
                  {usage.map((l) => (
                    <div key={l.id} className="p-3 bg-white/5 rounded-lg border border-white/10">
                      <div className="flex justify-between text-sm">
                        <span>{l.entity_type}</span>
                        <span className="text-[#9a9a9a]">
                          {l.entity_id.slice(0, 8)}
                          {l.usage_role ? ` (${l.usage_role})` : ""}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-6 pt-4 border-t border-white/10">
              <button onClick={() => { setOpen(null); setPreviewUrl(null); }} className="w-full btn-primary">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </AuthorPage>
  );
}

export default function AssetsPage() {
  return (
    <Suspense>
      <AssetsPageInner />
    </Suspense>
  );
}
