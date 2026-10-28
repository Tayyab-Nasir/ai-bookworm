"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AiConnection, AiConnections } from "@bookworm/api-client/ai-connections";
import { customerUuid, type CustomerAiOption, type CustomerAiReceipt, type CustomerAiSelection, type CustomerTextAgent } from "@bookworm/api-client/customer-ai";
import type { Book, Chapter } from "@bookworm/types";
import { apiClient } from "./api";
import { readBrowserSession } from "../lib/browser-session";
import { readCustomerAiPending, saveCustomerAiPending, clearCustomerAiPending, sameReviewedPreparation } from "../lib/customer-ai-recovery";
import styles from "./CustomerAiStudio.module.css";

const tasks: { id: CustomerTextAgent; label: string }[] = [
  { id: "writer", label: "Draft a passage" }, { id: "proofreader", label: "Proofread" },
  { id: "copyeditor", label: "Copy edit" }, { id: "consistency", label: "Check consistency" },
];
const names = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", openrouter: "OpenRouter", xai: "xAI" };
const writes = (role: string) => ["owner", "admin", "editor", "writer"].includes(role);
type Desk = { actor: string; book: Book; chapters: Chapter[]; role: string; connections: AiConnections };
const statusNames = { prepared: "Ready for review", expired: "Review expired", closed: "Closed before generation", closed_before_prepare: "Closed before preparation",
  queued: "Queued", running: "Processing or awaiting a receipt", succeeded: "Result saved for review", cancelled: "Cancelled before dispatch",
  requires_review: "Provider outcome needs review", not_found: "No saved receipt yet" };

export default function CustomerAiStudio({ bookId }: { bookId: string }) {
  const api = apiClient(), lifecycle = useRef({ epoch: 0, alive: false, flight: -1, abort: new AbortController() });
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const [desk, setDesk] = useState<Desk | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null), [receipt, setReceipt] = useState<CustomerAiReceipt | null>(null);
  const [connectionId, setConnection] = useState(""), [chapterId, setChapter] = useState(""), [agent, setAgent] = useState<CustomerTextAgent>("writer");
  const [instruction, setInstruction] = useState(""), [bible, setBible] = useState(false), [guide, setGuide] = useState(false), [budget, setBudget] = useState(4096);
  const [options, setOptions] = useState<CustomerAiOption[]>([]), [policyId, setPolicy] = useState("");
  const [review, setReview] = useState<{ operation: string; instruction: string; bible: boolean; guide: boolean; budget: number } | null>(null);
  const [consent, setConsent] = useState(false), [now, setNow] = useState(Date.now());
  const valid = (epoch: number) => lifecycle.current.alive && lifecycle.current.epoch === epoch;
  const clearPrivate = useCallback(() => {
    setDesk(null); setReceipt(null); setPending(null); setOptions([]); setPolicy(""); setInstruction(""); setReview(null); setConsent(false);
    setConnection(""); setChapter(""); setBible(false); setGuide(false); setAgent("writer"); setBudget(4096);
  }, []);
  const reload = useCallback(async () => {
    const state = lifecycle.current, epoch = ++state.epoch;
    state.abort.abort(); state.abort = new AbortController(); state.flight = -1;
    clearPrivate(); setBusy(true); setError("");
    try {
      if (!customerUuid.test(bookId)) throw new Error();
      const identity = await readBrowserSession(); if (!valid(epoch)) return;
      const signal = AbortSignal.any([state.abort.signal, AbortSignal.timeout(20000)]);
      const [{ book, role }, { chapters }, connections] = await Promise.all([
        api.getBook(bookId, identity.id, signal), api.listChapters(bookId, identity.id, signal), api.listAiConnections(identity.id, signal),
      ]);
      if (book.id !== bookId || !customerUuid.test(book.workspace_id) || typeof book.title !== "string" || book.title.length > 1000
        || !Array.isArray(chapters) || chapters.length > 1000 || chapters.some(c => c.book_id !== bookId || !customerUuid.test(c.id) || typeof c.title !== "string" || c.title.length > 1000)
        || new Set(chapters.map(c => c.id)).size !== chapters.length) throw new Error();
      const op = readCustomerAiPending(identity.id, bookId);
      const result = op ? await api.getCustomerAiStatus(bookId, op, identity.id, signal) : null;
      await readBrowserSession(identity.id); if (!valid(epoch)) return;
      setDesk({ actor: identity.id, book, role, chapters, connections }); setPending(op); setReceipt(result);
      setConnection(connections.connections.find(c => c.status === "saved")?.id ?? ""); setChapter(chapters[0]?.id ?? "");
    } catch { if (valid(epoch)) { clearPrivate(); setError("Saved book and request status could not be verified. Nothing was submitted. Reload or sign in again; do not clear browser recovery data."); } }
    finally { if (valid(epoch)) setBusy(false); }
  }, [api, bookId, clearPrivate]);
  useEffect(() => {
    lifecycle.current.alive = true; void reload();
    const hide = () => { ++lifecycle.current.epoch; lifecycle.current.abort.abort(); clearPrivate(); setBusy(false); setError("Private review hidden. Recheck saved status to continue."); };
    const focus = () => { if (document.visibilityState !== "hidden") void reload(); };
    const visibility = () => document.visibilityState === "hidden" ? hide() : focus();
    window.addEventListener("blur", hide); window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visibility);
    return () => { lifecycle.current.alive = false; ++lifecycle.current.epoch; lifecycle.current.abort.abort();
      window.removeEventListener("blur", hide); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visibility); };
  }, [reload, clearPrivate]);
  useEffect(() => { if (receipt?.status !== "prepared") return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [receipt]);
  useEffect(() => {
    if (review?.operation && review.operation === receipt?.operationId) {
      reviewHeading.current?.focus({ preventScroll: true }); reviewHeading.current?.scrollIntoView({ block: "start" });
    }
  }, [review?.operation, receipt?.operationId]);

  // Each request is actor-bound on the server as well as checked before/after
  // awaits. A late old-account response cannot restore controls or review data.
  async function run(work: (actor: string, signal: AbortSignal, epoch: number) => Promise<void>) {
    const state = lifecycle.current, epoch = state.epoch;
    if (!desk || busy || state.flight === epoch) return;
    const owner = desk.actor; state.flight = epoch; setBusy(true); setError(""); setConsent(false);
    try {
      await readBrowserSession(owner); if (!valid(epoch)) return;
      await work(owner, state.abort.signal, epoch);
    } catch {
      let current = false; try { await readBrowserSession(owner); current = true; } catch { /* Never retain the old account's private view. */ }
      if (valid(epoch)) { if (!current) clearPrivate(); setReview(null); setReceipt(null); setOptions([]); setPolicy("");
        setError("The outcome is unconfirmed. Check saved status before another decision. Do not create a duplicate request or assume a refund."); }
    }
    finally { if (valid(epoch)) { state.flight = -1; setBusy(false); } }
  }
  async function acceptRead(actor: string, epoch: number) { await readBrowserSession(actor); return valid(epoch); }
  const connection = desk?.connections.connections.find(c => c.id === connectionId && c.status === "saved");
  const selected = (c: AiConnection): CustomerAiSelection => ({ bookId, workspaceId: desk!.book.workspace_id, connectionId: c.id,
    credentialRevision: c.revision, provider: c.provider, agentType: agent });
  const creation = !!desk && writes(desk.role) && desk.connections.generationAvailable;
  const locked = busy || !!pending || !creation;
  const invalidateOptions = () => { setOptions([]); setPolicy(""); setConsent(false); };
  const loadOptions = () => run(async (owner, signal, epoch) => {
    if (!connection || pending || !creation) return;
    const values = await api.listCustomerAiOptions(selected(connection), owner, signal);
    if (await acceptRead(owner, epoch)) { setOptions(values); setPolicy(values[0]?.id ?? ""); if (!values.length) setError("No approved model and platform fee are available for this task."); }
  });
  const prepare = () => run(async (owner, signal, epoch) => {
    const option = options.find(o => o.id === policyId);
    if (!creation || pending || !connection || !option || !chapterId || Date.parse(option.expiresAt) <= Date.now() || (agent === "writer" && !instruction.trim())) return;
    const snapshot = { instruction: instruction.trim(), bible, guide, budget }, selection = selected(connection);
    const saved = await api.getChapterDocument(chapterId, owner, signal);
    if (!writes(saved.role) || saved.chapter.id !== chapterId || saved.chapter.book_id !== bookId || saved.document.chapterId !== chapterId
      || !customerUuid.test(saved.chapter.current_document_version_id ?? "") || !Number.isSafeInteger(saved.document.version) || saved.document.version < 1) throw new Error();
    if (!(await acceptRead(owner, epoch))) return;
    const operationId = crypto.randomUUID();
    saveCustomerAiPending(owner, bookId, operationId); setPending(operationId); setInstruction("");
    const result = await api.prepareCustomerAi({ operationId, selection, policyId: option.id, source: {
      bookId, agentType: agent, chapters: [{ chapterId, documentVersionId: saved.chapter.current_document_version_id!, version: saved.document.version }],
      userInstruction: snapshot.instruction || null, contextPolicy: { includeBookBible: snapshot.bible, includeStyleGuide: snapshot.guide,
        includeRelatedContext: false, semanticTopK: 5, maxTokens: snapshot.budget },
    } }, option, owner, signal);
    if (await acceptRead(owner, epoch)) { setReceipt(result); setReview({ operation: operationId, ...snapshot }); setNow(Date.now()); }
  });
  const check = () => run(async (owner, signal, epoch) => {
    if (!pending) return; const r = await api.getCustomerAiStatus(bookId, pending, owner, signal);
    if (await acceptRead(owner, epoch)) {
      const keepReview = review?.operation === pending && readCustomerAiPending(owner, bookId) === pending
        && sameReviewedPreparation(receipt, r, pending);
      setReceipt(r); if (!keepReview) setReview(null);
    }
  });
  const close = () => run(async (owner, signal, epoch) => {
    if (!pending) return; const r = await api.closeCustomerAi(bookId, pending, owner, signal);
    if (await acceptRead(owner, epoch)) { setReceipt(r); setReview(null); }
  });
  const recover = () => run(async (owner, signal, epoch) => {
    if (!pending) return; const r = await api.recoverCustomerAi(bookId, pending, owner, signal);
    if (await acceptRead(owner, epoch)) { setReceipt(r); setReview(null); }
  });
  const confirm = () => {
    if (!consent || !creation || receipt?.status !== "prepared" || review?.operation !== receipt.operationId || Date.parse(receipt.expiresAt) <= Date.now()
      || receipt.platformFee.mode !== "platform_plan" || receipt.platformFee.credits !== 0) return;
    const expected = receipt;
    void run(async (owner, signal, epoch) => {
      if (readCustomerAiPending(owner, bookId) !== expected.operationId) throw new Error();
      const r = await api.confirmCustomerAi(expected, owner, signal);
      if (await acceptRead(owner, epoch)) { setReceipt(r); setReview(null); }
    });
  };
  const startNew = () => run(async (owner, signal, epoch) => {
    if (!pending) return; const r = await api.getCustomerAiStatus(bookId, pending, owner, signal);
    if (!(await acceptRead(owner, epoch))) return;
    clearCustomerAiPending(owner, bookId, r); setPending(null); setReceipt(null); setReview(null); invalidateOptions();
  });
  const saved = receipt && "sourceVersions" in receipt ? receipt : null;
  const finished = receipt && ["closed", "closed_before_prepare", "cancelled", "succeeded"].includes(receipt.status);
  const canConfirm = creation && saved?.status === "prepared" && review?.operation === saved.operationId && Date.parse(saved.expiresAt) > now
    && saved.platformFee.mode === "platform_plan" && saved.platformFee.credits === 0;
  const reviewLink = saved?.jobId && ["writer", "proofreader", "copyeditor", "consistency"].includes(saved.agentType)
    ? `/books/${bookId}?${new URLSearchParams({ chapter: saved.sourceVersions[0].chapterId, aiJob: saved.jobId })}` : null;

  return <main className={styles.desk} aria-busy={busy}>
    <div className={styles.topline}><Link href={`/books/${bookId}`}>← Back to manuscript</Link><Link href="/settings/ai">Manage AI connections ↗</Link></div>
    <header className={styles.heading}><p className={styles.eyebrow}>AUTHOR WORKSPACE / YOUR AI CONNECTION</p>
      <h1>Your words.<br /><em>Your chosen model.</em></h1>
      <p>Prepare a request from saved manuscript text. Review the source, model and charges before you confirm. Every suggested edit still needs your approval.</p>
    </header>
    <div className={styles.notice}>Customer-owned AI is included in an eligible paid Bookworm plan, without additional Bookworm service credits per request. Provider API charges are separate. Subscription connections are not enabled here.</div>
    {busy && <p role="status" className={styles.caption}>Checking this request with the server… No automatic retries.</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.toolbar}><span>{desk ? desk.book.title : "Private book workspace"}</span>
      <button type="button" disabled={busy} onClick={() => void reload()}>Recheck account &amp; saved status</button></div>
    {desk && <>
      {!creation && <p role="status" className={styles.notice}>{!writes(desk.role) ? "Current write access is required to prepare a request." : "Customer-key generation is not activated. Saved requests can still be checked, closed safely or recovered. No free fallback is offered."}</p>}
      <div className={styles.columns}>
        <section className={styles.sheet} aria-labelledby="customer-source-heading"><p className={styles.eyebrow}>01 / PREPARE</p><h2 id="customer-source-heading">A precise starting point.</h2>
          <fieldset disabled={locked} className={styles.form}><legend className={styles.srOnly}>Saved source and AI selection</legend>
            <label>Saved chapter<select value={chapterId} onChange={e => setChapter(e.target.value)}>{desk.chapters.length ? desk.chapters.map(c => <option value={c.id} key={c.id}>{c.title}</option>) : <option value="">No saved chapters</option>}</select></label>
            <p className={styles.caption}>Uses the latest committed chapter revision, never an unsaved editor draft. An oversized source is rejected, not silently shortened.</p>
            <div className={styles.pair}><label>Task<select value={agent} onChange={e => { setAgent(e.target.value as CustomerTextAgent); invalidateOptions(); }}>{tasks.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
              <label>Saved connection<select value={connectionId} onChange={e => { setConnection(e.target.value); invalidateOptions(); }}><option value="">Select a connection</option>{desk.connections.connections.filter(c => c.status === "saved").map(c => <option key={c.id} value={c.id}>{names[c.provider]} · revision {c.revision}</option>)}</select></label></div>
            <label>Direction {agent === "writer" ? "(required)" : "(optional)"}<textarea value={instruction} maxLength={4000} rows={4} onChange={e => setInstruction(e.target.value)} placeholder="What should this passage accomplish?" /></label>
            <label>Context budget<select value={budget} onChange={e => setBudget(Number(e.target.value))}><option value={4096}>Compact · about 4K tokens</option><option value={8192}>Balanced · about 8K tokens</option><option value={16000}>Extended · about 16K tokens</option></select></label>
            <div className={styles.checks}><label><input type="checkbox" checked={bible} onChange={e => setBible(e.target.checked)} />Include saved Book Bible</label><label><input type="checkbox" checked={guide} onChange={e => setGuide(e.target.checked)} />Include saved style guide</label></div>
            <p className={styles.caption}>Related-passage retrieval is not enabled for customer-key requests.</p>
            <button type="button" disabled={!connection} onClick={() => void loadOptions()}>Load approved models</button>
            <label>Approved model<select value={policyId} onChange={e => setPolicy(e.target.value)}><option value="">Select an approved model</option>{options.map(o => <option key={o.id} value={o.id}>{o.model}{o.upstream ? ` · via ${o.upstream}` : ""}</option>)}</select></label>
            <button type="button" className={styles.primary} disabled={!policyId || !chapterId || !connection || (agent === "writer" && !instruction.trim())} onClick={() => void prepare()}>Prepare for review →</button>
          </fieldset>
        </section>
        <section className={styles.sheet} aria-labelledby="customer-review-heading"><p className={styles.eyebrow}>02 / REVIEW &amp; CONFIRM</p><h2 id="customer-review-heading" tabIndex={-1} ref={reviewHeading}>Nothing starts unseen.</h2>
          {!pending ? <div className={styles.empty}><span aria-hidden="true">¶</span><h3>Your request receipt appears here.</h3><p>Preparation pins the saved source and approved policy. It does not generate text or reserve a platform fee.</p></div> : <>
            <div className={styles.status} role="status">{receipt ? statusNames[receipt.status] : "Outcome unconfirmed"}</div>
            <p className={styles.caption}>Request <code>{pending}</code></p>
            {saved && <>
              <dl className={styles.details}><div><dt>Model / provider</dt><dd>{saved.model} / {names[saved.provider]}{saved.upstream ? ` via ${saved.upstream}` : ""}</dd></div>
                <div><dt>Task / credential</dt><dd>{tasks.find(t => t.id === saved.agentType)?.label ?? saved.agentType} · revision {saved.credentialRevision}</dd></div>
                <div><dt>Output limit</dt><dd>{saved.maxOutputTokens.toLocaleString()} tokens</dd></div>
                <div><dt>Bookworm access</dt><dd>{saved.platformFee.mode === "platform_plan" ? "Included in the paid plan · 0 additional Bookworm credits" : `Historical policy: ${saved.platformFee.credits.toLocaleString()} credits. New confirmation unavailable.`}</dd></div>
                <div><dt>Provider charges</dt><dd>Separate. Final cost is unknown, not $0.</dd></div>
                <div><dt>Review expires</dt><dd>{new Date(saved.expiresAt).toLocaleString()}</dd></div></dl>
              <h3 className={styles.smallHeading}>Pinned saved source</h3><ul className={styles.sources}>{saved.sourceVersions.map(s => <li key={s.chapterId}><strong>{desk.chapters.find(c => c.id === s.chapterId)?.title ?? "Saved chapter"} · version {s.version}</strong><code>Chapter {s.chapterId}</code><code>Revision {s.documentVersionId}</code></li>)}</ul>
              {saved.contextOmitted > 0 && <p className={styles.notice}>{saved.contextOmitted} optional context items were omitted. Check whether the request still has enough context.</p>}
              {review?.operation === saved.operationId && <div className={styles.brief}><h3 className={styles.smallHeading}>Your reviewed direction</h3><p>{review.instruction || "No additional direction."}</p><p className={styles.caption}>Book Bible: {review.bible ? "included" : "excluded"} · Style guide: {review.guide ? "included" : "excluded"} · Context budget: {review.budget.toLocaleString()}</p></div>}
              {saved.status === "prepared" && !review && <p className={styles.notice}>This preparation was recovered without its original direction in this page. Close it and prepare again to review the full instruction before confirming.</p>}
              {saved.status === "prepared" && Date.parse(saved.expiresAt) <= now && <p role="status">This preparation has expired. Close it before starting another.</p>}
              {canConfirm && <div className={styles.consent}><label><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} /><span>I reviewed this source and direction. I authorize separate provider API charges to my connected account. Bookworm access is included in my paid plan, with no additional Bookworm credits.</span></label><button type="button" className={styles.primary} disabled={busy || !consent} onClick={confirm}>Confirm &amp; queue request</button></div>}
            </>}
            <p className={styles.caption}>Recovery stores only this request ID in this tab. Keep the tab open while an outcome is unresolved. Status checks never regenerate content.</p>
            <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void check()}>Check saved status</button>
              {!finished && <button type="button" disabled={busy} onClick={() => void close()}>Close before dispatch</button>}
              {saved && ["queued", "running", "requires_review"].includes(saved.status) && <button type="button" disabled={busy} onClick={() => void recover()}>Recover saved result</button>}
              {finished && <button type="button" disabled={busy} onClick={() => void startNew()}>Start another request</button>}</div>
            {saved && ["running", "requires_review"].includes(saved.status) && <p className={styles.notice}>The provider may already have processed this request. Closing cannot promise cancellation or a refund. Recover only the existing result; never resend automatically.</p>}
            {saved?.status === "succeeded" && reviewLink && <Link className={styles.resultLink} href={reviewLink}>Review suggested edits in the manuscript →</Link>}
          </>}
        </section>
      </div>
    </>}
  </main>;
}
