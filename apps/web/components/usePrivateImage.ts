"use client";

import { useEffect, useRef, useState } from "react";
import { readArtifactSession } from "../lib/browser-session";
import { apiClient } from "./api";

function verifiedPreview(result: { url: string; expiresIn: number }, workspaceId: string, assetId: string, versionNumber: number | null, storageOrigin: string) {
  try {
    if (typeof result?.url !== "string" || result.url.length > 8192 || result.url !== result.url.trim() || !Number.isSafeInteger(result.expiresIn) || result.expiresIn < 1 || result.expiresIn > 300) throw Error();
    const url = new URL(result.url);
    const path = decodeURIComponent(url.pathname);
    const prefix = `/storage/v1/object/sign/book-assets/workspaces/${workspaceId}/assets/${assetId}/`;
    const rest = path.startsWith(prefix) ? path.slice(prefix.length) : "";
    const match = /^v([1-9]\d*)\/([a-zA-Z0-9._-]+)$/.exec(rest);
    if (url.origin !== storageOrigin || url.username || url.password || url.hash || !match
      || (versionNumber !== null && Number(match[1]) !== versionNumber)
      || url.searchParams.getAll("token").length !== 1 || !url.searchParams.get("token")
      || [...url.searchParams.keys()].some(key => key !== "token")) throw Error();
    return url.href;
  } catch { throw Error("The private artwork preview could not be verified."); }
}

export function usePrivateImage(assetId: string | null, versionNumber: number | null, workspaceId: string, actorId: string) {
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const key = assetId ? `${actorId}:${workspaceId}:${assetId}:${versionNumber ?? "current"}` : null;
  const [state, setState] = useState<{ key: string | null; url: string | null; error: string | null }>({ key: null, url: null, error: null });
  useEffect(() => {
    let cancelled = false;
    const sequence = ++generation.current;
    const current = () => !cancelled && sequence === generation.current;
    setState({ key, url: null, error: null });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (assetId && workspaceId && actorId) void (async () => {
      const started = Date.now();
      const { storageOrigin } = await readArtifactSession(actorId);
      if (!current()) return;
      const result = await apiClient(actorId).getAssetDownloadUrl(assetId, versionNumber ?? undefined);
      if (!current()) return;
      const verified = await readArtifactSession(actorId);
      if (!current()) return;
      if (verified.storageOrigin !== storageOrigin) throw Error("The private artwork preview could not be verified.");
      const url = verifiedPreview(result, workspaceId, assetId, versionNumber, storageOrigin);
      const remaining = started + result.expiresIn * 1000 - Date.now();
      if (remaining <= 0) throw Error("The private artwork preview expired.");
      if (current()) { setState({ key, url, error: null }); timer = setTimeout(() => { if (current()) setState({ key, url: null, error: "The private preview expired. Refresh to try again." }); }, remaining); }
    })().catch((reason) => { if (current()) setState({ key, url: null, error: reason instanceof Error ? reason.message : "Artwork preview unavailable." }); });
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [assetId, attempt, key, versionNumber, workspaceId, actorId]);
  useEffect(() => {
    const refresh = () => { generation.current++; setState({ key, url: null, error: null }); setAttempt(value => value + 1); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [key]);
  const renderedGeneration = generation.current;
  return {
    url: state.key === key ? state.url : null,
    error: state.key === key ? state.error : null,
    fail: () => { if (renderedGeneration === generation.current) setState(current => current.key === key && current.url === state.url ? { key, url: null, error: "The private preview expired or could not be loaded. Refresh to try again." } : current); },
    retry: () => setAttempt((value) => value + 1),
  };
}
