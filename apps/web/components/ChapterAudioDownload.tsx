"use client";

import { useState } from "react";

export default function ChapterAudioDownload({ projectId, ready }: { projectId: string; ready: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function download() {
    if (busy || !ready) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/backend/v1/audiobook-jobs/${projectId}/audio-download`, { credentials: "include", cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message ?? "Chapter assembly is unavailable. Your saved parts are unchanged.");
      }
      if (!response.headers.get("content-type")?.startsWith("audio/mpeg")) throw new Error("The assembly service did not return audio.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = `chapter-${projectId}.mp3`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not assemble this chapter."); }
    finally { setBusy(false); }
  }
  return <div className="mt-4 rounded-lg border border-white/10 p-3">
    <button type="button" onClick={() => void download()} disabled={!ready || busy} aria-busy={busy} className="rounded-full border border-white/20 px-4 py-2 text-sm text-white disabled:opacity-40">{busy ? "Assembling chapter…" : "Download assembled chapter"}</button>
    <p className="mt-2 text-xs leading-relaxed text-white/45">Joins completed parts in order into one 44.1 kHz mono, 192 kbps MP3. No new AI generation charge. Up to 100 MiB of source audio and two hours per chapter. Retailer mastering, loudness and pronunciation review are still required.</p>
    {error && <p role="alert" className="mt-2 text-sm text-red-200">{error}</p>}
  </div>;
}
