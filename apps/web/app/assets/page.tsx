"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AuthorHeader, AuthorPage } from "../../components/AuthorShell";
import type { Asset, Book, Folder, Workspace } from "@bookworm/types";
import AssetBrowser from "../../components/AssetBrowser";
import ImageQuoteStudio from "../../components/ImageQuoteStudio";
import { createClient } from "@bookworm/api-client";
import { readArtifactSession, readBrowserSession } from "../../lib/browser-session";
import { privateUploadUrl } from "../../lib/private-upload";
import type { ImageGenerationJob } from "@bookworm/api-client";
import { rememberWorkspace, replaceWorkspaceQuery, resolveWorkspace } from "../../lib/workspace-selection";

interface VersionRow {
  id: string;
  asset_id?: string;
  storage_path?: string;
  version_number: number;
  checksum: string;
  mime_type?: string;
  size_bytes?: number;
  scan_status: "pending" | "clean" | "infected" | "error" | "trusted_generated";
  detected_mime_type?: string | null;
  created_by: string;
  created_at: string;
}

const downloadMimeTypes = new Set([
  "text/plain", "text/markdown", "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/epub+zip",
  "image/png", "image/jpeg", "image/webp", "image/gif", "audio/mpeg", "application/zip",
]);
const previewMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function verifiedDownloadVersion(asset: Asset, rows: VersionRow[]) {
  const matching = rows.filter(row => row.asset_id === asset.id && row.storage_path === asset.storage_path && row.checksum === asset.checksum);
  const version = matching.length === 1 ? matching[0] : null;
  if (asset.deleted_at || !/^[a-f0-9]{64}$/i.test(asset.checksum) || !downloadMimeTypes.has(asset.mime_type)
    || !Number.isSafeInteger(asset.size_bytes) || asset.size_bytes <= 0
    || !asset.storage_path?.startsWith(`workspaces/${asset.workspace_id}/`) || asset.storage_path.split("/").some(part => !part || part === "." || part === "..")
    || !version || !Number.isSafeInteger(version.version_number) || version.version_number <= 0
    || version.mime_type !== asset.mime_type || version.size_bytes !== asset.size_bytes
    || (asset.current_version_number != null && version.version_number !== asset.current_version_number)
    || !["clean", "trusted_generated"].includes(version.scan_status)
    || (version.scan_status === "clean" && version.detected_mime_type !== asset.mime_type)) {
    throw new Error("The current file version could not be verified. Refresh the library before preparing a download.");
  }
  return version;
}

function verifiedDownloadLink(result: { url: string; expiresIn: number }, asset: Asset, storageOrigin: string) {
  if (typeof result?.url !== "string" || result.url.length > 8192 || result.url.trim() !== result.url || /[\r\n\t]/.test(result.url) || !Number.isSafeInteger(result.expiresIn) || result.expiresIn < 1 || result.expiresIn > 300) {
    throw new Error("The private download link could not be confirmed. Try preparing it again.");
  }
  let url: URL;
  try { url = new URL(result.url); }
  catch { throw new Error("The private download link could not be confirmed. Try preparing it again."); }
  if (url.origin !== storageOrigin || url.username || url.password || url.hash
    || decodeURIComponent(url.pathname) !== `/storage/v1/object/sign/book-assets/${asset.storage_path}`
    || url.searchParams.getAll("token").length !== 1 || !url.searchParams.get("token")
    || [...url.searchParams.keys()].some(key => key !== "token" && key !== "download")
    || url.searchParams.getAll("download").length > 1) {
    throw new Error("The private download link does not match this file. Refresh the library and try again.");
  }
  // Supabase signed-object URLs support this query option without changing the token.
  const filename = asset.name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 240) || "asset";
  url.searchParams.set("download", filename);
  return { url: url.href, filename };
}

type AssetScope = { actor: string; current: () => boolean; begin: () => () => boolean; checked: <T>(work: () => Promise<T>) => Promise<T> };
function scopeChanged() { const e = new Error("Account check superseded."); e.name = "AssetScopeChanged"; return e; }
function ScopedAssetsPage() {
  const [identity, setIdentity] = useState<{ actor: string } | null>(null);
  const [revision, setRevision] = useState<object>({});
  const [active, setActive] = useState(false), [checking, setChecking] = useState(true), [sessionError, setSessionError] = useState("");
  const epoch = useRef<object>({}), identityRef = useRef<{ actor: string } | null>(null), activeRef = useRef(false), mounted = useRef(false);
  const check = useCallback(async () => {
    if (!mounted.current) return;
    const token = {}; epoch.current = token; activeRef.current = false; setActive(false); setChecking(true); setSessionError("");
    try { const account = await readBrowserSession();
      if (mounted.current && epoch.current === token) { const next = identityRef.current?.actor === account.id ? identityRef.current : { actor: account.id }; identityRef.current = next; activeRef.current = true; setIdentity(next); setRevision(token); setActive(true); }
    } catch { if (mounted.current && epoch.current === token) setSessionError("Your account could not be verified. Sign in again or retry."); }
    finally { if (mounted.current && epoch.current === token) setChecking(false); }
  }, []);
  useLayoutEffect(() => { mounted.current = true; void check(); const focus = () => void check(); const visibility = () => { if (document.visibilityState === "visible") void check(); else { epoch.current = {}; activeRef.current = false; setActive(false); setChecking(true); } };
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visibility);
    return () => { mounted.current = false; epoch.current = {}; activeRef.current = false; window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visibility); };
  }, [check]);
  const scope = useMemo<AssetScope | null>(() => { if (!identity) return null;
    const current = () => mounted.current && activeRef.current && identityRef.current === identity;
    const begin = () => { const token = epoch.current; return () => current() && epoch.current === token; };
    const checked = async <T,>(work: () => Promise<T>): Promise<T> => { const valid = begin(); try {
      await readBrowserSession(identity.actor); if (!valid()) throw scopeChanged(); const result = await work(); if (!valid()) throw scopeChanged(); await readBrowserSession(identity.actor); if (!valid()) throw scopeChanged(); return result;
    } catch (error) { if (!valid()) throw scopeChanged(); try { await readBrowserSession(identity.actor); } catch { if (valid()) void check(); } if (!valid()) throw scopeChanged(); throw error; } };
    return { actor: identity.actor, current, begin, checked };
  }, [identity, check]);
  return <>{identity && scope && <AssetsPageInner key={identity.actor} scope={scope} active={active} revision={revision} retry={check} />}{!active && <main className="mx-auto max-w-6xl p-8 text-white"><h1 className="text-3xl">Assets</h1>{checking ? <p role="status">Checking your account…</p> : <p role="alert">{sessionError} <button className="underline" onClick={() => void check()}>Try again</button></p>}</main>}</>;
}

function AssetsPageInner({ scope, active, revision, retry }: { scope: AssetScope; active: boolean; revision: object; retry: () => Promise<void> }) {
  const requestedWorkspaceId = useSearchParams().get("ws");
  const api = useMemo(() => {
    const client = createClient({ baseUrl: "/api/backend", expectedActor: scope.actor });
    return new Proxy(client, { get(target, key, receiver) { const value = Reflect.get(target, key, receiver); return typeof value === "function" ? (...args: unknown[]) => {
      const version = scopeVersion.current, workspace = activeWorkspace.current;
      const current = () => version === scopeVersion.current && workspace === activeWorkspace.current;
      return scope.checked(() => { if (!current()) throw scopeChanged(); return value(...args); }).then(result => { if (!current()) throw scopeChanged(); return result; });
    } : value; } });
  }, [scope]);
  const [verified, setVerified] = useState(false);
  const [verificationError, setVerificationError] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetAccess, setAssetAccess] = useState<{ workspaceId: string; canEdit: boolean } | null>(null);
  const [accessError, setAccessError] = useState(false);
  const [accessRevision, setAccessRevision] = useState(0);
  const [libraryWorkspaceId, setLibraryWorkspaceId] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [librarySnapshotRequest, setLibrarySnapshotRequest] = useState(0);
  const dataReady = Boolean(workspaceId && libraryWorkspaceId === workspaceId && !libraryLoading);
  const canEdit = dataReady && !accessError && assetAccess?.workspaceId === workspaceId && assetAccess.canEdit;
  const [books, setBooks] = useState<Book[]>([]);
  const [open, setOpen] = useState<Asset | null>(null);
  const [previewUrl, setPreviewUrl] = useState<{ url: string; expiresAt: number } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
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
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [download, setDownload] = useState<{ assetId: string; version: number; request: number; url: string; filename: string; storageOrigin: string; expiresAt: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeDialogRef = useRef<HTMLButtonElement>(null);
  const activeWorkspace = useRef("");
  const scopeVersion = useRef(0);
  const libraryRequest = useRef(0);
  const detailRequest = useRef(0);
  const downloadRequest = useRef(0);
  const activeAsset = useRef<string | null>(null);
  const preparingDownload = useRef(false);
  const editReady = useRef(false);
  editReady.current = Boolean(canEdit);

  const resetWorkspaceScope = useCallback((id: string) => {
    activeWorkspace.current = id; scopeVersion.current++; libraryRequest.current++; detailRequest.current++; downloadRequest.current++;
    activeAsset.current = null; preparingDownload.current = false;
    editReady.current = false;
    setWorkspaceId(id); setLibraryWorkspaceId(""); setLibraryLoading(Boolean(id));
    setBooks([]); setFolders([]); setAssets([]); setOpen(null); setPreviewUrl(null); setPreviewError(null); setVersions([]); setUsage([]);
    setAssetAccess(null); setAccessError(false); setImageJobs([]); setHistoryError(null); setHistoryLoading(false);
    setError(null); setUploadNotice(null); setUploadStage(null); setFinalizingImage(null);
    setDetailLoading(false); setDetailError(null); setDownloadBusy(false); setDownloadError(null); setDownload(null);
  }, []);

  const isWorkspaceCurrent = useCallback((id: string) => activeWorkspace.current === id, []);

  function changeWorkspace(id: string) {
    try {
      const selected = resolveWorkspace(workspaces, id)!;
      resetWorkspaceScope(selected.id); rememberWorkspace(workspaces, selected.id); replaceWorkspaceQuery(selected.id);
    } catch (reason) {
      resetWorkspaceScope(""); setError(reason instanceof Error ? reason.message : "Choose an available workspace.");
    }
  }

  const permissionScope = scopeVersion.current;
  const renderedDetailRequest = detailRequest.current;
  function retryAssetAccess() {
    if (!workspaceId || activeWorkspace.current !== workspaceId || scopeVersion.current !== permissionScope) return;
    editReady.current = false;
    setAssetAccess(null); setAccessError(false);
    setAccessRevision(value => value + 1);
  }

  function closeAsset() {
    if (scopeVersion.current !== permissionScope || detailRequest.current !== renderedDetailRequest) return;
    detailRequest.current++; downloadRequest.current++; activeAsset.current = null; preparingDownload.current = false;
    setOpen(null); setPreviewUrl(null); setPreviewError(null); setVersions([]); setUsage([]);
    setDetailLoading(false); setDetailError(null); setDownloadBusy(false); setDownloadError(null); setDownload(null);
  }

  useEffect(() => {
    return () => {
      activeWorkspace.current = ""; activeAsset.current = null; scopeVersion.current++;
      libraryRequest.current++; detailRequest.current++; downloadRequest.current++;
      editReady.current = false; preparingDownload.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    const version = scopeVersion.current;
    const current = () => live && version === scopeVersion.current && activeWorkspace.current === workspaceId;
    setAssetAccess(null); setAccessError(false);
    if (workspaceId) void api.getAssetAccess(workspaceId).then(access => {
      if (current()) setAssetAccess({ workspaceId, canEdit: access.canEdit });
    }).catch(() => { if (current()) setAccessError(true); });
    return () => { live = false; };
  }, [api, workspaceId, accessRevision]);

  useEffect(() => {
    let live = true;
    const version = scopeVersion.current;
    const current = () => live && version === scopeVersion.current && activeWorkspace.current === workspaceId;
    setImageJobs([]); setHistoryError(null);
    if (!workspaceId) return;
    setHistoryLoading(true);
    void api.listImageGenerationJobs(workspaceId).then(result => {
      if (current()) setImageJobs(result.jobs);
    }).catch(() => {
      if (current()) setHistoryError("Image request history is temporarily unavailable. Your asset files are unchanged.");
    }).finally(() => { if (current()) setHistoryLoading(false); });
    return () => { live = false; };
  }, [api, workspaceId, historyRevision]);

  useEffect(() => {
    let live = true;
    // Selecting an already validated workspace updates its URL. Repeating the
    // bootstrap reset for that same selection can fence its own in-flight reads.
    if (!active || (activeWorkspace.current && (!requestedWorkspaceId || activeWorkspace.current === requestedWorkspaceId))) return;
    resetWorkspaceScope("");
    void api.listWorkspaces().then(({ workspaces: available }) => {
      if (!live) return;
      setWorkspaces(available);
      const selected = resolveWorkspace(available, requestedWorkspaceId);
      resetWorkspaceScope(selected?.id ?? "");
      if (selected) rememberWorkspace(available, selected.id);
    }).catch((e: unknown) => {
      if (live) setError(e instanceof Error ? e.message : "Could not load workspaces");
    });
    return () => { live = false; };
  }, [api, requestedWorkspaceId, resetWorkspaceScope, active]);

  const load = useCallback(async () => {
    if (!workspaceId || activeWorkspace.current !== workspaceId) return;
    const version = scopeVersion.current; const valid = scope.begin();
    const request = ++libraryRequest.current;
    const current = () => valid() && version === scopeVersion.current && request === libraryRequest.current && activeWorkspace.current === workspaceId;
    editReady.current = false;
    setLibraryLoading(true); setLibraryWorkspaceId("");
    try {
      const [f, a, b] = await Promise.all([api.listFolders(workspaceId), api.listAssets(workspaceId), api.listBooks(workspaceId)]);
      if (!current()) return;
      if (f.folders.some(folder => folder.workspace_id !== workspaceId) || a.assets.some(asset => asset.workspace_id !== workspaceId) || b.books.some(book => book.workspace_id !== workspaceId)) {
        throw new Error("Asset library does not match the requested workspace. Reload before continuing.");
      }
      setFolders(f.folders);
      setAssets(a.assets);
      setBooks(b.books);
      setLibraryWorkspaceId(workspaceId);
      setLibrarySnapshotRequest(request);
      setError(null);
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : "load failed");
    } finally { if (current()) setLibraryLoading(false); }
  }, [api, workspaceId]);

  useEffect(() => {
    void load();
    return () => { libraryRequest.current++; detailRequest.current++; };
  }, [load]);

  useLayoutEffect(() => {
    let live = true; const valid = scope.begin(); setVerified(false); setVerificationError(false);
    scopeVersion.current++; const request = ++libraryRequest.current; detailRequest.current++; downloadRequest.current++; editReady.current = false;
    setAssetAccess(null); setLibraryWorkspaceId(""); setLibraryLoading(Boolean(activeWorkspace.current)); setOpen(null); setPreviewUrl(null); setPreviewError(null); setDownload(null); activeAsset.current = null; preparingDownload.current = false;
    if (!active) return () => { live = false; };
    const id = activeWorkspace.current;
    if (!id) { setVerified(true); return () => { live = false; }; }
    void Promise.all([api.listWorkspaces(), api.getAssetAccess(id), api.listFolders(id), api.listAssets(id), api.listBooks(id)]).then(([available, access, f, a, b]) => {
      if (!live || !valid() || activeWorkspace.current !== id) return;
      if (!available.workspaces.some(w => w.id === id) || f.folders.some(x => x.workspace_id !== id) || a.assets.some(x => x.workspace_id !== id) || b.books.some(x => x.workspace_id !== id)) throw new Error("Workspace access could not be verified.");
      setWorkspaces(available.workspaces); setAssetAccess({ workspaceId: id, canEdit: access.canEdit }); setAccessError(false); setFolders(f.folders); setAssets(a.assets); setBooks(b.books); setLibraryWorkspaceId(id); setLibrarySnapshotRequest(request); setLibraryLoading(false); setHistoryRevision(x => x + 1); setVerified(true);
    }).catch(() => { if (live && valid()) { setVerificationError(true); setLibraryLoading(false); } });
    return () => { live = false; };
  }, [active, revision, api, scope, workspaceId]);

  useEffect(() => {
    if (!download) return;
    const timer = window.setTimeout(() => setDownload(current => current === download ? null : current), Math.max(0, download.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [download]);

  useEffect(() => {
    if (!previewUrl) return;
    const timer = window.setTimeout(() => setPreviewUrl(current => current === previewUrl ? null : current), Math.max(0, previewUrl.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [previewUrl]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeDialogRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeAsset();
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

  const openAsset = async (a: Asset) => {
    if (!dataReady || scopeVersion.current !== permissionScope || activeWorkspace.current !== workspaceId || a.workspace_id !== workspaceId || !assets.some(asset => asset.id === a.id)) return;
    const version = scopeVersion.current; const request = ++detailRequest.current; const valid = scope.begin();
    const current = () => valid() && version === scopeVersion.current && request === detailRequest.current && activeWorkspace.current === workspaceId;
    activeAsset.current = a.id; downloadRequest.current++; preparingDownload.current = false;
    setOpen(a);
    setPreviewUrl(null); setPreviewError(null); setVersions([]); setUsage([]);
    setDetailLoading(true); setDetailError(null); setDownloadBusy(false); setDownloadError(null); setDownload(null);
    try {
      const [v, u] = await Promise.all([
        api.listAssetVersions(a.id),
        api.getAssetUsage(a.id),
      ]);
      if (!current()) return;
      setVersions(v.versions);
      setUsage(u.links);
      if (previewMimeTypes.has(a.mime_type) && a.checksum !== "pending") {
        try {
          const selected = verifiedDownloadVersion(a, v.versions);
          const startedAt = Date.now();
          const preview = await api.getAssetDownloadUrl(a.id, selected.version_number);
          if (!current()) return;
          const { storageOrigin } = await readArtifactSession(scope.actor);
          if (!current()) return;
          const url = new URL(verifiedDownloadLink(preview, a, storageOrigin).url);
          url.searchParams.delete("download");
          const expiresAt = startedAt + preview.expiresIn * 1000;
          if (expiresAt <= Date.now()) throw new Error("Preview expired.");
          setPreviewUrl({ url: url.href, expiresAt });
        } catch {
          if (current()) setPreviewError("The private preview could not be verified.");
        }
      }
    } catch (e) {
      if (current()) setDetailError(e instanceof Error ? e.message : "Could not open asset");
    } finally { if (current()) setDetailLoading(false); }
  };

  async function prepareDownload(asset: Asset) {
    if (!dataReady || scopeVersion.current !== permissionScope || detailRequest.current !== renderedDetailRequest
      || activeWorkspace.current !== workspaceId || activeAsset.current !== asset.id || preparingDownload.current) return;
    const version = scopeVersion.current; const request = ++downloadRequest.current; const valid = scope.begin();
    const current = () => valid() && version === scopeVersion.current && request === downloadRequest.current && activeWorkspace.current === workspaceId && activeAsset.current === asset.id;
    const startedAt = Date.now();
    preparingDownload.current = true;
    setDownloadBusy(true); setDownloadError(null); setDownload(null);
    try {
      const [library, history] = await Promise.all([api.listAssets(workspaceId), api.listAssetVersions(asset.id)]);
      if (!current()) return;
      if (library.assets.some(row => row.workspace_id !== workspaceId)) throw new Error("The file library does not match this workspace. Refresh before downloading.");
      const saved = library.assets.find(row => row.id === asset.id);
      if (!saved || saved.checksum !== asset.checksum || saved.storage_path !== asset.storage_path || saved.mime_type !== asset.mime_type || saved.size_bytes !== asset.size_bytes) {
        throw new Error("This file changed since you opened it. Refresh the library and open its current version.");
      }
      const selected = verifiedDownloadVersion(saved, history.versions);
      const result = await api.getAssetDownloadUrl(asset.id, selected.version_number);
      if (!current()) return;
      const { storageOrigin } = await readArtifactSession(scope.actor);
      if (!current()) return;
      const link = verifiedDownloadLink(result, saved, storageOrigin);
      const expiresAt = startedAt + result.expiresIn * 1000;
      if (expiresAt <= Date.now()) throw new Error("This download link expired before it was ready. Prepare a new link.");
      setDownload({ assetId: asset.id, version: selected.version_number, request, ...link, storageOrigin, expiresAt });
    } catch (reason) {
      if (current()) setDownloadError(reason instanceof Error ? reason.message : "The download could not be confirmed. Prepare a new link to retry.");
    } finally { if (current()) { preparingDownload.current = false; setDownloadBusy(false); } }
  }

  function refreshLibrary() {
    if (!workspaceId || libraryLoading || uploadStage || finalizingImage || activeWorkspace.current !== workspaceId || scopeVersion.current !== permissionScope) return;
    closeAsset();
    void load();
    setHistoryRevision(value => value + 1);
    retryAssetAccess();
  }

  const upload = (folderId: string | null) => {
    if (!workspaceId || !editReady.current || scopeVersion.current !== permissionScope || activeWorkspace.current !== workspaceId || uploadStage) return;
    const version = scopeVersion.current; const valid = scope.begin();
    const current = () => valid() && version === scopeVersion.current && activeWorkspace.current === workspaceId;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,.md,.markdown,.pdf,.docx,.epub,.png,.jpg,.jpeg,.webp,.gif";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !current() || !editReady.current) return;
      setUploadStage("uploading");
      setUploadNotice(null);
      setError(null);
      try {
        const assetId = crypto.randomUUID();
        const ticket = await scope.checked(() => api.createAssetUploadUrl({
          workspaceId,
          requestId: assetId,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          folderId,
        }, scope.actor));
        const buf = await file.arrayBuffer();
        if (!current()) return;
        const { storageOrigin } = await readArtifactSession(scope.actor);
        if (!current()) return;
        const uploadUrl = privateUploadUrl(ticket, { workspaceId, assetId, filename: file.name, storageOrigin });
        const uploaded = await scope.checked(() => { if (!current()) throw scopeChanged(); return fetch(uploadUrl, { method: "PUT", body: buf, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" }); });
        if (!uploaded.ok) throw new Error("Upload failed before verification.");
        const digest = await crypto.subtle.digest("SHA-256", buf);
        const checksumSha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        if (!current()) return;
        setUploadStage("scanning");
        await scope.checked(() => { if (!current()) throw scopeChanged(); return api.confirmAssetUpload(assetId, { checksumSha256, sizeBytes: file.size }, scope.actor); });
        if (current()) await load();
        if (current()) setUploadNotice(`${file.name} passed integrity checks and malware screening.`);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Upload failed";
        if (current()) await load();
        if (current()) setError(message);
      } finally {
        if (current()) setUploadStage(null);
      }
    };
    input.click();
  };

  const mutateLibrary = async (action: () => Promise<unknown>) => {
    if (!editReady.current || scopeVersion.current !== permissionScope || activeWorkspace.current !== workspaceId) return;
    const version = scopeVersion.current; const valid = scope.begin();
    await action();
    if (valid() && version === scopeVersion.current && activeWorkspace.current === workspaceId) await load();
  };

  return (
    <><div hidden={!active || !verified}><AuthorPage>
      <AuthorHeader workspaceId={workspaceId || undefined} />
      <div className="mx-auto max-w-7xl px-4 pb-16 pt-10 sm:px-6 lg:px-8 [&>div:last-child]:flex-col [&>div:last-child>aside]:w-full [&>div:last-child>aside]:border-r-0 [&>div:last-child>aside]:border-b [&>div:last-child>aside]:border-white/10 [&>div:last-child>aside]:pb-4 [&>div:last-child>aside]:pr-0 [&>div:last-child>section]:min-w-0 sm:[&>div:last-child]:flex-row sm:[&>div:last-child>aside]:w-64 sm:[&>div:last-child>aside]:border-b-0 sm:[&>div:last-child>aside]:border-r sm:[&>div:last-child>aside]:pb-0 sm:[&>div:last-child>aside]:pr-4">
        <div className="mb-8 flex flex-col items-start justify-between gap-5 border-b border-white/[0.09] pb-8 sm:flex-row sm:items-end">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#777]">Visual library</p>
            <h1 className="mt-2 text-4xl font-medium tracking-[-0.055em] text-white">Assets</h1>
            {workspaces.length > 0 && (
              <label className="mt-3 block text-sm text-[#9a9a9a]">Workspace
                <select disabled={!!finalizingImage || Boolean(uploadStage)} value={workspaceId} onChange={(event) => changeWorkspace(event.target.value)} className="ml-3 rounded-lg border border-white/10 bg-black px-3 py-2 text-white">
                  <option value="" disabled>Select a workspace</option>
                  {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="glass-solid metal-shine min-h-11 rounded-full px-5 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50" disabled={!workspaceId || !canEdit || Boolean(uploadStage)} onClick={() => upload(null)}>
              {uploadStage === "uploading" ? "Uploading..." : uploadStage === "scanning" ? "Checking file..." : "Upload asset"}
            </button>
            <button type="button" disabled={!workspaceId || libraryLoading || Boolean(uploadStage) || Boolean(finalizingImage)} onClick={refreshLibrary} className="glass-ghost inline-flex min-h-11 items-center rounded-full px-5 text-sm font-medium disabled:opacity-40">
              {libraryLoading ? "Refreshing library…" : "Refresh library"}
            </button>
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

        {workspaceId && accessError && (
          <div role="alert" className="mb-6 rounded-lg border border-amber-200/20 bg-amber-200/[0.04] px-6 py-4 text-sm text-amber-100">
            <p>Editing permissions are unavailable. Your files remain viewable; changes are disabled.</p>
            <button type="button" onClick={retryAssetAccess} className="mt-3 min-h-11 text-sm underline">Retry permission check</button>
          </div>
        )}
        {workspaceId && !accessError && assetAccess?.workspaceId !== workspaceId && (
          <p role="status" className="mb-6 text-sm text-[#999]">Checking edit permissions…</p>
        )}
        {workspaceId && !accessError && assetAccess?.workspaceId === workspaceId && !assetAccess.canEdit && (
          <p role="status" className="mb-6 rounded-lg border border-white/10 bg-white/[0.04] px-6 py-4 text-sm text-[#c5c5c5]">Read-only access: you can view assets, but cannot upload, generate, or change them.</p>
        )}

        {workspaceId && <ImageQuoteStudio key={`image-quote:${workspaceId}`} isWorkspaceCurrent={isWorkspaceCurrent} scope={scope} active={active && verified} workspaceId={workspaceId} books={books} assets={assets} canEdit={Boolean(canEdit)} onCompleted={load} />}
        {libraryLoading && <p role="status" className="mb-5 text-sm text-[#999]">Loading asset library…</p>}
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
              if (!editReady.current || scopeVersion.current !== permissionScope || activeWorkspace.current !== workspaceId) return;
              setFinalizingImage(job.id); setHistoryError(null);
              const version = scopeVersion.current;
              try { await mutateLibrary(() => api.finalizeImageJob(job.id)); if (version === scopeVersion.current) setHistoryRevision(value => value + 1); }
              catch (reason) { if (version === scopeVersion.current) setHistoryError(reason instanceof Error ? reason.message : "Image finalization is unavailable."); }
              finally { if (version === scopeVersion.current) setFinalizingImage(null); }
            }}>{finalizingImage === job.id ? "Finalizing…" : "Finalize saved image"}</button><p className="mt-1 text-xs text-[#999]">Uses the existing generated file, if available. Records the original image credit once; never starts another AI generation.</p></div>}
          </li>)}</ul>
        </section>
        <AssetBrowser
          key={`asset-browser:${workspaceId}`}
          folders={folders}
          assets={assets}
          active={active && verified}
          operationScope={revision}
          librarySnapshotRequest={librarySnapshotRequest}
          getLibraryRequest={() => libraryRequest.current}
          permissions={{ edit: canEdit, approve: canEdit, manage: canEdit }}
          onMove={async (assetId, folderId) => {
            await mutateLibrary(() => api.updateAsset(assetId, { folderId }));
          }}
          onOpen={(a) => void openAsset(a)}
          onUpload={upload}
          onNewFolder={async (parentId, name) => {
            await mutateLibrary(() => api.createFolder(workspaceId, { name, parentFolderId: parentId }));
          }}
          onSeedTemplate={async () => {
            await mutateLibrary(() => api.seedFolderTemplate(workspaceId));
          }}
          onDelete={async (assetId) => {
            await mutateLibrary(() => api.deleteAsset(assetId));
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
                onClick={closeAsset}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 text-xl text-[#9a9a9a] transition-colors hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                aria-label="Close asset details"
              >
                ×
              </button>
            </div>

            {detailLoading && <p role="status" className="mb-4 text-sm text-white/60">Loading file details…</p>}
            {detailError && <div role="alert" className="mb-4 rounded-xl border border-red-300/20 bg-red-300/10 p-4 text-sm text-red-100"><p>{detailError}</p><button type="button" onClick={() => void openAsset(open)} className="mt-2 min-h-11 underline">Retry file details</button></div>}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              <div>
                {previewUrl && open.mime_type.startsWith("image/") && (
                  <img src={previewUrl.url} alt={open.name} referrerPolicy="no-referrer" onError={() => { if (scopeVersion.current === permissionScope && detailRequest.current === renderedDetailRequest && activeAsset.current === open.id) { setPreviewUrl(null); setPreviewError("The private preview could not be loaded."); } }} className="mb-4 max-h-96 w-full rounded-xl border border-white/10 bg-white/5 object-contain" />
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
                {open.mime_type.startsWith("image/") && !previewUrl && <div className="mt-2 text-sm text-[#9a9a9a]"><p role="status">{previewError ?? "Preview unavailable."}</p>{!detailLoading && open.checksum !== "pending" && <button type="button" onClick={() => void openAsset(open)} className="mt-2 min-h-11 underline">Retry preview</button>}</div>}
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

            <section aria-label="Original file download" className="mb-6 rounded-xl border border-white/10 p-4">
              <h3 className="font-medium">Original file</h3>
              <p className="mt-2 text-sm text-white/55">Prepare a private link to the verified current version, then download when you are ready.</p>
              <button type="button" disabled={downloadBusy || !dataReady || open.checksum === "pending"} onClick={() => void prepareDownload(open)} className="mt-3 min-h-11 rounded-full border border-white/20 px-4 text-sm disabled:opacity-40">{downloadBusy ? "Preparing download…" : download ? "Prepare a new download link" : "Prepare download"}</button>
              {open.checksum === "pending" && <p role="status" className="mt-2 text-sm text-amber-100">This upload is awaiting verification. A download is available after the file passes checks.</p>}
              {downloadError && <p role="alert" className="mt-3 text-sm text-red-100">{downloadError}</p>}
              {download && download.assetId === open.id && <div role="status" className="mt-3"><button type="button" onClick={() => {
                const current = () => dataReady && scopeVersion.current === permissionScope && detailRequest.current === renderedDetailRequest
                  && downloadRequest.current === download.request && activeWorkspace.current === workspaceId && activeAsset.current === open.id;
                if (!current()) return;
                if (Date.now() >= download.expiresAt) { setDownload(null); setDownloadError("This link is no longer current. Prepare a new download link."); return; }
                void scope.checked(async () => {
                  if (!current() || Date.now() >= download.expiresAt) throw scopeChanged();
                  const { storageOrigin } = await readArtifactSession(scope.actor);
                  if (!current() || Date.now() >= download.expiresAt || storageOrigin !== download.storageOrigin || new URL(download.url).origin !== storageOrigin) throw scopeChanged();
                  const link = document.createElement("a"); link.href = download.url; link.download = download.filename; link.rel = "noopener noreferrer"; link.referrerPolicy = "no-referrer";
                  link.click();
                }).catch(() => { if (scope.current() && current()) { setDownload(null); setDownloadError("The download could not be verified. Prepare a new link to retry."); } });
              }} className="inline-flex min-h-11 items-center rounded-full bg-white px-4 text-sm font-medium text-black">Download original file · v{download.version}</button><p className="mt-2 text-xs text-white/50">This private link expires in a few minutes. Preparing it does not start a download.</p></div>}
            </section>

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
              <button onClick={closeAsset} className="w-full btn-primary">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </AuthorPage></div>{active && !verified && <main className="mx-auto max-w-6xl p-8 text-white">{verificationError ? <p role="alert">Workspace access could not be verified. <button className="underline" onClick={() => void retry()}>Try again</button></p> : <p role="status">Checking workspace access…</p>}</main>}</>
  );
}

export default function AssetsPage() {
  return (
    <Suspense>
      <ScopedAssetsPage />
    </Suspense>
  );
}
