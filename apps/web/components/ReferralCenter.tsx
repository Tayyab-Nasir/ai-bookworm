"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, type CreditLedgerEntry, type Referral } from "@bookworm/api-client";
import { apiClient } from "./api";
import { readBrowserSession } from "../lib/browser-session";
import { beginReferralClaim, clearReferralClaim, readReferralClaim, type ReferralClaim } from "../lib/referral-claim-recovery";

const card = "rounded-2xl border border-white/10 bg-white/[0.035]";

function shortId(value: string | null) {
  return value ? `${value.slice(0, 8)}…` : "Pending signup";
}

function tone(status: Referral["status"]) {
  if (status === "rewarded") return "border-emerald-400/20 bg-emerald-400/10 text-emerald-100";
  if (["held", "rejected", "reversed"].includes(status)) return "border-red-400/20 bg-red-400/10 text-red-100";
  return "border-amber-300/20 bg-amber-300/10 text-amber-50";
}

export default function ReferralCenter() {
  const actor = useRef<string | null>(null);
  const previousActor = useRef<string | null>(null);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const claimFlight = useRef<object | null>(null);
  const [code, setCode] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [entries, setEntries] = useState<CreditLedgerEntry[]>([]);
  const [summary, setSummary] = useState({ creditBalance: 0, referralCredits: 0, rewardedReferrals: 0 });
  const [claimCode, setClaimCode] = useState("");
  const [pendingClaim, setPendingClaim] = useState<ReferralClaim | null>(null);
  const [claimRecoveryError, setClaimRecoveryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (completed?: { actor: string; message: string }) => {
    const ticket = ++epoch.current;
    const current = () => mounted.current && epoch.current === ticket;
    actor.current = null;
    setLoading(true); setVerified(false); setError(null); setNotice(null);
    setCode(""); setShareUrl(""); setReferrals([]); setEntries([]); setPendingClaim(null); setClaimRecoveryError(null);
    setSummary({ creditBalance: 0, referralCredits: 0, rewardedReferrals: 0 });
    try {
      const session = await readBrowserSession();
      if (!current()) return;
      const api = apiClient(session.id);
      const [codeResult, referralResult, ledgerResult] = await Promise.all([
        api.getReferralCode(), api.listReferrals(), api.listCreditLedger(),
      ]);
      if (codeResult.user_id !== session.id || typeof codeResult.code !== "string"
          || !Array.isArray(referralResult.referrals) || referralResult.referrals.some(item => item.referrer_id !== session.id)
          || !Array.isArray(ledgerResult.entries) || ledgerResult.entries.some(item => item.user_id !== session.id)) {
        throw new Error("Referral data does not match your account. Reload before continuing.");
      }
      await readBrowserSession(session.id);
      if (!current()) return;
      if (previousActor.current !== session.id) setClaimCode("");
      previousActor.current = session.id;
      actor.current = session.id;
      setVerified(true);
      try { setPendingClaim(readReferralClaim(window.sessionStorage, session.id)); }
      catch { setClaimRecoveryError("Referral recovery is unavailable. Check browser storage or contact support before claiming a code."); }
      setCode(codeResult.code);
      setShareUrl(`${window.location.origin}/signup?ref=${encodeURIComponent(codeResult.code)}`);
      setReferrals(referralResult.referrals);
      setEntries(ledgerResult.entries);
      setSummary(ledgerResult.summary);
      if (completed?.actor === session.id) setNotice(completed.message);
      return session.id;
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : "Referral data could not be loaded."); }
    finally { if (current()) setLoading(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const focus = () => { void load(); };
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false; epoch.current++; actor.current = null;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);

  const { rewardedReferrals: rewarded, referralCredits: earned, creditBalance: balance } = summary;

  async function copy(value: string) {
    const owner = actor.current, ticket = epoch.current;
    if (!owner) return;
    const current = () => mounted.current && actor.current === owner && epoch.current === ticket;
    try {
      await readBrowserSession(owner);
      if (!current()) return;
      await navigator.clipboard.writeText(value);
      if (current()) { setNotice("Referral link copied."); setError(null); }
    } catch {
      if (current()) { const confirmed = await load(); if (confirmed === owner && actor.current === owner) setError("Copy failed. Select the link and copy it manually."); }
    }
  }

  async function claim() {
    const owner = actor.current;
    if (!owner || claimRecoveryError || (!pendingClaim && !claimCode.trim()) || busy || claimFlight.current) return;
    const ticket = epoch.current, flight = {};
    claimFlight.current = flight;
    const current = () => mounted.current && actor.current === owner && epoch.current === ticket && claimFlight.current === flight;
    const codeToClaim = pendingClaim?.code ?? claimCode.trim().toLowerCase();
    let dispatched = false;
    let reloading = false;
    let claimRecord: ReferralClaim | null = null;
    let fresh = false;
    setBusy(true); setError(null); setNotice(null);
    try {
      try { await readBrowserSession(owner); } catch { if (current()) await load(); return; }
      if (!current()) return;
      if (pendingClaim) {
        const saved = readReferralClaim(window.sessionStorage, owner);
        if (!saved || saved.code !== codeToClaim) throw new Error("Referral recovery changed. Reload before continuing.");
        claimRecord = saved;
      } else {
        if (!/^[a-z0-9-]{1,64}$/u.test(codeToClaim)) throw new Error("Enter a valid referral code.");
        try { claimRecord = beginReferralClaim(window.sessionStorage, owner, codeToClaim); }
        catch { throw new Error("Referral recovery could not be saved. No claim was sent; check browser storage before retrying."); }
        fresh = true;
        setPendingClaim(claimRecord);
      }
      dispatched = true;
      const result = await apiClient(owner).claimReferral(codeToClaim);
      await readBrowserSession(owner);
      if (!current()) return;
      if (!result.referral || typeof result.referral.id !== "string"
          || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(result.referral.id)
          || result.referral.referred_user_id !== owner
          || (result.alreadyAttributed !== undefined && typeof result.alreadyAttributed !== "boolean")) {
        throw new Error("The claim could not be confirmed. Retry the original code.");
      }
      clearReferralClaim(window.sessionStorage, claimRecord);
      setClaimCode("");
      reloading = true;
      await load({ actor: owner, message: result.alreadyAttributed ? "This account already has a referral attribution." : "Referral code claimed." });
    } catch (reason) {
      if (current()) {
        const definitelyRejected = fresh && dispatched && reason instanceof ApiClientError
          && [404, 422].includes(reason.status) && reason.code !== "invalid_response";
        let message = reason instanceof Error ? reason.message : "Referral code could not be claimed.";
        if (claimRecord && definitelyRejected) {
          try { clearReferralClaim(window.sessionStorage, claimRecord); }
          catch { message = "Referral recovery could not be cleared. Contact support before claiming another code."; }
        } else if (dispatched) {
          message = "The claim outcome is unconfirmed. Retry only the original code; do not clear this browser's site data.";
        }
        reloading = true;
        const confirmed = await load();
        if (confirmed === owner && actor.current === owner) setError(message);
      }
    }
    finally {
      if (claimFlight.current === flight) {
        claimFlight.current = null;
        if (mounted.current) {
          setBusy(false);
          if (dispatched && !reloading && epoch.current !== ticket) void load();
        }
      }
    }
  }

  return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
    <div className="border-b border-white/10 pb-8"><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">Earn publishing credits</p><h1 className="mt-2 text-4xl font-medium tracking-[-0.055em]">Referrals</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-white/55">Invite another author with your personal link. Qualified referrals are recorded in the immutable credit ledger; suspicious activity is held for review.</p></div>
    {error && <div role="alert" className="mt-6 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-100">{error}</div>}
    {notice && <div role="status" className="mt-6 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">{notice}</div>}
    <section aria-label="Referral summary" className="mt-8 grid gap-4 sm:grid-cols-3"><div className={`${card} p-5`}><p className="text-xs uppercase tracking-[0.14em] text-white/35">Successful referrals</p><p className="mt-4 text-3xl font-medium">{verified ? rewarded : "—"}</p></div><div className={`${card} p-5`}><p className="text-xs uppercase tracking-[0.14em] text-white/35">Credits earned</p><p className="mt-4 text-3xl font-medium">{verified ? earned : "—"}</p></div><div className={`${card} p-5`}><p className="text-xs uppercase tracking-[0.14em] text-white/35">Current balance</p><p className="mt-4 text-3xl font-medium">{verified ? balance : "—"}</p></div></section>
    <div className="mt-6 grid gap-6 lg:grid-cols-2"><section className={`${card} p-5 sm:p-6`}><h2 className="text-xl font-medium">Your invitation link</h2><p className="mt-2 text-sm text-white/45">The referral is claimed after your invitee signs in. Rewards post only after the server receives a qualified-product event.</p><label className="mt-5 block text-xs text-white/50">Share URL<input readOnly value={shareUrl} onFocus={(event) => event.currentTarget.select()} className="mt-2 block w-full rounded-xl border border-white/15 bg-black px-3 py-3 text-sm text-white" /></label><div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={!shareUrl} onClick={() => void copy(shareUrl)} className="glass-solid rounded-full px-5 py-2.5 text-sm font-semibold text-black disabled:opacity-40">Copy link</button><button type="button" disabled={!code} onClick={() => void copy(code)} className="rounded-full border border-white/15 px-5 py-2.5 text-sm disabled:opacity-40">Copy code</button></div></section>
      <section className={`${card} p-5 sm:p-6`}><h2 className="text-xl font-medium">Have a referral code?</h2><p className="mt-2 text-sm text-white/45">Each account can be attributed once. You cannot claim your own code.</p>
        {pendingClaim && <p role="status" className="mt-4 text-sm text-amber-100">A previous claim for <code>{pendingClaim.code}</code> is unconfirmed. Retry that code only, or contact support. Keep this browser's site data.</p>}
        {claimRecoveryError && <p role="alert" className="mt-4 text-sm text-red-100">{claimRecoveryError}</p>}
        <form className="mt-5" onSubmit={(event) => { event.preventDefault(); void claim(); }}><label className="block text-xs text-white/50">Referral code<input value={verified ? pendingClaim?.code ?? claimCode : ""} onChange={(event) => setClaimCode(event.target.value)} disabled={!verified || !!pendingClaim || !!claimRecoveryError} maxLength={64} placeholder="bw-1234abcd" className="mt-2 block w-full rounded-xl border border-white/15 bg-black px-3 py-3 text-sm text-white" /></label><button disabled={!verified || !!claimRecoveryError || (!pendingClaim && !claimCode.trim()) || busy} className="glass-solid mt-4 rounded-full px-5 py-2.5 text-sm font-semibold text-black disabled:opacity-40">{busy ? "Claiming…" : pendingClaim ? "Retry original code" : "Claim code"}</button></form></section></div>
    <section className={`${card} mt-8 overflow-hidden`}><div className="flex items-center justify-between border-b border-white/10 p-5"><h2 className="text-xl font-medium">Referral history</h2><button type="button" disabled={loading} onClick={() => void load()} className="rounded-full border border-white/10 px-3 py-2 text-xs text-white/55 disabled:opacity-40">Refresh</button></div><div className="divide-y divide-white/10">{referrals.map((referral) => <article key={referral.id} className="grid gap-3 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-center"><div><p className="text-sm">Author {shortId(referral.referred_user_id)}</p><p className="mt-1 text-xs text-white/35">Started {new Date(referral.created_at).toLocaleDateString()}</p></div>{referral.flagged && <p className="text-xs text-red-200/70">Held for review</p>}<span className={`w-fit rounded-full border px-2.5 py-1 text-[10px] capitalize ${tone(referral.status)}`}>{referral.status}</span></article>)}{verified && referrals.length === 0 && <p className="p-10 text-center text-sm text-white/35">No referrals yet. Share your link to get started.</p>}</div></section>
    <section className={`${card} mt-8 overflow-hidden`}><div className="border-b border-white/10 p-5"><h2 className="text-xl font-medium">Credit ledger</h2><p className="mt-1 text-xs text-white/35">Append-only credits and deductions, newest first.</p></div><div className="divide-y divide-white/10">{entries.slice(0, 30).map((entry) => <article key={entry.id} className="grid gap-2 p-4 text-sm sm:grid-cols-[1fr_auto_auto] sm:items-center"><div><p className="capitalize">{entry.source.replaceAll("_", " ")}</p><time dateTime={entry.created_at} className="mt-1 block text-xs text-white/35">{new Date(entry.created_at).toLocaleString()}</time></div><span className={entry.amount >= 0 ? "text-emerald-200" : "text-red-200"}>{entry.amount >= 0 ? "+" : ""}{entry.amount}</span><span className="text-white/45">Balance {entry.balance_after}</span></article>)}{verified && entries.length === 0 && <p className="p-10 text-center text-sm text-white/35">No credit entries yet.</p>}</div></section>
  </main>;
}
