"use client";

import { useCallback, useEffect, useState } from "react";
import type { AudiobookQcReport } from "@bookworm/api-client";
import { apiClient } from "./api";

type AudioQc = {
  profile: string;
  chapterDurationSeconds: number;
  sampleRateHz: number;
  channels: number;
  bitRateKbps: number;
  bitRateMode: string;
  rmsDbfs: number;
  samplePeakDbfs: number;
  technicalChecks: Record<string, { status: "pass" | "attention" | "fail" | "manual_review"; limit: string }>;
  reviewRequired: boolean;
  acxNarrationPolicy: string;
};

function parseAudioQc(header: string | null): AudioQc | null {
  if (!header || header.length > 8192) return null;
  try {
    const value: unknown = JSON.parse(header);
    if (!value || typeof value !== "object") return null;
    const qc = value as Partial<AudioQc>;
    if (typeof qc.profile !== "string" || typeof qc.chapterDurationSeconds !== "number" || typeof qc.sampleRateHz !== "number"
      || typeof qc.channels !== "number" || typeof qc.bitRateKbps !== "number" || typeof qc.bitRateMode !== "string"
      || typeof qc.rmsDbfs !== "number" || typeof qc.samplePeakDbfs !== "number" || !qc.technicalChecks
      || typeof qc.reviewRequired !== "boolean" || qc.acxNarrationPolicy !== "explicit_authorization_required_for_ai_voice") return null;
    return qc as AudioQc;
  } catch { return null; }
}

function formatQc(quality: AudioQc) {
  return <>
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-medium">Audio technical preflight</h3><span className="text-xs text-amber-100">{quality.reviewRequired ? "Review required" : "Objective checks passed"}</span></div>
    <p className="mt-1 text-xs text-white/45">{Math.floor(quality.chapterDurationSeconds / 60)}m {Math.round(quality.chapterDurationSeconds % 60)}s · {quality.rmsDbfs.toFixed(1)} dB RMS · {quality.samplePeakDbfs.toFixed(1)} dB sample peak · {quality.sampleRateHz / 1000} kHz · {quality.channels === 1 ? "mono" : "stereo"} · {quality.bitRateKbps} kbps {quality.bitRateMode.toUpperCase()}</p>
    <ul className="mt-3 space-y-1 text-xs text-white/55">{Object.entries(quality.technicalChecks).map(([key, check]) => <li key={key} className="flex gap-2"><span aria-hidden="true" className={check.status === "pass" ? "text-emerald-200" : check.status === "manual_review" ? "text-amber-100" : "text-red-200"}>{check.status === "pass" ? "✓" : check.status === "manual_review" ? "•" : "!"}</span><span><span className="capitalize">{key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}</span>: {check.status === "manual_review" ? `manual review — ${check.limit}` : `${check.status} — ${check.limit}`}</span></li>)}</ul>
    <p className="mt-3 text-xs leading-relaxed text-amber-50/75">This is a technical preflight, not retailer approval. It cannot confirm room tone, background noise, pronunciation, edits, or spoken chapter headers. ACX requires explicit authorization for AI narration; this generated voice is not marked ACX-eligible.</p>
    <a href="https://help.acx.com/s/article/what-are-the-acx-audio-submission-requirements" target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs underline decoration-white/30 underline-offset-2">Review ACX’s current audio requirements</a>
  </>;
}

export default function ChapterAudioDownload({ projectId, ready }: { projectId: string; ready: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quality, setQuality] = useState<AudioQc | null>(null);
  const [qualityUnavailable, setQualityUnavailable] = useState(false);
  const [downloadedReportId, setDownloadedReportId] = useState<string | null>(null);
  const [listened, setListened] = useState(false);
  const [signoffBusy, setSignoffBusy] = useState(false);
  const [signoffError, setSignoffError] = useState<string | null>(null);
  const [signoffSaved, setSignoffSaved] = useState(false);
  const [reports, setReports] = useState<AudiobookQcReport[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const refreshHistory = useCallback(async () => {
    setHistoryBusy(true);
    try {
      const result = await apiClient().listAudiobookQcReports(projectId);
      setReports(result.reports);
      setHistoryError(null);
    } catch {
      setHistoryError("Saved QC history is not available yet. You can still download and review the current chapter.");
    } finally { setHistoryBusy(false); }
  }, [projectId]);

  useEffect(() => {
    if (ready) void refreshHistory();
  }, [ready, refreshHistory]);

  async function download() {
    if (busy || !ready) return;
    setBusy(true); setError(null); setQuality(null); setQualityUnavailable(false);
    setDownloadedReportId(null); setListened(false); setSignoffSaved(false); setSignoffError(null);
    try {
      const response = await fetch(`/api/backend/v1/audiobook-jobs/${projectId}/audio-download`, { credentials: "include", cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message ?? "Chapter assembly is unavailable. Your saved parts are unchanged.");
      }
      if (!response.headers.get("content-type")?.startsWith("audio/mpeg")) throw new Error("The assembly service did not return audio.");
      const report = parseAudioQc(response.headers.get("x-bookworm-audio-qc"));
      const reportId = response.headers.get("x-bookworm-audio-qc-report-id");
      const historyUnavailable = response.headers.get("x-bookworm-audio-qc-history") === "unavailable";
      setQuality(report); setQualityUnavailable(!report);
      setDownloadedReportId(reportId);
      if (historyUnavailable) setHistoryError("This report is shown for this download, but durable history is unavailable until the database migration is installed.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = `chapter-${projectId}.mp3`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (reportId && !historyUnavailable) await refreshHistory();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not assemble this chapter."); }
    finally { setBusy(false); }
  }

  async function signOff() {
    if (!downloadedReportId || !listened || signoffBusy) return;
    setSignoffBusy(true); setSignoffError(null);
    try {
      await apiClient().createAudiobookQcSignoff(projectId, downloadedReportId);
      setSignoffSaved(true); setListened(false);
      await refreshHistory();
    } catch (reason) { setSignoffError(reason instanceof Error ? reason.message : "Could not save the listening sign-off."); }
    finally { setSignoffBusy(false); }
  }

  const downloadedReport = reports.find((report) => report.id === downloadedReportId);
  return <div className="mt-4 rounded-lg border border-white/10 p-3">
    <button type="button" onClick={() => void download()} disabled={!ready || busy} aria-busy={busy} className="rounded-full border border-white/20 px-4 py-2 text-sm text-white disabled:opacity-40">{busy ? "Assembling & checking…" : "Download chapter + QC report"}</button>
    <p className="mt-2 text-xs leading-relaxed text-white/45">Joins completed parts in order into one 44.1 kHz mono, 192 kbps MP3 and measures the delivered file. No new AI generation charge. Up to 100 MiB of source audio and two hours per chapter.</p>
    {qualityUnavailable && <p role="status" className="mt-3 text-xs text-amber-100">Chapter assembled. The technical quality report is unavailable; review the audio manually before distribution.</p>}
    {historyError && <p role="status" className="mt-3 text-xs text-amber-100">{historyError}</p>}
    {quality && <section aria-live="polite" aria-label="Audiobook audio quality report" className="mt-4 rounded-xl border border-white/10 bg-black/25 p-4">
      {formatQc(quality)}
      {downloadedReportId && downloadedReport?.isCurrentSource && !downloadedReport.signedByMe && !signoffSaved && <div className="mt-4 rounded-xl border border-amber-200/20 bg-amber-200/[0.05] p-4">
        <label className="flex items-start gap-3 text-xs leading-relaxed text-white/70"><input type="checkbox" checked={listened} onChange={(event) => setListened(event.target.checked)} className="mt-0.5" /><span>I listened through this exact downloaded chapter and reviewed its narration, edits, room tone, and pronunciation.</span></label>
        <button type="button" onClick={() => void signOff()} disabled={!listened || signoffBusy} className="mt-3 rounded-full bg-white px-4 py-2 text-xs font-semibold text-black disabled:opacity-40">{signoffBusy ? "Saving review…" : "Save listening sign-off"}</button>
        <p className="mt-2 text-[11px] text-white/40">Available to workspace editors and reviewers. This records your attestation; it does not certify retailer compliance.</p>
      </div>}
      {(downloadedReport?.signedByMe || signoffSaved) && <p role="status" className="mt-4 rounded-lg border border-emerald-200/15 bg-emerald-200/[0.05] px-3 py-2 text-xs text-emerald-100">Listening sign-off saved for this exact audio file.</p>}
      {signoffError && <p role="alert" className="mt-3 text-xs text-red-200">{signoffError}</p>}
      {downloadedReportId && !downloadedReport?.isCurrentSource && reports.some((report) => report.id === downloadedReportId) && <p role="status" className="mt-4 text-xs text-amber-100">This report belongs to an older manuscript version. Reassemble the current narration before signing it off.</p>}
    </section>}
    {(historyBusy || reports.length > 0) && <section aria-label="Saved audiobook quality history" className="mt-4 rounded-xl border border-white/10 p-4">
      <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Saved QC history</h3><button type="button" onClick={() => void refreshHistory()} disabled={historyBusy} className="text-xs text-white/60 underline disabled:opacity-40">{historyBusy ? "Refreshing…" : "Refresh"}</button></div>
      {reports.length > 0 ? <ul className="mt-3 space-y-2">{reports.map((report) => <li key={report.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white/[0.03] px-3 py-2 text-xs">
        <span className="text-white/65">{new Date(report.createdAt).toLocaleString()} · {typeof report.qualityReport.rmsDbfs === "number" ? `${report.qualityReport.rmsDbfs.toFixed(1)} dB RMS` : "measured QC"} · {report.isCurrentSource ? "current manuscript version" : "older manuscript version"}</span>
        <span className="text-white/45">{report.signoffs.length} sign-off{report.signoffs.length === 1 ? "" : "s"}{report.signedByMe ? " · signed by you" : ""}</span>
      </li>)}</ul> : !historyBusy && <p className="mt-3 text-xs text-white/40">No saved quality reports yet. Download the assembled chapter to measure it.</p>}
    </section>}
    {error && <p role="alert" className="mt-2 text-sm text-red-200">{error}</p>}
  </div>;
}
