"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { AuthorHeader, AuthorPage } from "../../components/AuthorShell";
import type { Asset, Book, Folder, Workspace } from "@bookworm/types";
import AssetBrowser from "../../components/AssetBrowser";
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
  const [kind, setKind] = useState<"illustration" | "front_cover">("illustration");
  const [imageName, setImageName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [referenceAssetIds, setReferenceAssetIds] = useState<string[]>([]);
  const imageRequest = useRef<{ fingerprint: string; key: string } | null>(null);
  const [bookId, setBookId] = useState("");
  const [quality, setQuality] = useState<"low" | "medium" | "high">("medium");
  const [generating, setGenerating] = useState(false);
  const [imageJobs, setImageJobs] = useState<ImageGenerationJob[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadedWorkspace, setHistoryLoadedWorkspace] = useState<string | null>(null);
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
    setImageJobs([]); setHistoryError(null); setHistoryLoadedWorkspace(null);
    if (!workspaceId) return;
    setHistoryLoading(true);
    void api.listImageGenerationJobs(workspaceId).then(result => {
      if (live) { setImageJobs(result.jobs); setHistoryLoadedWorkspace(workspaceId); }
    }).catch(() => {
      if (live) setHistoryError("Image request history is temporarily unavailable. Your asset files are unchanged.");
    }).finally(() => { if (live) setHistoryLoading(false); });
    return () => { live = false; };
  }, [api, workspaceId, historyRevision]);

  const pendingImageRequest = imageJobs.some(job => job.status === "queued" || job.status === "running");
  const imageDispatchReady = historyLoadedWorkspace === workspaceId && !historyLoading && !historyError && !pendingImageRequest;

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
    setBookId("");
    setBooks([]);
    setFolders([]);
    setAssets([]);
    setReferenceAssetIds([]);
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

  const generate = async () => {
    if (!workspaceId || !canEdit || !imageDispatchReady || generating || finalizingImage || !imageName.trim() || prompt.trim().length < 10) return;
    setGenerating(true);
    setError(null);
    try {
      const imageInput = {
        workspaceId,
        bookId: bookId || null,
        kind,
        name: imageName.trim(),
        prompt: prompt.trim(),
        referenceAssetIds,
        quality,
      };
      const fingerprint = JSON.stringify(imageInput);
      if (imageRequest.current?.fingerprint !== fingerprint) imageRequest.current = { fingerprint, key: crypto.randomUUID() };
      const result = await api.generateImage({ ...imageInput, idempotencyKey: imageRequest.current.key });
      imageRequest.current = null;
      setPrompt("");
      setImageName("");
      await load();
      setOpen(result.asset);
      setPreviewUrl(result.preview.url);
      const [v, u] = await Promise.all([api.listAssetVersions(result.asset.id), api.getAssetUsage(result.asset.id)]);
      setVersions(v.versions);
      setUsage(u.links);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Image generation failed");
    } finally {
      setGenerating(false);
      setHistoryRevision(value => value + 1);
    }
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
                <select disabled={generating || !!finalizingImage} value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} className="ml-3 rounded-lg border border-white/10 bg-black px-3 py-2 text-white">
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

        <section className="mb-8 rounded-2xl border border-white/10 bg-white/[0.04] p-6" aria-labelledby="image-generator-title">
          {accessError ? <div role="alert" className="mb-4 text-sm text-amber-200"><p>Editing permissions are unavailable. Your files remain viewable; changes are disabled.</p><button type="button" className="mt-2 underline" onClick={() => setAccessRevision(value => value + 1)}>Retry permission check</button></div> : !canEdit && <p className="mb-4 text-sm text-[#aaa]">{assetAccess ? "Read-only access: you can view assets, but cannot upload, generate, or change them." : "Checking workspace editing permissions…"}</p>}
          <fieldset disabled={!canEdit} className="min-w-0">
          <div className="mb-5">
            <h2 id="image-generator-title" className="text-xl font-semibold text-white">Generate artwork</h2>
            <p className="mt-1 text-sm text-[#9a9a9a]">Create a private illustration or cover-art draft. Cover typography is added later during layout.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm text-[#b5b5b5]">Asset type
              <select value={kind} onChange={(event) => setKind(event.target.value as "illustration" | "front_cover")} className="mt-2 block w-full rounded-xl border border-white/10 bg-black/60 px-3 py-3 text-white">
                <option value="illustration">Illustration</option>
                <option value="front_cover">Front cover art</option>
              </select>
            </label>
            <label className="text-sm text-[#b5b5b5]">Book context
              <select value={bookId} onChange={(event) => setBookId(event.target.value)} className="mt-2 block w-full rounded-xl border border-white/10 bg-black/60 px-3 py-3 text-white">
                <option value="">No book selected</option>
                {books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}
              </select>
            </label>
            <label className="text-sm text-[#b5b5b5]">Asset name
              <input value={imageName} onChange={(event) => setImageName(event.target.value)} maxLength={256} placeholder="Chapter 3 forest scene" className="mt-2 block w-full rounded-xl border border-white/10 bg-black/60 px-3 py-3 text-white" />
            </label>
            <label className="text-sm text-[#b5b5b5]">Quality
              <select value={quality} onChange={(event) => setQuality(event.target.value as "low" | "medium" | "high")} className="mt-2 block w-full rounded-xl border border-white/10 bg-black/60 px-3 py-3 text-white">
                <option value="low">Low: quick draft</option>
                <option value="medium">Medium: standard</option>
                <option value="high">High: final candidate</option>
              </select>
            </label>
          </div>
          <label className="mt-4 block text-sm text-[#b5b5b5]">Creative brief
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} rows={4} placeholder="Describe the scene, characters, mood, palette, and visual style…" className="mt-2 block w-full resize-y rounded-xl border border-white/10 bg-black/60 px-3 py-3 text-white" />
          </label>
          <fieldset disabled={generating} className="mt-4 space-y-2">
            <legend className="text-sm text-[#b5b5b5]">Reference images · up to four PNGs</legend>
            <p className="text-xs text-[#999]">Selected private images are sent to the image provider with your brief. Use references you have permission to use. Each must be at most 5 MiB and pass integrity and scan checks.</p>
            {assets.filter(asset => asset.mime_type === "image/png" && asset.checksum !== "pending" && asset.size_bytes <= 5 * 1024 * 1024).map(asset => <label key={asset.id} className="flex items-center gap-2 text-sm text-[#bbb]">
              <input type="checkbox" checked={referenceAssetIds.includes(asset.id)} disabled={!referenceAssetIds.includes(asset.id) && referenceAssetIds.length >= 4}
                onChange={event => setReferenceAssetIds(ids => event.target.checked ? [...ids, asset.id] : ids.filter(id => id !== asset.id))} />{asset.name}
            </label>)}
          </fieldset>
          <div className="mt-4 flex items-center justify-between gap-4">
            <p className="text-xs text-[#777]">Uses one image credit after the image is safely stored.</p>
            <button type="button" onClick={() => void generate()} disabled={!workspaceId || !canEdit || !imageDispatchReady || generating || !imageName.trim() || prompt.trim().length < 10} className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">
              {generating ? "Generating…" : "Generate image"}
            </button>
          </div>
          {pendingImageRequest && <p role="status" className="mt-2 text-xs text-amber-200">An earlier image request is pending. Check its status below before starting another; an uncertain provider response is not retried automatically.</p>}
          {!historyLoadedWorkspace && historyError && <p className="mt-2 text-xs text-amber-200">Image generation is paused until request history can be checked. Refresh image history to retry.</p>}
          </fieldset>
        </section>

        <section className="mb-8 rounded-2xl border border-white/10 p-5" aria-labelledby="image-history-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="image-history-title" className="text-lg font-semibold">Your recent image requests</h2>
            <button type="button" disabled={!workspaceId || historyLoading} onClick={() => setHistoryRevision(value => value + 1)} className="text-sm text-[#bbb] underline disabled:opacity-50">Refresh image history</button>
          </div>
          <p className="mt-2 text-xs leading-5 text-[#999]">Latest 20 requests by you in this workspace. A pending request may still be processing or need recovery; refresh before submitting another image. This list never retries or spends credits.</p>
          {historyError && <p role="alert" className="mt-3 text-sm text-amber-200">{historyError}</p>}
          {historyLoading ? <p role="status" className="mt-3 text-sm text-[#999]">Loading image history…</p> : !historyError && !imageJobs.length ? <p className="mt-3 text-sm text-[#999]">No image requests found.</p> : null}
          <ul className="mt-3 divide-y divide-white/10">{imageJobs.map(job => <li key={job.id} className="py-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2"><span>{job.kind === "front_cover" ? "Cover artwork" : "Illustration"}</span><span>{job.status === "succeeded" ? "Saved to asset library" : job.status === "failed" ? "Failed — review before starting again" : "Pending confirmation"}</span></div>
            <p className="mt-1 break-all text-xs text-[#888]">{job.createdAt} · Request {job.id}</p>
            {job.status === "running" && canEdit && <div className="mt-2"><button type="button" disabled={!!finalizingImage || generating} className="text-sm underline disabled:opacity-50" onClick={async () => {
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
