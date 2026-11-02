"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState } from "react";
import type { AudiobookGooglePlayExportJob, PrivateAudiobookProjectResult, AudiobookVoice, PreflightResult, PublishingPackageJob, RenderedEditionResult, RetailerChannel } from "@bookworm/api-client";
import type { Asset, Book, Chapter, Edition } from "@bookworm/types";
import { apiClient } from "./api";
import ChapterAudioDownload from "./ChapterAudioDownload";
import NarrationQuoteStudio from "./NarrationQuoteStudio";
import SavedEpubReader from "./SavedEpubReader";
import SavedPrintLibrary from "./SavedPrintLibrary";
import SavedPdfProof from "./SavedPdfProof";
import PrivateArtifactDownload from "./PrivateArtifactDownload";
import PrivateCoverPreview from "./PrivateCoverPreview";
import { renderLinksDeadline } from "../lib/pdf-proof";
import RetailerPackageRequest from "./RetailerPackageRequest";
import { readBrowserSession } from "../lib/browser-session";
import { packageDownloadDeadline, signedDownloadDeadline, downloadClock, downloadExpired, nextDownloadClockWait, type DownloadClock } from "../lib/publishing-request";

import { FONTS, fontLabel, DEFAULT_FORM, LAYOUT_PRESET_LABELS, isLayoutPresetId, applyLayoutPreset, resolveEditionRenderSafety, formFromEdition, toConfig, matchesCreatedEditionConfig, type FormState, type Kind, type LayoutPresetId } from "../lib/publishing-edition-form";
export { applyLayoutPreset, resolveEditionTextDirection, formFromEdition, toConfig } from "../lib/publishing-edition-form";

const EDIT_ROLES = new Set(["owner", "admin", "editor", "writer", "illustrator", "designer"]);
type Channel = PreflightResult["requestedChannel"];
type TimedPackageJob = PublishingPackageJob & { downloadExpiresAt: DownloadClock | null };
type TimedAudioExport = AudiobookGooglePlayExportJob & { downloadExpiresAt: DownloadClock | null };
const timeAudio = (job: AudiobookGooglePlayExportJob, startedAt: DownloadClock): TimedAudioExport => ({ ...job, downloadExpiresAt: job.downloadUrl && job.downloadExpiresIn ? signedDownloadDeadline({ url: job.downloadUrl, expiresIn: job.downloadExpiresIn }, startedAt) : null });
const timePackage = (job: PublishingPackageJob, startedAt: DownloadClock): TimedPackageJob => ({ ...job, downloadExpiresAt: packageDownloadDeadline(job, startedAt) });
const CHANNEL_FORMATS: Record<RetailerChannel, Kind[]> = { kdp: ["ebook", "print"], apple: ["ebook"], barnesnoble: ["ebook", "print"], lulu: ["print"], googleplay: ["ebook"] };
const CHANNEL_ENTITLEMENTS: Record<RetailerChannel, string> = { kdp: "kdp", apple: "apple_books", barnesnoble: "barnes_noble", lulu: "lulu", googleplay: "google_play" };
const artifactUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function renderedStoragePath(workspace: string | undefined, artifact: RenderedEditionResult["artifacts"][number]) {
  if (!workspace || !artifactUuid.test(workspace) || !artifactUuid.test(artifact.asset.id) || artifact.asset.workspace_id !== workspace) return "";
  const file = artifact.role === "rendered_print" && artifact.asset.mime_type === "application/pdf" ? "book.pdf"
    : artifact.role === "rendered_ebook" && artifact.asset.mime_type === "application/epub+zip" ? "book.epub"
    : artifact.role === "rendered_cover" && artifact.asset.mime_type === "application/pdf" ? "cover.pdf"
    : artifact.role === "rendered_cover" && artifact.asset.mime_type === "image/png" ? "cover.png" : "";
  const expected = `workspaces/${workspace}/assets/${artifact.asset.id}/v1/${file}`;
  return file && artifact.asset.storage_path === expected ? expected : "";
}
function packageStoragePath(workspace: string | undefined, job: PublishingPackageJob) {
  if (!workspace || !artifactUuid.test(workspace) || !job.package || !artifactUuid.test(job.package.asset.id)
    || job.package.asset.workspace_id !== workspace || !Object.prototype.hasOwnProperty.call(CHANNEL_FORMATS, job.channel)) return "";
  const expected = `workspaces/${workspace}/assets/${job.package.asset.id}/v1/${job.channel}-export.zip`;
  return job.package.asset.storage_path === expected ? expected : "";
}
function archiveFilename(url: string) {
  try { return new URL(url).searchParams.get("download") || "googleplay-audiobook.zip"; }
  catch { return "googleplay-audiobook.zip"; }
}
function audioArchivePath(workspace: string | undefined, jobId: string): string | RegExp {
  if (!workspace || !artifactUuid.test(workspace) || !artifactUuid.test(jobId)) return "";
  return new RegExp(`^workspaces/${workspace}/audiobook-exports/${jobId}/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.zip$`, "i");
}

const fieldClass = "mt-2 block w-full rounded-xl border border-white/10 bg-black/60 px-3 py-2.5 text-white outline-none focus:border-white/35";
const cardClass = "rounded-2xl border border-white/10 bg-white/[0.035] p-5";

type EditionRisk = { current: Map<string, { actor: string }> };
type PublishingScope = { actor: string; current: () => boolean; begin: () => () => boolean; checked: <T>(work: () => Promise<T>) => Promise<T> };
function superseded() { const e = new Error("Account check superseded."); e.name = "PublishingScopeChanged"; return e; }
export default function PublishingStudio({ bookId }: { bookId: string }) {
  const latestBook = useRef(bookId); latestBook.current = bookId;
  const editionRisks = useRef(new Map<string, { actor: string }>());
  const isBookCurrent = useCallback(() => latestBook.current === bookId, [bookId]);
  return <ScopedPublishingStudio key={bookId} bookId={bookId} isBookCurrent={isBookCurrent} editionRisks={editionRisks} />;
}
function ScopedPublishingStudio({ bookId, isBookCurrent, editionRisks }: { bookId: string; isBookCurrent: () => boolean; editionRisks: EditionRisk }) {
  type Entry = { actor: string; scope: PublishingScope; access: {book:Book;role:string} };
  const [entries, setEntries] = useState<Entry[]>([]), [identity,setIdentity] = useState<Entry|null>(null);
  const [active,setActive]=useState(false), [checking,setChecking]=useState(true), [error,setError]=useState("");
  const epoch=useRef<object>({}), identityRef=useRef<Entry|null>(null), activeRef=useRef(false), mounted=useRef(false);
  const scopes = useRef(new Map<string, PublishingScope>()), checkRef=useRef<() => Promise<void>>(async () => {});
  const check=useCallback(async()=>{
    if(!mounted.current)return;
    const token={}; epoch.current=token;activeRef.current=false;setActive(false);setChecking(true);setError("");
    try {
      const user=await readBrowserSession();if(!mounted.current||epoch.current!==token)return;
      const record=await apiClient().getBook(bookId,user.id);if(!mounted.current||epoch.current!==token)return;
      if(!record.book||record.book.id!==bookId)throw new Error("Book access could not be confirmed.");
      await readBrowserSession(user.id);if(!mounted.current||epoch.current!==token)return;
      let scoped = scopes.current.get(user.id);
      if (!scoped) {
        const actor = user.id;
        const current=()=>mounted.current&&isBookCurrent()&&activeRef.current&&identityRef.current?.actor===actor;
        const begin=()=>{const generation=epoch.current;return()=>current()&&epoch.current===generation;};
        const checked=async<T,>(work:()=>Promise<T>):Promise<T>=>{const valid=begin();try{
          await readBrowserSession(actor);if(!valid())throw superseded();const result=await work();if(!valid())throw superseded();
          await readBrowserSession(actor);if(!valid())throw superseded();return result;
        }catch(reason){if(!valid())throw superseded();try{await readBrowserSession(actor);}catch{if(valid())void checkRef.current();}if(!valid())throw superseded();throw reason;}};
        scoped={actor,current,begin,checked}; scopes.current.set(actor,scoped);
      }
      const next:Entry={actor:user.id,scope:scoped,access:record};identityRef.current=next;
      setEntries(current=>[...current.filter(entry=>entry.actor!==user.id),next]);setIdentity(next);activeRef.current=true;setActive(true);
    } catch {if(mounted.current&&epoch.current===token)setError("Book access or your account could not be verified. Sign in again or retry.");}
    finally {if(mounted.current&&epoch.current===token)setChecking(false);}
  },[bookId,isBookCurrent]);
  checkRef.current=check;
  useLayoutEffect(()=>{
    mounted.current=true;void check();const focus=()=>{void check();};
    const visibility=()=>{if(document.visibilityState==="visible")void check();else{epoch.current={};activeRef.current=false;setActive(false);setChecking(true);setError("");}};
    window.addEventListener("focus",focus);document.addEventListener("visibilitychange",visibility);
    return()=>{mounted.current=false;epoch.current={};activeRef.current=false;window.removeEventListener("focus",focus);document.removeEventListener("visibilitychange",visibility);};
  },[check]);
  return <>
    {entries.map(entry => <PublishingWorkspace key={entry.actor} bookId={bookId} scope={entry.scope}
      active={active && identity?.actor===entry.actor} verifiedAccess={entry.access} editionRisks={editionRisks} />)}
    {!active&&<section className="mx-auto max-w-7xl px-4 py-8 text-white"><h1 className="text-2xl">Publishing studio</h1>{checking?<p role="status">Checking your account…</p>:<p role="alert">{error} <button className="underline" onClick={()=>void check()}>Try again</button> <Link className="underline" href="/login">Sign in</Link></p>}</section>}
  </>;
}
function PublishingWorkspace({ bookId, scope, active, verifiedAccess, editionRisks }: { bookId:string;scope:PublishingScope;active:boolean;verifiedAccess:{book:Book;role:string};editionRisks:EditionRisk }) {
  const api = useMemo(() => {
    const scoped = apiClient(scope.actor);
    return new Proxy(scoped, { get(target, key, receiver) {
      const member = Reflect.get(target, key, receiver);
      return typeof member === "function" ? (...args: unknown[]) => scope.checked(() => member(...args)) : member;
    } });
  }, [scope]);
  const committedRender = useRef<object | null>(null), mountedView = useRef(false);
  const renderedAt = {}, renderedScope = scope.begin();
  useLayoutEffect(() => { committedRender.current = renderedAt; });
  useLayoutEffect(() => { mountedView.current = true; return () => { mountedView.current = false; committedRender.current = null; }; }, []);
  const handlerCurrent = () => mountedView.current && committedRender.current === renderedAt && active && renderedScope();
  const [book, setBook] = useState<Book | null>(null);
  const [planRevision, setPlanRevision] = useState(0);
  const [planAccess, setPlanAccess] = useState<{ status: "loading" | "unavailable" | "ready"; workspace: string; valid: () => boolean; rendering?: boolean; channels?: string[] }>({ status: "loading", workspace: "", valid: () => false });
  const [role, setRole] = useState("viewer");
  const [editions, setEditions] = useState<Edition[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [narrationChapterId, setNarrationChapterId] = useState("");
  const [audiobookProjects, setAudiobookProjects] = useState<PrivateAudiobookProjectResult[]>([]);
  const [googlePlayExports, setGooglePlayExports] = useState<TimedAudioExport[]>([]);
  const audioExportsRef = useRef(googlePlayExports); audioExportsRef.current = googlePlayExports;
  const exportRequestKey = useRef<string | null>(null);
  const [googlePlayIdentifier, setGooglePlayIdentifier] = useState("");
  const [googlePlayCoverId, setGooglePlayCoverId] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"load" | "save" | "render" | "preflight" | "package" | "history" | "audiobook" | null>("load");
  const [channel, setChannel] = useState<Channel>("export");
  const [rendered, setRendered] = useState<(RenderedEditionResult & { expiresAt?: number }) | null>(null);
  const renderedRef = useRef(rendered); renderedRef.current = rendered;
  const [readerRefreshKey, setReaderRefreshKey] = useState("");
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [publishingJobs, setPublishingJobs] = useState<TimedPackageJob[]>([]);
  const publishingJobsRef = useRef(publishingJobs); publishingJobsRef.current = publishingJobs;
  const [packageHistory, setPackageHistory] = useState<{ editionId: string | null; status: "loading" | "ready" | "unavailable" }>({ editionId: null, status: "loading" });
  const packageHistoryEpoch = useRef(0);
  const [packageClock, setPackageClock] = useState(downloadClock());
  const [packageClockFault, setPackageClockFault] = useState(false);
  const observedClock = useRef(packageClock), clockFault = useRef(false);
  const observePackageClock = () => {
    const now = downloadClock();
    if (now.wall < observedClock.current.wall || now.monotonic < observedClock.current.monotonic) { clockFault.current = true; setPackageClockFault(true); }
    observedClock.current = now; setPackageClock(now); return now;
  };
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const uncertainEditionCreates = editionRisks;
  const editionRiskKey = `${scope.actor}:${bookId}`;
  const [, setEditionGuardVersion] = useState(0);
  const [acceptDuplicateRisk, setAcceptDuplicateRisk] = useState(false);
  const [verifyingEditionRisk, setVerifyingEditionRisk] = useState(false);
  const editionRiskFlight = useRef<object | null>(null), editionSaveFlight = useRef<object | null>(null);
  const loadedEditionOwner = useRef<string | null>(null);
  const [editionSessionHidden, setEditionSessionHidden] = useState(false);
  const [verifyingEditionSession, setVerifyingEditionSession] = useState(false);
  const currentBook = useRef(bookId); currentBook.current = bookId;
  const currentEdition = useRef(activeId); currentEdition.current = activeId;
  const viewEpoch = useRef(0);
  const audioHistoryEpoch = useRef(0), audioProjectEpoch = useRef(0);
  const audioMutation = useRef<object | null>(null), audioManualRead = useRef<object | null>(null);
  const adoptPrint = useCallback((result: RenderedEditionResult, expiresAt: number) => { setRendered({ ...result, expiresAt }); setPreflight(null); setNotice("Saved print proof opened. Run fresh preflight before creating a package."); }, []);
  const invalidatePrint = useCallback((jobId: string) => { setRendered(current => current?.jobId === jobId ? null : current); setPreflight(null); }, []);

  const activeEdition = editions.find((edition) => edition.id === activeId) ?? null;
  const currentIdentity = active && scope.current() && book?.id === bookId;
  const linkEpoch = viewEpoch.current;
  const linkOwner = loadedEditionOwner.current;
  const linkScope = scope.begin();
  const editable = currentIdentity && EDIT_ROLES.has(role);
  useEffect(() => {
    if (!active || !book?.workspace_id || !scope.current()) return;
    const workspace = book.workspace_id, current = scope.begin();
    let cancelled = false;
    const valid = () => !cancelled && current();
    setPlanAccess({ status: "loading", workspace, valid });
    void (async () => {
      try {
        const result = await api.getDashboardOverview(workspace, scope.actor);
        if (!valid()) return;
        const entitlements = result?.usage?.entitlements?.entitlements;
        if (result?.viewerId !== scope.actor || result?.workspace?.id !== workspace || typeof entitlements?.rendering !== "boolean"
          || !Array.isArray(entitlements.publishing_channels) || entitlements.publishing_channels.length > 100
          || entitlements.publishing_channels.some(item => typeof item !== "string" || item.length > 100)) throw new Error("Plan access could not be verified.");
        setPlanAccess({ status: "ready", workspace, valid, rendering: entitlements.rendering, channels: [...entitlements.publishing_channels] });
      } catch { if (valid()) setPlanAccess({ status: "unavailable", workspace, valid }); }
    })();
    return () => { cancelled = true; };
  }, [active, api, book?.workspace_id, planRevision, scope]);
  const planStatus = active && planAccess.workspace === book?.workspace_id && planAccess.valid() ? planAccess : null;
  // Navigation invalidates replies, not durable work already accepted by the server.
  const captureView = () => {
    const version = viewEpoch.current, ownerCurrent = scope.begin();
    const initiated = handlerCurrent();
    return () => initiated && currentIdentity && ownerCurrent() && currentBook.current === bookId && viewEpoch.current === version;
  };
  const audioScope = (editionId: string) => {
    const epoch = viewEpoch.current, ownerCurrent = scope.begin();
    return () => ownerCurrent() && currentBook.current === bookId && currentEdition.current === editionId && viewEpoch.current === epoch;
  };
  const readPackageHistory = useCallback(async (editionId: string, owner: string) => {
    const ticket = ++packageHistoryEpoch.current, view = viewEpoch.current, startedAt = downloadClock();
    const valid = () => currentBook.current === bookId && currentEdition.current === editionId
      && viewEpoch.current === view && loadedEditionOwner.current === owner && packageHistoryEpoch.current === ticket;
    setPackageHistory({ editionId, status: "loading" });
    try {
      await readBrowserSession(owner);
      const result = await api.listPublishingJobs(bookId, { editionId }, owner);
      await readBrowserSession(owner);
      if (!Array.isArray(result?.jobs) || result.jobs.some(job => !job || job.editionId !== editionId || (job.bookId !== undefined && job.bookId !== bookId))) {
        throw new Error("The package history could not be verified for this edition.");
      }
      if (valid()) { setPublishingJobs(result.jobs.map(job => timePackage(job, startedAt))); setPackageHistory({ editionId, status: "ready" }); observePackageClock(); }
    } catch {
      if (valid()) setPackageHistory({ editionId, status: "unavailable" });
    }
  }, [api, bookId]);
  const readAudioHistory = async (editionId: string, reportError: boolean, alive: () => boolean = () => true) => {
    if (audioMutation.current || (!reportError && audioManualRead.current)) return;
    const manual = reportError ? {} : null; if (manual) audioManualRead.current = manual;
    const scoped = audioScope(editionId), ticket = ++audioHistoryEpoch.current, startedAt = downloadClock();
    const valid = () => scoped() && alive() && audioHistoryEpoch.current === ticket && !audioMutation.current;
    try {
      const result = await scope.checked(() => api.listAudiobookGooglePlayExports(editionId, scope.actor));
      if (!Array.isArray(result.jobs) || result.jobs.some(job => !job || job.editionId !== editionId)) throw new Error("Audiobook export history did not match the edition.");
      if (valid()) { setGooglePlayExports(result.jobs.map(job => timeAudio(job, startedAt))); observePackageClock(); }
    } catch (reason) { if (valid()) { setGooglePlayExports([]); if (reportError) setError(reason instanceof Error ? reason.message : "Could not refresh export history."); } }
    finally { if (manual && audioManualRead.current === manual) audioManualRead.current = null; }
  };
  const readAudioProjects = async (editionId: string, reportError: boolean) => {
    const scoped = audioScope(editionId), ticket = ++audioProjectEpoch.current;
    const valid = () => scoped() && audioProjectEpoch.current === ticket;
    try {
      const result = await scope.checked(() => api.listPrivateAudiobookProjects(editionId, scope.actor));
      if (!Array.isArray(result.projects) || result.projects.some(project => !project || project.editionId !== editionId
        || !Array.isArray(project.segments) || project.segments.some(segment => !segment || typeof segment.audioAvailable !== "boolean"
          || Object.prototype.hasOwnProperty.call(segment, "download") || !Number.isInteger(segment.index) || segment.index < 0 || segment.index >= 250))) {
        throw new Error("Audiobook history is unavailable. Update the workspace service before opening audio.");
      }
      if (valid()) setAudiobookProjects(result.projects);
    } catch (reason) { if (valid()) { setAudiobookProjects([]); if (reportError) setError(reason instanceof Error ? reason.message : "Could not load audiobook history."); } }
  };
  const beginAudioMutation = () => {
    if (audioMutation.current) return null;
    const token = {}; audioMutation.current = token; audioManualRead.current = null; audioHistoryEpoch.current++; return token;
  };
  const finishAudioMutation = (token: object, editionId: string, valid: () => boolean) => {
    if (audioMutation.current !== token) return;
    audioMutation.current = null; audioHistoryEpoch.current++;
    if (valid()) void readAudioHistory(editionId, false);
  };
  const coverAssets = useMemo(() => assets.filter((asset) => asset.mime_type.startsWith("image/") && asset.checksum !== "pending" && !asset.deleted_at), [assets]);
  const activePublishingJobs = useMemo(() => publishingJobs.filter((job) => !activeId || job.editionId === activeId), [publishingJobs, activeId]);
  const channelCompatible = form.kind !== "audiobook" && (channel === "export" || CHANNEL_FORMATS[channel].includes(form.kind));
  const { paginated, rtlPrintUnsupported, rtlCoverTextUnsupported, renderBlocked } = resolveEditionRenderSafety(form, book, activeEdition?.edition_metadata_json);

  const load = useCallback(async () => {
    const version = ++viewEpoch.current, ownerCurrent = scope.begin();
    audioHistoryEpoch.current++; audioProjectEpoch.current++; packageHistoryEpoch.current++; audioMutation.current = null; audioManualRead.current = null;
    const valid = () => ownerCurrent() && viewEpoch.current === version && currentBook.current === bookId;
    editionRiskFlight.current = null; editionSaveFlight.current = null; loadedEditionOwner.current = null; setEditionSessionHidden(false); setVerifyingEditionSession(false); setVerifyingEditionRisk(false); setAcceptDuplicateRisk(false);
    setBusy("load");
    setBook(null); setRole("viewer"); setEditions([]); setAssets([]); setChapters([]); setPublishingJobs([]);
    currentEdition.current = null; setActiveId(null); setForm(DEFAULT_FORM); setDirty(false); setError(null);
    setAudiobookProjects([]); setGooglePlayExports([]); setNarrationChapterId("");
    setRendered(null); setPreflight(null); setNotice(null); exportRequestKey.current = null;
    setGooglePlayIdentifier(""); setGooglePlayCoverId("");
    try {
      const owner = scope.actor; await readBrowserSession(owner); if (!valid()) return;
      const [identity, editionResult, chapterResult] = await Promise.all([api.getBook(bookId, owner), api.listEditions(bookId, owner), api.listChapters(bookId, owner)]);
      if (!valid()) return;
      if (!identity?.book || identity.book.id !== bookId || !Array.isArray(editionResult?.editions)
        || editionResult.editions.some(edition => !edition || edition.book_id !== bookId)) {
        throw new Error("The saved edition list did not match this book. Reload before editing.");
      }
      const assetResult = await api.listAssets(identity.book.workspace_id, undefined, owner);
      await readBrowserSession(owner);
      if (!valid()) return;
      loadedEditionOwner.current = owner;
      setBook(identity.book); setRole(identity.role); setEditions(editionResult.editions); setAssets(assetResult.assets); setChapters(chapterResult.chapters);
      setNarrationChapterId(chapterResult.chapters[0]?.id ?? "");
      if (editionResult.editions[0]) {
        currentEdition.current = editionResult.editions[0].id;
        setActiveId(editionResult.editions[0].id); setForm(formFromEdition(editionResult.editions[0], identity.book.language));
        if (editionResult.editions[0].type === "audiobook") {
          await Promise.all([readAudioProjects(editionResult.editions[0].id, true), readAudioHistory(editionResult.editions[0].id, true)]);
          if (!valid()) return;
        } else { setAudiobookProjects([]); setGooglePlayExports([]); }
      }
      else { currentEdition.current = null; setActiveId(null); setForm({ ...DEFAULT_FORM, language: identity.book.language }); setGooglePlayExports([]); }
      setDirty(false);
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Could not load publishing settings."); }
    finally { if (valid()) setBusy(null); }
  }, [api, bookId, scope]);

  useLayoutEffect(() => {
    const invalidate = () => { ++viewEpoch.current; audioHistoryEpoch.current++; audioProjectEpoch.current++; setAudiobookProjects([]); setGooglePlayExports([]); setPublishingJobs([]); setRendered(null); setPreflight(null); setNotice(null); };
    window.addEventListener("focus", invalidate); document.addEventListener("visibilitychange", invalidate);
    return () => { window.removeEventListener("focus", invalidate); document.removeEventListener("visibilitychange", invalidate); };
  }, []);
  useLayoutEffect(() => {
    if (!active) {
      // An old in-flight operation may still complete; its actor/book checkpoint
      // remains in editionRisks, but its obsolete UI lock cannot block this view.
      editionSaveFlight.current = null; editionRiskFlight.current = null;
      setBusy(null); setVerifyingEditionRisk(false); setVerifyingEditionSession(false); setAcceptDuplicateRisk(false);
    }
  }, [active]);
  useLayoutEffect(() => { if (active && loadedEditionOwner.current === scope.actor) { setBook(verifiedAccess.book); setRole(verifiedAccess.role); } }, [active, verifiedAccess, scope]);
  const firstActive = useRef(true);
  useEffect(() => {
    if (!active) return;
    if (firstActive.current) { firstActive.current = false; return; }
    if (!loadedEditionOwner.current) { void load(); return; }
    if (loadedEditionOwner.current === scope.actor && activeId && form.kind === "audiobook") void Promise.all([readAudioProjects(activeId, true), readAudioHistory(activeId, true)]);
  }, [active, verifiedAccess]);
  useEffect(() => { void load(); return () => { ++viewEpoch.current; }; }, [load]);
  useEffect(() => {
    const owner = loadedEditionOwner.current;
    if (!activeId || !owner) { packageHistoryEpoch.current++; setPackageHistory({ editionId: activeId, status: "loading" }); return; }
    setPublishingJobs([]);
    void readPackageHistory(activeId, owner);
    return () => { packageHistoryEpoch.current++; };
  }, [activeId, bookId, readPackageHistory]);
  useEffect(() => {
    if (!rendered?.expiresAt) return;
    const jobId = rendered.jobId;
    const timer = window.setTimeout(() => { invalidatePrint(jobId); setNotice("Private proof links expired. Open the saved proof again to renew them; no new render is needed."); }, Math.max(0, rendered.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [rendered, invalidatePrint]);
  useEffect(() => {
    const update = () => { observePackageClock(); };
    const now = downloadClock();
    const wait = nextDownloadClockWait([...publishingJobs, ...googlePlayExports].map(job => job.downloadExpiresAt), packageClock, now);
    const timer = wait !== null && !clockFault.current ? window.setTimeout(update, wait) : undefined;
    window.addEventListener("focus", update); document.addEventListener("visibilitychange", update);
    return () => { if (timer !== undefined) window.clearTimeout(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, [publishingJobs, googlePlayExports, packageClock]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const hasActiveGooglePlayExport = googlePlayExports.some((job) => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!activeId || form.kind !== "audiobook" || !hasActiveGooglePlayExport) return;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || audioMutation.current) return;
      pending = true;
      try { await readAudioHistory(activeId, false, () => active); } finally { pending = false; }
    };
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [bookId, activeId, api, form.kind, hasActiveGooglePlayExport]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    if (!handlerCurrent() || !editable || busy) return;
    setForm((current) => ({ ...current, [key]: value })); setDirty(true); setRendered(null); setPreflight(null); setNotice(null);
  };

  const selectEdition = (edition: Edition) => {
    if (!handlerCurrent() || busy) return;
    if (dirty && !window.confirm("Discard unsaved edition settings?")) return;
    const version = ++viewEpoch.current;
    audioManualRead.current = null;
    currentEdition.current = edition.id;
    const valid = () => version === viewEpoch.current && currentBook.current === bookId && currentEdition.current === edition.id;
    exportRequestKey.current = null;
    setGooglePlayIdentifier(""); setGooglePlayCoverId(""); setNotice(null);
    setActiveId(edition.id); setForm(formFromEdition(edition, book?.language)); setDirty(false); setRendered(null); setPreflight(null); setError(null);
    setAudiobookProjects([]); setGooglePlayExports([]);
    if (edition.type === "audiobook") void Promise.all([readAudioProjects(edition.id, true), readAudioHistory(edition.id, true)]);
    else { setAudiobookProjects([]); setGooglePlayExports([]); }
  };

  const newEdition = (kind: Kind) => {
    if (!handlerCurrent() || !editable || busy) return;
    if (dirty && !window.confirm("Discard unsaved edition settings?")) return;
    ++viewEpoch.current; audioManualRead.current = null; currentEdition.current = null;
    exportRequestKey.current = null;
    setGooglePlayIdentifier(""); setGooglePlayCoverId(""); setNotice(null);
    setActiveId(null); setForm({ ...DEFAULT_FORM, kind, language: book?.language ?? "en" }); setDirty(true); setRendered(null); setPreflight(null); setError(null); setAudiobookProjects([]); setGooglePlayExports([]);
  };

  const verifyEditionOwner = async (owner: string, valid: () => boolean) => {
    try { await readBrowserSession(owner); }
    catch (reason) { if (valid() && loadedEditionOwner.current === owner) setEditionSessionHidden(true); throw reason; }
  };
  const restoreEditionSession = async () => {
    const owner = loadedEditionOwner.current, valid = captureView();
    if (!owner || !valid() || verifyingEditionSession) return;
    setVerifyingEditionSession(true);
    try { await readBrowserSession(owner); if (valid() && loadedEditionOwner.current === owner) { setEditionSessionHidden(false); setError(null); } }
    catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Your account could not be verified."); }
    finally { if (valid()) setVerifyingEditionSession(false); }
  };

  const acknowledgeEditionRisk = async () => {
    if (!acceptDuplicateRisk || verifyingEditionRisk || busy || editionRiskFlight.current) return;
    const pending = uncertainEditionCreates.current.get(editionRiskKey), valid = captureView();
    if (!pending || !valid()) return;
    if (loadedEditionOwner.current !== pending.actor) {
      setError("This warning belongs to a different account. Leaving or reloading this page removes the warning, but the earlier request could still finish.");
      return;
    }
    const flight = {}; editionRiskFlight.current = flight; setVerifyingEditionRisk(true);
    try {
      await verifyEditionOwner(pending.actor, valid);
      if (!valid() || loadedEditionOwner.current !== pending.actor || editionRiskFlight.current !== flight || uncertainEditionCreates.current.get(editionRiskKey) !== pending) return;
      uncertainEditionCreates.current.delete(editionRiskKey); setEditionGuardVersion(v => v + 1); setAcceptDuplicateRisk(false);
      setError(null); setNotice("Another new edition can be saved. The earlier request may still finish.");
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Your account could not be verified."); }
    finally { if (editionRiskFlight.current === flight) { editionRiskFlight.current = null; if (valid()) setVerifyingEditionRisk(false); } }
  };

  const matchesEditionReply = (saved: Edition, config: ReturnType<typeof toConfig>, language: string, expectedId?: string) => {
    const savedConfig = saved?.edition_metadata_json;
    return Boolean(saved && saved.book_id === bookId && saved.type === config.kind && typeof saved.id === "string"
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(saved.id)
      && (!expectedId || saved.id === expectedId)
      && savedConfig && typeof savedConfig === "object" && !Array.isArray(savedConfig) && matchesCreatedEditionConfig(config, savedConfig)
      && typeof saved.language === "string" && saved.language === language.trim()
      && typeof saved.updated_at === "string" && Number.isFinite(Date.parse(saved.updated_at)));
  };

  const save = async () => {
    if (!handlerCurrent() || !editable || busy || editionSaveFlight.current || (!activeId && uncertainEditionCreates.current.has(editionRiskKey))) return;
    if (activeId && !activeEdition) { setError("This edition is no longer in the saved list. Reload before saving."); return; }
    const valid = captureView(); if (!valid()) return;
    const flight = {}; editionSaveFlight.current = flight;
    setBusy("save"); setError(null); setNotice(null);
    let creating = false;
    let submitted = false;
    let owner: string | null = null;
    try {
      let saved: Edition;
      owner = loadedEditionOwner.current; if (!owner) throw new Error("Verify the original account before saving this edition.");
      await verifyEditionOwner(owner, valid); if (!valid()) return;
      if (activeEdition) {
        const config = toConfig(form, activeEdition.edition_metadata_json);
        submitted = true;
        saved = await api.updateEdition(activeEdition.id, { config, language: form.language, expectedUpdatedAt: activeEdition.updated_at }, owner);
        await verifyEditionOwner(owner, valid);
        if (!matchesEditionReply(saved, config, form.language, activeEdition.id)) throw new Error("The edition update reply could not be verified.");
      } else {
        const config = toConfig(form);
        // The endpoint has no durable request identity. Once dispatched, a failure
        // cannot distinguish a rejected request from a lost success response.
        creating = true; submitted = true; uncertainEditionCreates.current.set(editionRiskKey, { actor: owner }); setEditionGuardVersion(v => v + 1); setAcceptDuplicateRisk(false);
        saved = await api.createEdition(bookId, { config, language: form.language }, owner);
        await verifyEditionOwner(owner, valid);
        if (!matchesEditionReply(saved, config, form.language)) throw new Error("The edition creation reply could not be verified.");
        if (!valid()) return;
        uncertainEditionCreates.current.delete(editionRiskKey); setEditionGuardVersion(v => v + 1); creating = false;
      }
      if (!valid()) return;
      currentEdition.current = saved.id;
      setEditions((current) => [saved, ...current.filter((edition) => edition.id !== saved.id)]);
      setActiveId(saved.id); setForm(formFromEdition(saved, book?.language)); setDirty(false); setNotice("Edition settings saved.");
      if (saved.type === "audiobook") {
        await Promise.all([readAudioProjects(saved.id, true), readAudioHistory(saved.id, true)]);
        if (!valid()) return;
      }
    } catch (reason) {
      if (valid() && owner) { try { await verifyEditionOwner(owner, valid); } catch { /* Keep the original outcome and hide the old account view. */ } }
      if (valid()) setError(creating ? `${reason instanceof Error ? reason.message : "Could not save the edition."} The new edition's save outcome is unconfirmed. Review the warning below before another create.` : submitted ? `${reason instanceof Error ? reason.message : "Could not save the edition."} The update may have been saved; your edits remain here. Reload and compare before retrying.` : reason instanceof Error ? reason.message : "Could not save the edition.");
    } finally { if (editionSaveFlight.current === flight) { editionSaveFlight.current = null; if (valid()) setBusy(null); } }
  };

  const render = async () => {
    if (!editable || !activeId || dirty || busy || renderBlocked) return;
    const valid = captureView(); if (!valid()) return;
    setBusy("render"); setError(null); setNotice(null); setRendered(null);
    const startedAt = Date.now();
    try { const result = await api.renderEdition(activeId, { idempotencyKey: crypto.randomUUID() }); if (valid()) { setRendered({ ...result, expiresAt: renderLinksDeadline(result, startedAt) }); setReaderRefreshKey(result.jobId); setNotice("Private render completed."); } }
    catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Rendering failed."); }
    finally { if (valid()) setBusy(null); }
  };

  const validate = async () => {
    if (!editable || !activeId || dirty || busy || !channelCompatible) return;
    const valid = captureView(); if (!valid()) return;
    setBusy("preflight"); setError(null); setNotice(null); setPreflight(null);
    try { const result = await api.runPreflight({ bookId, editionId: activeId, channel, idempotencyKey: crypto.randomUUID() }); if (valid()) setPreflight(result); }
    catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Preflight failed."); }
    finally { if (valid()) setBusy(null); }
  };

  const refreshHistory = async () => {
    if (busy) return;
    const valid = captureView(), edition = activeId, owner = loadedEditionOwner.current;
    if (!valid() || !edition || !owner) return;
    setBusy("history"); setError(null);
    try { await readPackageHistory(edition, owner); }
    finally { if (valid()) setBusy(null); }
  };

  const refreshAudiobooks = async () => {
    if (!activeId || busy) return;
    const editionId = activeId, valid = captureView(); if (!valid()) return;
    setBusy("audiobook"); setError(null);
    try { await readAudioProjects(editionId, true); }
    finally { if (valid()) setBusy(null); }
  };

  const exportGooglePlayAudiobook = async () => {
    if (!editable || !activeId || form.kind !== "audiobook" || dirty || busy || !googlePlayIdentifier.trim() || !googlePlayCoverId) return;
    const valid = captureView(); if (!valid()) return;
    const editionId = activeId, flight = beginAudioMutation(); if (!flight) return;
    setBusy("audiobook"); setError(null); setNotice(null);
    try {
      const startedAt = downloadClock();
      const { job } = await scope.checked(() => api.createAudiobookGooglePlayExport(editionId, {
        identifier: googlePlayIdentifier.trim(), coverAssetId: googlePlayCoverId,
        idempotencyKey: exportRequestKey.current ?? (exportRequestKey.current = crypto.randomUUID()),
      }, scope.actor));
      if (!valid()) return;
      exportRequestKey.current = null;
      if (job.editionId !== editionId) throw new Error("The audiobook export did not match this edition.");
      setGooglePlayExports((current) => [timeAudio(job, startedAt), ...current.filter((item) => item.id !== job.id)]); observePackageClock();
      setNotice("Export queued. You can leave this page; progress and the private download will remain in export history.");
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Could not create the Google Play audio archive."); }
    finally { finishAudioMutation(flight, editionId, valid); if (valid()) setBusy(null); }
  };

  const cancelGooglePlayExport = async (jobId: string) => {
    if (!editable || busy || !activeId) return;
    const valid = captureView(); if (!valid()) return;
    const editionId = activeId, flight = beginAudioMutation(); if (!flight) return;
    setBusy("audiobook"); setError(null);
    try {
      const startedAt = downloadClock();
      const { job } = await scope.checked(() => api.cancelAudiobookGooglePlayExport(jobId, scope.actor));
      if (!valid()) return;
      if (job.editionId !== editionId) throw new Error("The audiobook export did not match this edition.");
      setGooglePlayExports((current) => current.map((item) => item.id === job.id ? timeAudio(job, startedAt) : item)); observePackageClock();
      setNotice(job.status === "cancelled" ? "Export cancelled." : job.status === "running" ? "Cancellation requested. The worker will stop at its next safe checkpoint." : job.status === "succeeded" ? "Export finished before cancellation. Refresh history to renew its private download." : job.status === "failed" ? "Export failed before cancellation. Review its saved failure." : "The cancellation outcome remains unconfirmed. Refresh history to check.");
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Could not cancel the export."); }
    finally { finishAudioMutation(flight, editionId, valid); if (valid()) setBusy(null); }
  };

  const refreshGooglePlayExports = async () => {
    if (!activeId || form.kind !== "audiobook") return;
    const valid = captureView(); if (!valid()) return;
    setError(null);
    await readAudioHistory(activeId, true);
  };

  const leave = (event: React.MouseEvent<HTMLAnchorElement>) => { if (dirty && !window.confirm("Leave and discard unsaved edition settings?")) event.preventDefault(); };
  if (!active) return null;
  if (editionSessionHidden) return <section role="alert" className="rounded-xl border border-amber-300/30 bg-amber-300/5 p-4 text-sm text-amber-100">
    <p>We could not verify the account that loaded these edition settings. They are hidden; unsaved changes remain in this page.</p>
    {error && <p className="mt-2">{error}</p>}
    <button type="button" disabled={verifyingEditionSession} onClick={() => void restoreEditionSession()} className="mt-3 rounded-lg border border-amber-200/40 px-3 py-2 underline disabled:opacity-40">{verifyingEditionSession ? "Verifying…" : "Verify original account"}</button>
  </section>;

  return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div><Link href={`/books/${bookId}`} onClick={leave} className="text-sm text-white/50 hover:text-white">← Manuscript</Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Layout & publishing</h1>
        <p className="mt-2 max-w-2xl text-sm text-white/55">Create EPUB, print-ready PDF, or AI-narrated audiobook editions, then prepare private deliverables for distribution.</p>
      </div>
      <Link href={book ? `/assets?ws=${book.workspace_id}` : "/assets"} onClick={leave} className="glass-ghost rounded-full px-4 py-2 text-sm">Manage artwork</Link>
    </div>
    {error && <div role="alert" className="mb-5 rounded-xl border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-100">{error}
      {!currentIdentity && <button type="button" onClick={() => void load()} disabled={Boolean(busy)} className="mt-3 block rounded-lg border border-red-200/30 px-3 py-2 underline disabled:opacity-40">Retry loading this book</button>}
    </div>}
    {notice && <p role="status" className="mb-5 text-sm text-emerald-200">{notice}</p>}

    <fieldset disabled={Boolean(busy) || !currentIdentity} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className={`${cardClass} h-fit`}>
        <div className="flex items-center justify-between"><h2 className="font-semibold">Editions</h2><span className="text-xs text-white/40">{editions.length}</span></div>
        <div className="mt-4 space-y-2">
          {editions.map((edition) => <button key={edition.id} type="button" onClick={() => selectEdition(edition)} className={`w-full rounded-xl border p-3 text-left text-sm ${activeId === edition.id ? "border-white/40 bg-white/10" : "border-white/10 hover:bg-white/5"}`}>
            <span className="block font-medium capitalize">{edition.type}</span><span className="text-xs text-white/45">{edition.language ?? "en"} · {edition.status}</span>
          </button>)}
          {!editions.length && busy !== "load" && <p className="py-3 text-sm text-white/45">No saved editions yet.</p>}
        </div>
        {editable && <div className="mt-5 grid grid-cols-3 gap-2 border-t border-white/10 pt-5">
          <button type="button" onClick={() => newEdition("ebook")} className="rounded-lg border border-white/15 px-3 py-2 text-xs">New EPUB</button>
          <button type="button" onClick={() => newEdition("print")} className="rounded-lg border border-white/15 px-3 py-2 text-xs">New print</button>
          <button type="button" onClick={() => newEdition("audiobook")} className="rounded-lg border border-white/15 px-3 py-2 text-xs">New audio</button>
        </div>}
      </aside>

      <div className="min-w-0 space-y-6">
        <section className={cardClass} aria-labelledby="edition-settings">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="edition-settings" className="text-xl font-semibold">Edition settings</h2><p className="mt-1 text-sm text-white/45">Changes are saved before rendering or validation.</p></div>
            <button type="button" onClick={() => void save()} disabled={!editable || Boolean(busy) || (!dirty && Boolean(activeId)) || (!activeId && uncertainEditionCreates.current.has(editionRiskKey))} className="glass-solid rounded-full px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{busy === "save" ? "Saving…" : "Save edition"}</button>
          </div>
          {uncertainEditionCreates.current.has(editionRiskKey) && <div role="alert" className="mt-5 rounded-xl border border-amber-300/30 bg-amber-300/5 p-4 text-sm text-amber-100">
            <p>A previous new-edition save may have completed, but its reply was not confirmed. Creating another could produce a duplicate. The previous request could still finish after you check.</p>
            <p className="mt-2">This warning lasts only while this page remains open. Reloading or closing it removes the warning; your unsaved edition settings are not saved.</p>
            <label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={acceptDuplicateRisk} onChange={event => setAcceptDuplicateRisk(event.target.checked)} />I understand that another create can duplicate the earlier request.</label>
            <button type="button" disabled={!editable || Boolean(busy) || verifyingEditionRisk || !acceptDuplicateRisk} onClick={() => void acknowledgeEditionRisk()} className="mt-3 rounded-lg border border-amber-200/40 px-3 py-2 underline disabled:opacity-40">Allow another create despite duplicate risk</button>
          </div>}
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-white/65">Format<select value={form.kind} onChange={(event) => update("kind", event.target.value as Kind)} disabled={Boolean(activeId)} className={fieldClass}><option value="ebook">EPUB ebook</option><option value="print">Print PDF</option><option value="audiobook">AI-narrated audiobook</option></select></label>
            <label className="text-sm text-white/65">Language<input value={form.language} onChange={(event) => update("language", event.target.value)} maxLength={35} className={fieldClass} /></label>
            {form.kind !== "audiobook" && <label className="text-sm text-white/65">Text direction<select value={form.textDirection} onChange={(event) => update("textDirection", event.target.value as FormState["textDirection"])} className={fieldClass}><option value="auto">Auto from effective language</option><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select></label>}
            {form.kind === "ebook" && <>
              <label className="text-sm text-white/65">Flow<select value={form.flow} onChange={(event) => update("flow", event.target.value as FormState["flow"])} className={fieldClass}><option value="reflowable">Reflowable</option><option value="fixed">Fixed layout</option></select></label>
              <label className="text-sm text-white/65">Navigation<select value={form.navigation} onChange={(event) => update("navigation", event.target.value as FormState["navigation"])} className={fieldClass}><option value="toc+landmarks">Contents page + section landmarks</option><option value="toc">Contents page</option><option value="none">Reader navigation only (no contents page)</option></select></label>
              {form.flow === "fixed" && <p className="text-sm leading-relaxed text-amber-100/80 sm:col-span-2">Fixed layout uses the page size, margins and typography below. Pages become images with text alternatives; text is not selectable and cannot resize in the reader. Poppler is required on the rendering worker. Choose reflowable for adjustable text, broader script support and accessibility. Reader and retailer preview checks are still required.</p>}
            </>}
            {paginated && <>
              <div className="sm:col-span-2"><label htmlFor="layout-preset" className="text-sm text-white/65">Layout starter</label><select id="layout-preset" value="" onChange={(event) => {
                const presetId = event.target.value;
                if (!isLayoutPresetId(presetId)) return;
                setForm((current) => applyLayoutPreset(current, presetId));
                setDirty(true); setRendered(null); setPreflight(null); setError(null);
                setNotice("Layout starter applied. Review settings, then save and render a new proof.");
              }} disabled={!editable || Boolean(busy)} aria-describedby="layout-preset-help" className={fieldClass}>
                <option value="">Choose a starting layout</option>
                {(Object.entries(LAYOUT_PRESET_LABELS) as [LayoutPresetId, string][]).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select><p id="layout-preset-help" className="mt-2 text-xs leading-relaxed text-white/45">Adjustable starting points, not retailer certification. They change trim, margins and typography only; cover, QR, bleed, page numbering and front matter stay as set. Save, render a proof and run preflight with your chosen publisher.</p></div>
              <label className="text-sm text-white/65">Trim size<select value={form.trimSize} onChange={(event) => update("trimSize", event.target.value as FormState["trimSize"])} className={fieldClass}>{["5x8", "5.5x8.5", "6x9", "7x10", "8.5x11"].map((size) => <option key={size}>{size}</option>)}</select></label>
              {form.kind === "print" && <><label className="text-sm text-white/65">Bleed<select value={form.bleed} onChange={(event) => update("bleed", Number(event.target.value))} className={fieldClass}><option value={0}>No bleed</option><option value={0.125}>0.125 in</option></select></label>
              {form.bleed > 0 && <label className="text-sm text-white/65">Interior bleed edges<select value={form.bleedEdges} onChange={(event) => update("bleedEdges", event.target.value as FormState["bleedEdges"])} className={fieldClass}><option value="outer">Top, bottom and outer edge · KDP</option><option value="all">All four edges · Lulu</option></select></label>}
              <p className="text-xs text-white/45 sm:col-span-2">Margins below are measured from the finished trim edge. Bleed changes PDF page dimensions; it does not extend in-flow illustrations to the edge. Choose the setting required by your printer and re-render before packaging.</p></>}
              <label className="text-sm text-white/65">Body font<select value={form.bodyFont} onChange={(event) => update("bodyFont", event.target.value as FormState["bodyFont"])} className={fieldClass}>{FONTS.map((font) => <option key={font} value={font}>{fontLabel(font)}</option>)}</select></label>
              <label className="text-sm text-white/65">Heading font<select value={form.headingFont} onChange={(event) => update("headingFont", event.target.value as FormState["headingFont"])} className={fieldClass}>{FONTS.map((font) => <option key={font} value={font}>{fontLabel(font)}</option>)}</select></label>
              <p className="text-xs text-white/45 sm:col-span-2">Choose Bitstream Vera for both body and headings to embed every used font, including page numbers and DejaVu Sans Mono for code. Legacy Times, Helvetica and Courier retain their original behavior. Embedded fonts do not add RTL shaping.</p>
              <label className="text-sm text-white/65">Body size (pt)<input type="number" min={7} max={24} step={0.5} value={form.bodySize} onChange={(event) => update("bodySize", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Heading size (pt)<input type="number" min={10} max={48} value={form.headingSize} onChange={(event) => update("headingSize", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Line spacing (pt)<input type="number" min={form.bodySize} max={36} step={0.5} value={form.leading} onChange={(event) => update("leading", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Paragraph spacing (pt)<input type="number" min={0} max={36} step={0.5} value={form.paragraphSpacing} onChange={(event) => update("paragraphSpacing", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">First-line indent (in)<input type="number" min={0} max={1} step={0.05} value={form.firstLineIndent} onChange={(event) => update("firstLineIndent", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Text alignment<select value={form.textAlign} onChange={(event) => update("textAlign", event.target.value as FormState["textAlign"])} className={fieldClass}><option value="justify">Justified</option><option value="left">Left</option></select></label>
              {form.kind === "print" && <><label className="text-sm text-white/65">Page numbers<select value={form.numbering} onChange={(event) => update("numbering", event.target.value as FormState["numbering"])} className={fieldClass}><option value="arabic">Arabic</option><option value="roman">Roman</option><option value="none">None</option></select></label>
              <label className="text-sm text-white/65">Starting page number<input type="number" min={1} max={10000} step={1} value={form.startAt} onChange={(event) => update("startAt", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Number position<select value={form.numberPosition} onChange={(event) => update("numberPosition", event.target.value as FormState["numberPosition"])} className={fieldClass}><option value="bottom-outer">Bottom outer</option><option value="bottom-center">Bottom center</option><option value="top-center">Top center</option></select></label></>}
            </>}
            {form.kind === "audiobook" && <>
              <label className="text-sm text-white/65">Narrator voice<select value={form.voice} disabled={!editable} onChange={(event) => update("voice", event.target.value as AudiobookVoice)} className={fieldClass}>{["marin", "cedar", "coral", "ballad", "verse", "alloy", "ash", "echo", "sage", "shimmer"].map((voice) => <option key={voice} value={voice}>{voice}</option>)}{["fable", "onyx", "nova"].includes(form.voice) && <option value={form.voice}>{form.voice} · saved legacy voice (choose a supported voice for new narration)</option>}</select></label>
              <label className="text-sm text-white/65">Narration speed ({form.narrationSpeed.toFixed(2)}×)<input type="number" min={0.25} max={1.5} step={0.01} value={form.narrationSpeed} disabled={!editable} onChange={(event) => update("narrationSpeed", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65 sm:col-span-2">Voice direction<textarea value={form.narrationInstructions} onChange={(event) => update("narrationInstructions", event.target.value)} maxLength={2000} rows={3} className={fieldClass} placeholder="Describe pacing, tone, and pronunciation." /></label>
            </>}
          </div>
          {paginated && <><div className="mt-5 grid grid-cols-2 gap-4 border-t border-white/10 pt-5 sm:grid-cols-4">{(["top", "bottom", "inner", "outer"] as const).map((key) => <label key={key} className="text-sm capitalize text-white/65">{key} margin (in)<input type="number" min={0.25} max={2} step={0.05} value={form[key]} onChange={(event) => update(key, Number(event.target.value))} className={fieldClass} /></label>)}</div>{form.kind === "print" && form.numbering !== "none" && <p className="mt-3 text-xs leading-relaxed text-white/50">Leave at least 0.75 inches at the {form.numberPosition === "top-center" ? "top" : "bottom"} for page numbers. They stay half an inch inside the trimmed page, with space between the number and manuscript text.</p>}</>}
          {rtlPrintUnsupported && <div role="status" className="mt-5 rounded-xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-50"><p className="font-medium">RTL print PDF and fixed EPUB are not available with the current fonts.</p><p className="mt-1 text-amber-100/80">Use a reflowable EPUB for this edition, or run preflight to record the requirement while a shaping-capable font pipeline is added.</p></div>}
        </section>

        {form.kind === "print" && <p className="text-sm leading-relaxed text-white/50">Bitstream Vera embeds body and heading fonts in the PDF, including bold and italic text. It supports a limited Latin character set. Preflight identifies unsupported characters before export. Inline code uses embedded DejaVu Sans Mono for DejaVu/Vera books and Courier for legacy fonts; page numbers use the selected embedded body font.</p>}

        {form.kind !== "audiobook" && <section className={cardClass} aria-labelledby="front-matter-settings">
          <h2 id="front-matter-settings" className="text-xl font-semibold">Title & copyright pages</h2>
          <p className="mt-1 text-sm text-white/45">Print includes a title page; EPUB can include one below. It uses your saved book title, subtitle and author. Add your own notice or publisher to include a copyright page, with the saved ISBN when available. This does not register copyright or assign an ISBN.</p>
          <div className="mt-5 grid gap-4">
            {form.kind === "print" && <label className="inline-flex items-center gap-2 text-sm text-white/65"><input type="checkbox" checked={form.printContents} onChange={(event) => update("printContents", event.target.checked)} />Include chapter contents (page references follow your numbering settings; changes affect the final page count)</label>}
            {form.kind === "ebook" && <label className="inline-flex items-center gap-2 text-sm text-white/65"><input type="checkbox" checked={form.ebookTitlePage} onChange={(event) => update("ebookTitlePage", event.target.checked)} />Include EPUB title page (leave off if your manuscript already contains one)</label>}
            <label className="text-sm text-white/65">Publisher or imprint<input value={form.publisher} maxLength={200} onChange={(event) => update("publisher", event.target.value)} className={fieldClass} /></label>
            <label className="text-sm text-white/65">Copyright notice<textarea value={form.copyrightNotice} maxLength={3000} rows={5} onChange={(event) => update("copyrightNotice", event.target.value)} className={fieldClass} placeholder="Enter the exact notice and permissions text you want printed." /></label>
          </div>
        </section>}
        {form.kind !== "audiobook" && <section className={cardClass} aria-labelledby="cover-settings">
          <h2 id="cover-settings" className="text-xl font-semibold">Cover composition</h2><p className="mt-1 text-sm text-white/45">Choose private artwork; title, author, overlay, and optional QR are composed during rendering.</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-white/65">Cover artwork<select value={form.coverAssetId} onChange={(event) => update("coverAssetId", event.target.value)} className={fieldClass}><option value="">No cover artwork</option>{coverAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
            <label className="text-sm text-white/65">Text color<input type="color" value={form.textColor} onChange={(event) => update("textColor", event.target.value)} className={`${fieldClass} h-11 p-1`} /></label>
            <label className="text-sm text-white/65">Dark overlay ({Math.round(form.overlay * 100)}%)<input type="range" min={0} max={0.9} step={0.01} value={form.overlay} onChange={(event) => update("overlay", Number(event.target.value))} className="mt-4 w-full" /></label>
            <div className="flex flex-wrap items-center gap-4 pt-6 text-sm text-white/65">{(["titleOnCover", "subtitleOnCover", "authorOnCover"] as const).map((key) => <label key={key} className="inline-flex items-center gap-2"><input type="checkbox" checked={form[key]} onChange={(event) => update(key, event.target.checked)} />{key === "titleOnCover" ? "Title" : key === "subtitleOnCover" ? "Subtitle" : "Author"}</label>)}</div>
          </div>
          <label className="mt-5 inline-flex items-center gap-2 text-sm text-white/65"><input type="checkbox" checked={form.qrEnabled} onChange={(event) => update("qrEnabled", event.target.checked)} />Add QR code</label>
          {form.qrEnabled && <div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-sm text-white/65">HTTPS destination<input type="url" value={form.qrUrl} onChange={(event) => update("qrUrl", event.target.value)} placeholder="https://author.example/book" className={fieldClass} /></label><label className="text-sm text-white/65">QR label<input value={form.qrLabel} onChange={(event) => update("qrLabel", event.target.value)} maxLength={120} placeholder="Read more" className={fieldClass} /></label></div>}
          {rtlCoverTextUnsupported && <div role="status" className="mt-5 rounded-xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-50"><p className="font-medium">RTL cover text cannot be safely composed with the current cover renderer.</p><p className="mt-1 text-amber-100/80">Turn off the selected title, subtitle, and author overlays for artwork-only cover output, or use a shaping-capable cover workflow.</p></div>}
        </section>}

        {form.kind === "print" && <section className={cardClass} aria-labelledby="paperback-cover-title">
          <h2 id="paperback-cover-title" className="text-xl font-semibold">Full paperback cover</h2>
          <p className="mt-2 text-sm leading-relaxed text-white/50">Create one PDF with back cover, spine and front artwork. The spine follows your rendered page count; KDP profiles round an odd count up to the next even page. A blank area is reserved for your printer’s ISBN barcode.</p>
          <label className="mt-5 inline-flex items-center gap-2 text-sm text-white/70"><input type="checkbox" checked={form.wrapEnabled} onChange={(event) => update("wrapEnabled", event.target.checked)} />Create full cover PDF</label>
          {form.wrapEnabled && <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-white/65 sm:col-span-2">Paper and printer<select value={form.wrapProfile} onChange={(event) => update("wrapProfile", event.target.value as FormState["wrapProfile"])} className={fieldClass}><option value="kdp-white">KDP · black ink, white paper</option><option value="kdp-cream">KDP · black ink, cream paper</option><option value="kdp-standard-color">KDP · standard color</option><option value="kdp-premium-color">KDP · premium color</option><option value="custom">Other printer · use its paperback template</option></select></label>
            {form.wrapProfile === "custom" && <><label className="text-sm text-white/65">Template spine width (in)<input type="number" min={0.01} max={3} step={0.0001} value={form.spineWidth} onChange={(event) => update("spineWidth", Number(event.target.value))} className={fieldClass} /></label><label className="text-sm text-white/65">Template page count<input type="number" min={1} max={2000} value={form.templatePages || ""} onChange={(event) => update("templatePages", Number(event.target.value))} className={fieldClass} /></label></>}
            <label className="text-sm text-white/65 sm:col-span-2">Back cover text<textarea rows={6} maxLength={3000} value={form.backText} onChange={(event) => update("backText", event.target.value)} className={fieldClass} placeholder="Introduce the book and give readers a reason to open it." /></label>
            <label className="text-sm text-white/65 sm:col-span-2">Spine text (optional)<input maxLength={200} value={form.spineText} onChange={(event) => update("spineText", event.target.value)} className={fieldClass} placeholder="Book title · Author" /></label>
            <label className="text-sm text-white/65">Back and spine background<input type="color" value={form.wrapBackground} onChange={(event) => update("wrapBackground", event.target.value)} className={`${fieldClass} h-11 p-1`} /></label>
            <label className="text-sm text-white/65">Back and spine text color<input type="color" value={form.wrapTextColor} onChange={(event) => update("wrapTextColor", event.target.value)} className={`${fieldClass} h-11 p-1`} /></label>
            <p className="text-xs leading-relaxed text-white/45 sm:col-span-2">Choose front artwork above, then save and render. KDP profiles calculate spine width automatically. Other printers require a matching template page count and spine width, with 0.125-inch outer bleed. Spine text must fit at 7 pt or larger. Review the PDF and your printer’s template before ordering a proof; hardcover and RTL covers need a separate workflow.</p>
          </div>}
        </section>}

        {form.kind === "audiobook" && book && <NarrationQuoteStudio key={`${scope.actor}:${bookId}:${activeId ?? ""}`} scope={scope} workspaceId={book.workspace_id} bookId={bookId} editionId={activeId ?? ""}
          chapterId={narrationChapterId} chapters={chapters} voice={form.voice} speed={form.narrationSpeed} instructions={form.narrationInstructions}
          onChapterChange={setNarrationChapterId}
          onAccepted={() => void refreshAudiobooks()}
          canEdit={["owner", "admin", "editor", "writer"].includes(role)} disabled={!activeId || dirty || Boolean(busy)} />}
        {form.kind === "audiobook" && <section className={cardClass} aria-labelledby="audiobook-title">
          <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 id="audiobook-title" className="text-xl font-semibold">Saved audio & delivery</h2><p className="mt-1 max-w-2xl text-sm text-white/45">Existing private narration, listening review and export history remain available. Prepare new narration through the chapter price review above; unquoted creation is retired.</p></div><button type="button" onClick={() => void refreshAudiobooks()} disabled={!activeId || Boolean(busy)} className="glass-ghost rounded-full px-5 py-2.5 text-sm disabled:opacity-40">{busy === "audiobook" ? "Working…" : "Refresh progress"}</button></div>
          <div className="mt-7 border-t border-white/10 pt-5"><h3 className="font-medium">Narration history</h3>{audiobookProjects.length ? <ul className="mt-4 space-y-4">{audiobookProjects.map((project) => <li key={project.id} className="rounded-xl border border-white/10 bg-black/30 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-medium">{chapters.find((chapter) => chapter.id === project.chapterId)?.title ?? "Saved chapter"}</p><p className="mt-1 text-xs text-white/40">{project.segmentCount} segments · {project.billingMode === "quoted" ? `Maximum budget: ${project.creditUnits.toLocaleString()} token credits` : `${project.creditUnits.toLocaleString()} legacy audio units`} · {project.voice}</p></div><span className={`rounded-full px-3 py-1 text-xs ${project.status === "succeeded" ? "bg-emerald-400/15 text-emerald-100" : project.status === "failed" ? "bg-red-400/15 text-red-100" : "bg-amber-300/10 text-amber-100"}`}>{project.status}</span></div><ChapterAudioDownload scope={scope} projectId={project.id} ready={project.status === "succeeded"} /><div className="mt-4 grid gap-3 md:grid-cols-2">{project.segments.map((segment) => <div key={segment.index} className="rounded-lg border border-white/10 p-3"><p className="text-xs text-white/45">Part {segment.index + 1} · {segment.status}</p>{segment.audioAvailable ? <><audio controls preload="none" src={`/api/private-audio/${encodeURIComponent(scope.actor)}/segments/${encodeURIComponent(project.id)}/${segment.index}`} className="mt-2 w-full" /><a href={`/api/private-audio/${encodeURIComponent(scope.actor)}/segments/${encodeURIComponent(project.id)}/${segment.index}?download=1`} download className="mt-2 inline-block text-xs underline">Download private MP3</a></> : <p className="mt-2 text-xs text-white/35">Audio will appear after the worker completes this segment.</p>}</div>)}</div></li>)}</ul> : <p className="mt-3 text-sm text-white/45">No narration has been queued for this edition.</p>}
            <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4"><h3 className="font-medium">Google Play export · private download</h3><p className="mt-1 text-sm text-white/45">Queue a durable, ordered ZIP for manual Partner Center upload. You can leave this page while it builds. Every current chapter must have narration, a saved QC report, and an approver’s exact-audio listening sign-off.</p>
              <div className="mt-4 grid gap-3 md:grid-cols-2"><label className="text-sm text-white/65">ISBN-13 or publisher book ID<input value={googlePlayIdentifier} onChange={(event) => { setGooglePlayIdentifier(event.target.value); exportRequestKey.current = null; }} maxLength={64} autoComplete="off" className={fieldClass} placeholder="978… or your Google book ID" /></label>
                <label className="text-sm text-white/65">Audiobook cover<select value={googlePlayCoverId} onChange={(event) => { setGooglePlayCoverId(event.target.value); exportRequestKey.current = null; }} className={fieldClass}><option value="">Choose JPEG or PNG artwork</option>{coverAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label></div>
              <p className="mt-3 text-xs leading-relaxed text-amber-100/75">Google Play requires AI-narrated uploads to be labeled “Synthesized voice.” The package does not submit, publish, register an ISBN, or guarantee Partner Center eligibility. Verify cover resolution and current account/territory rules before upload.</p>
              <button type="button" onClick={() => void exportGooglePlayAudiobook()} disabled={!editable || !activeId || dirty || Boolean(busy) || !googlePlayIdentifier.trim() || !googlePlayCoverId || chapters.length === 0} className="glass-solid mt-4 rounded-full px-5 py-2.5 text-sm font-semibold text-black disabled:opacity-40">{busy === "audiobook" ? "Queuing export…" : "Queue Google Play archive"}</button>
              <div className="mt-6 border-t border-white/10 pt-4"><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-medium">Export history</h4><button type="button" onClick={() => void refreshGooglePlayExports()} disabled={!activeId || Boolean(busy)} className="text-xs text-white/55 underline disabled:opacity-40">Refresh</button></div>
                {googlePlayExports.length ? <ul className="mt-3 space-y-3">{googlePlayExports.map((job) => {
                  const progress = Math.round((job.progressChapters / Math.max(1, job.progressTotal)) * 100);
                  const running = job.status === "queued" || job.status === "running";
                  return <li key={job.id} className="rounded-xl border border-white/10 bg-black/30 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-medium">Google Play · {job.progressTotal} chapters</p><p className="mt-1 text-xs text-white/40">{new Date(job.createdAt).toLocaleString()}{job.archiveSizeBytes ? ` · ${(job.archiveSizeBytes / (1024 * 1024)).toFixed(1)} MiB` : ""}</p></div>
                      <span className={`rounded-full px-3 py-1 text-xs ${job.status === "succeeded" ? "bg-emerald-400/15 text-emerald-100" : job.status === "failed" ? "bg-red-400/15 text-red-100" : job.status === "cancelled" ? "bg-white/10 text-white/55" : "bg-amber-300/10 text-amber-100"}`}>{job.status}</span></div>
                    {running && <div className="mt-3"><div className="flex justify-between text-xs text-white/45"><span>{job.status === "queued" ? "Waiting for an export worker" : "Assembling and verifying private files"}</span><span>{job.progressChapters}/{job.progressTotal} chapters</span></div><div role="progressbar" aria-label="Audiobook export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-emerald-200 transition-[width]" style={{ width: `${progress}%` }} /></div></div>}
                    {job.status === "failed" && <p className="mt-3 text-xs text-red-100">Export failed ({job.errorCode ?? "unknown_error"}). Correct the source or cover and queue a new attempt.</p>}
                    {job.status === "cancelled" && <p className="mt-3 text-xs text-white/45">This export was cancelled before completion.</p>}
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">{job.downloadUrl && job.synthesizedVoiceDisclosureRequired && currentIdentity && currentBook.current === bookId && ( !packageClockFault && !downloadExpired(job.downloadExpiresAt, packageClock) ? <PrivateArtifactDownload actor={linkOwner} url={job.downloadUrl} filename={archiveFilename(job.downloadUrl)} expectedPath={audioArchivePath(book?.workspace_id, job.id)} isCurrent={() => linkScope() && currentBook.current === bookId && currentEdition.current === activeId && viewEpoch.current === linkEpoch && loadedEditionOwner.current === linkOwner && audioExportsRef.current.includes(job)} isExpired={() => { const now = observePackageClock(); return clockFault.current || downloadExpired(job.downloadExpiresAt, now); }} onInvalid={(message, kind) => { if (kind === "expired") return; setGooglePlayExports([]); setError(message); }} className="font-medium underline disabled:opacity-40">Download private ZIP</PrivateArtifactDownload> : <span>{packageClockFault ? "Device clock moved backwards. Reload this page before renewing private links." : "Private link expired or could not be verified. Refresh export history to renew it."}</span>)}
                      {job.totalDurationSeconds && <span className="text-xs text-white/45">{Math.floor(job.totalDurationSeconds / 60)} min · disclose “Synthesized voice” on upload</span>}
                      {running && <button type="button" onClick={() => void cancelGooglePlayExport(job.id)} disabled={!editable || Boolean(busy)} className="text-xs text-white/55 underline disabled:opacity-40">Cancel export</button>}</div>
                  </li>;
                })}</ul> : <p className="mt-3 text-sm text-white/45">No audiobook archives have been queued.</p>}
              </div>
            </div></div>
        </section>}

        {form.kind !== "audiobook" && <section className={cardClass} aria-labelledby="export-title">
          <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 id="export-title" className="text-xl font-semibold">Render & preflight</h2><p className="mt-1 text-sm text-white/45">Files stay private and use five-minute download links. Retailer submission is manual in this release.</p></div>
            <button type="button" onClick={() => void render()} disabled={!editable || !activeId || dirty || Boolean(busy) || renderBlocked} aria-describedby={renderBlocked ? "rtl-render-guidance" : undefined} className="glass-solid rounded-full px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{busy === "render" ? "Rendering…" : `Render ${form.kind === "ebook" ? "EPUB" : "PDF"}`}</button></div>
          {dirty && <p className="mt-3 text-xs text-amber-200">Save these settings before rendering or validating.</p>}
          {renderBlocked && <p id="rtl-render-guidance" className="mt-3 text-sm text-amber-100">Rendering is disabled until the RTL typography requirement above is resolved. Preflight is still available.</p>}
          {rendered && <div className="mt-5 grid gap-4 md:grid-cols-2">{rendered.artifacts.map((artifact) => <div key={artifact.asset.id} className="rounded-xl border border-white/10 bg-black/40 p-4"><p className="text-sm font-medium">{artifact.asset.name}</p><p className="mt-1 text-xs text-white/40">{artifact.role} · {(artifact.asset.size_bytes / 1024).toFixed(0)} KB</p>{artifact.asset.mime_type === "image/png" ? <PrivateCoverPreview actor={linkOwner} url={artifact.download.url} expectedPath={renderedStoragePath(book?.workspace_id, artifact)} expiresAt={rendered.expiresAt} isCurrent={() => linkScope() && currentBook.current === bookId && currentEdition.current === activeId && viewEpoch.current === linkEpoch && loadedEditionOwner.current === linkOwner && renderedRef.current === rendered} /> : null}<PrivateArtifactDownload actor={linkOwner} url={artifact.download.url} filename={artifact.asset.name} expectedPath={renderedStoragePath(book?.workspace_id, artifact)} isCurrent={() => linkScope() && currentBook.current === bookId && currentEdition.current === activeId && viewEpoch.current === linkEpoch && loadedEditionOwner.current === linkOwner && renderedRef.current === rendered} isExpired={() => rendered.expiresAt !== undefined && Date.now() >= rendered.expiresAt} onInvalid={message => { setRendered(null); setPreflight(null); setError(message); }} className="mt-3 inline-block text-sm underline disabled:opacity-40">Download private file</PrivateArtifactDownload></div>)}</div>}
          {form.kind === "print" && rendered && currentIdentity && book && activeId && <SavedPdfProof key={`${linkOwner}:${bookId}:${activeId}:${rendered.jobId}`} actor={linkOwner} onAuthorizationFailure={invalidatePrint} bookId={bookId} workspaceId={book.workspace_id} editionId={activeId} rendered={rendered} disabled={dirty || Boolean(busy)} />}
          {form.kind === "print" && currentIdentity && book && activeId && <SavedPrintLibrary key={`${linkOwner}:${bookId}:${activeId}`} actor={linkOwner} bookId={bookId} workspaceId={book.workspace_id} editionId={activeId} refreshKey={readerRefreshKey} dirty={dirty} disabled={dirty || Boolean(busy)} onSelect={adoptPrint} onInvalidate={invalidatePrint} />}
          <div className="mt-6 flex flex-wrap items-end gap-3 border-t border-white/10 pt-5"><label className="min-w-52 flex-1 text-sm text-white/65">Preflight target<select value={channel} onChange={(event) => { setChannel(event.target.value as Channel); setPreflight(null); }} className={fieldClass}><option value="export">Universal export</option><option value="kdp">Amazon KDP</option><option value="apple">Apple Books</option><option value="barnesnoble">Barnes & Noble Press</option><option value="lulu">Lulu</option><option value="googleplay">Google Play Books</option></select></label><button type="button" onClick={() => void validate()} disabled={!editable || !activeId || dirty || Boolean(busy) || !channelCompatible} className="glass-ghost rounded-full px-5 py-2.5 text-sm disabled:opacity-40">{busy === "preflight" ? "Checking…" : "Run preflight"}</button></div>
          {!channelCompatible && <p className="mt-3 text-sm text-amber-200">{channel === "lulu" ? "Lulu packages require a print PDF edition." : channel === "googleplay" ? "Google Play Books packages require an EPUB edition with an embedded front cover." : channel === "apple" ? "Apple Books packages require an EPUB edition." : "Choose an edition supported by this retailer."}</p>}
          {channel === "googleplay" && channelCompatible && <p className="mt-3 text-xs leading-5 text-white/45">Single-title Partner Center handoff only. Run EpubCheck and inspect Google’s processed preview, pricing, territories, and Review tab before publishing. This does not submit the book.</p>}
          {preflight && <div className="mt-5"><div className="flex flex-wrap gap-3 text-sm"><span className={`rounded-full px-3 py-1 ${preflight.errors ? "bg-red-400/15 text-red-100" : "bg-emerald-400/15 text-emerald-100"}`}>{preflight.errors} errors</span><span className="rounded-full bg-amber-300/10 px-3 py-1 text-amber-100">{preflight.warnings} warnings</span><span className="px-2 py-1 text-white/40">Rules {preflight.ruleVersion}</span></div>{preflight.findings.length ? <ul className="mt-4 space-y-2">{preflight.findings.map((finding, index) => <li key={`${finding.rule_id}:${finding.location}:${index}`} className="rounded-xl border border-white/10 p-3 text-sm"><span className="font-medium uppercase text-white/60">{finding.severity}</span> · {finding.message}<span className="mt-1 block text-xs text-white/35">{finding.rule_id}{finding.location ? ` · ${finding.location}` : ""}</span></li>)}</ul> : <p className="mt-4 text-sm text-emerald-200">No preflight findings for this target.</p>}</div>}
        </section>}

        {currentIdentity && activeId && form.kind === "ebook" && <SavedEpubReader key={`${linkOwner}:${bookId}:${activeId}`} actor={linkOwner} workspaceId={book?.workspace_id ?? ""} bookId={bookId} editionId={activeId} dirty={dirty} refreshKey={readerRefreshKey} />}

        {form.kind !== "audiobook" && <section className={cardClass} aria-labelledby="package-title">
          <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 id="package-title" className="text-xl font-semibold">Retailer export packages</h2><p className="mt-1 max-w-2xl text-sm text-white/45">Create a private ZIP from the exact saved render after a zero-error retailer preflight. The package is downloaded and submitted manually; this does not publish or track retailer review status.</p></div>
          </div>
          <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4 text-sm" aria-label="Plan publishing access">
            {!planStatus || planStatus.status === "loading" ? <p role="status" className="text-white/60">Checking this workspace’s publishing access…</p>
              : planStatus.status === "unavailable" ? <p role="status" className="text-amber-100">Publishing access could not be checked. <button type="button" className="underline underline-offset-4" onClick={() => setPlanRevision(value => value + 1)}>Try again</button></p>
              : <><p className="text-white/70">{planStatus.rendering ? "EPUB/PDF rendering is included in the current plan." : "EPUB/PDF rendering is not included in the current plan."}</p>
                <p className="mt-2 text-white/70">{channel === "export" ? "Choose a retailer above to check package access." : planStatus.channels?.includes(CHANNEL_ENTITLEMENTS[channel]) ? "The selected retailer package is included in the current plan." : "The selected retailer package is not included in the current plan."}</p>
                <p className="mt-2 text-xs text-white/45">Access can change; the server checks the plan again when a package is created. <button type="button" className="underline underline-offset-4" onClick={() => setPlanRevision(value => value + 1)}>Refresh access</button></p></>}
          </div>
          <RetailerPackageRequest key={bookId} bookId={bookId} canEdit={editable} disabled={Boolean(busy) && busy !== "package"}
            request={activeId && !dirty && channel !== "export" && channelCompatible && rendered && preflight && preflight.requestedChannel === channel && preflight.errors === 0
              ? { bookId, editionId: activeId, channel, renderJobId: rendered.jobId, preflightJobId: preflight.jobId } : null}
            onBusy={working => { setBusy(working ? "package" : null); if (working) setNotice(null); }}
            onJob={(job, startedAt) => {
              const edition = currentEdition.current, owner = loadedEditionOwner.current;
              if (!edition || !owner || job.editionId !== edition || job.bookId !== bookId) return;
              setPublishingJobs(current => [timePackage(job, startedAt), ...current.filter(item => item.id !== job.id)]);
              observePackageClock(); void readPackageHistory(edition, owner);
            }} />
          <p className="mt-3 text-xs leading-relaxed text-white/50">New packages include metadata.json with your saved listing text and README.txt with manual handoff steps. These are for your review, not an automatic retailer import. Older packages remain unchanged.</p>
          {channel === "export" && <p className="mt-4 text-sm text-white/55">Choose a retailer above to create its versioned package. Universal exports are the rendered EPUB/PDF files shown in the render section.</p>}
          {channel !== "export" && (!rendered || !preflight) && <p className="mt-4 text-sm text-white/55">Render this saved edition and run a {channel} preflight to enable packaging.</p>}
          {preflight?.errors ? <p className="mt-4 text-sm text-red-100">Resolve every preflight error, save, render, and validate again before packaging.</p> : null}

          <div className="mt-7 flex items-center justify-between border-t border-white/10 pt-5"><h3 className="font-medium">Package history</h3><button type="button" onClick={() => void refreshHistory()} disabled={Boolean(busy) || !activeId} className="text-sm text-white/55 underline disabled:opacity-40">{busy === "history" ? "Refreshing…" : "Refresh"}</button></div>
          {!activeId ? <p className="mt-4 text-sm text-white/45">Save this edition to view its package history.</p> : packageHistory.editionId !== activeId || packageHistory.status === "loading" ? <p role="status" className="mt-4 text-sm text-white/45">Checking package history for this edition…</p> : null}
          {packageHistory.editionId === activeId && packageHistory.status === "unavailable" && <p role="status" className="mt-4 text-sm text-amber-100">Package history is unavailable. Refresh before relying on this list.</p>}
          {packageHistory.editionId === activeId && packageHistory.status === "ready" && activePublishingJobs.length ? <ul className="mt-4 space-y-3">{activePublishingJobs.map((job) => <li key={job.id} className="rounded-xl border border-white/10 bg-black/30 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-medium capitalize">{job.channel === "barnesnoble" ? "Barnes & Noble" : job.channel === "googleplay" ? "Google Play Books" : job.channel} package</p><p className="mt-1 text-xs text-white/40">{new Date(job.createdAt).toLocaleString()} · {job.ruleVersion ?? "rules pending"}</p></div><span className={`rounded-full px-3 py-1 text-xs ${job.status === "succeeded" && job.package ? "bg-emerald-400/15 text-emerald-100" : job.status === "failed" ? "bg-red-400/15 text-red-100" : "bg-amber-300/10 text-amber-100"}`}>{job.status === "succeeded" ? (job.package ? "ready" : "unavailable") : job.status}</span></div>
            {job.package ? <div className="mt-3 flex flex-wrap items-center gap-4 text-sm"><span className="text-white/55">{(job.package.asset.size_bytes / 1024).toFixed(0)} KB · SHA-256 {job.package.asset.checksum.slice(0, 12)}…</span>{currentIdentity && currentBook.current === bookId && !packageClockFault && !downloadExpired(job.downloadExpiresAt, packageClock) ? <PrivateArtifactDownload actor={linkOwner} url={job.package.download.url} filename={`${job.channel}-export.zip`} expectedPath={packageStoragePath(book?.workspace_id, job)} isCurrent={() => linkScope() && currentBook.current === bookId && currentEdition.current === activeId && viewEpoch.current === linkEpoch && loadedEditionOwner.current === linkOwner && publishingJobsRef.current.includes(job)} isExpired={() => { const now = observePackageClock(); return clockFault.current || downloadExpired(job.downloadExpiresAt, now); }} onInvalid={(message, kind) => { if (kind === "expired") return; setPackageHistory({ editionId: activeId, status: "unavailable" }); setError(message); }} className="underline disabled:opacity-40">Download private ZIP</PrivateArtifactDownload> : <span>{packageClockFault ? "Device clock moved backwards. Reload this page before renewing private links." : "Private link expired or could not be verified. Refresh package history to renew it."}</span>}</div> : <p className="mt-3 text-sm text-white/45">{job.failureCode ? `Package failed: ${job.failureCode}` : job.status === "succeeded" ? "This job is saved in history, but its file is currently unavailable. Check Assets or contact your workspace admin." : "No downloadable package is available for this job."}</p>}
          </li>)}</ul> : packageHistory.editionId === activeId && packageHistory.status === "ready" ? <p className="mt-4 text-sm text-white/45">No retailer packages for this edition yet.</p> : null}
        </section>}
      </div>
    </fieldset>
  </main>;
}
