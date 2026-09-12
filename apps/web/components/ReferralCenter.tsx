"use client";

import { useCallback, useEffect, useState } from "react";
import type { CreditLedgerEntry, Referral } from "@bookworm/api-client";
import { apiClient } from "./api";

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
  const api = apiClient();
  const [code, setCode] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [entries, setEntries] = useState<CreditLedgerEntry[]>([]);
  const [summary, setSummary] = useState({ creditBalance: 0, referralCredits: 0, rewardedReferrals: 0 });
  const [claimCode, setClaimCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [codeResult, referralResult, ledgerResult] = await Promise.all([
        api.getReferralCode(), api.listReferrals(), api.listCreditLedger(),
      ]);
      setCode(codeResult.code);
      setShareUrl(`${window.location.origin}/signup?ref=${encodeURIComponent(codeResult.code)}`);
      setReferrals(referralResult.referrals);
      setEntries(ledgerResult.entries);
      setSummary(ledgerResult.summary);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Referral data could not be loaded."); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const { rewardedReferrals: rewarded, referralCredits: earned, creditBalance: balance } = summary;

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice("Referral link copied."); setError(null); }
    catch { setError("Copy failed. Select the link and copy it manually."); }
  }

  async function claim() {
    if (!claimCode.trim() || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api.claimReferral(claimCode.trim());
      setClaimCode("");
      setNotice(result.alreadyAttributed ? "This account already has a referral attribution." : "Referral code claimed.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Referral code could not be claimed."); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
    <div className="border-b border-white/10 pb-8"><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">Earn publishing credits</p><h1 className="mt-2 text-4xl font-medium tracking-[-0.055em]">Referrals</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-white/55">Invite another author with your personal link. Qualified referrals are recorded in the immutable credit ledger; suspicious activity is held for review.</p></div>
    {error && <div role="alert" className="mt-6 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-100">{error}</div>}
    {notice && <div role="status" className="mt-6 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">{notice}</div>}
    <section aria-label="Referral summary" className="mt-8 grid gap-4 sm:grid-cols-3"><div className={`${card} p-5`}><p className="text-xs uppercase tracking-[0.14em] text-white/35">Successful referrals</p><p className="mt-4 text-3xl font-medium">{loading ? "—" : rewarded}</p></div><div className={`${card} p-5`}><p className="text-xs uppercase tracking-[0.14em] text-white/35">Credits earned</p><p className="mt-4 text-3xl font-medium">{loading ? "—" : earned}</p></div><div className={`${card} p-5`}><p className="text-xs uppercase tracking-[0.14em] text-white/35">Current balance</p><p className="mt-4 text-3xl font-medium">{loading ? "—" : balance}</p></div></section>
    <div className="mt-6 grid gap-6 lg:grid-cols-2"><section className={`${card} p-5 sm:p-6`}><h2 className="text-xl font-medium">Your invitation link</h2><p className="mt-2 text-sm text-white/45">The referral is claimed after your invitee signs in. Rewards post only after the server receives a qualified-product event.</p><label className="mt-5 block text-xs text-white/50">Share URL<input readOnly value={shareUrl} onFocus={(event) => event.currentTarget.select()} className="mt-2 block w-full rounded-xl border border-white/15 bg-black px-3 py-3 text-sm text-white" /></label><div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={!shareUrl} onClick={() => void copy(shareUrl)} className="glass-solid rounded-full px-5 py-2.5 text-sm font-semibold text-black disabled:opacity-40">Copy link</button><button type="button" disabled={!code} onClick={() => void copy(code)} className="rounded-full border border-white/15 px-5 py-2.5 text-sm disabled:opacity-40">Copy code</button></div></section>
      <section className={`${card} p-5 sm:p-6`}><h2 className="text-xl font-medium">Have a referral code?</h2><p className="mt-2 text-sm text-white/45">Each account can be attributed once. You cannot claim your own code.</p><form className="mt-5" onSubmit={(event) => { event.preventDefault(); void claim(); }}><label className="block text-xs text-white/50">Referral code<input value={claimCode} onChange={(event) => setClaimCode(event.target.value)} maxLength={64} placeholder="bw-1234abcd" className="mt-2 block w-full rounded-xl border border-white/15 bg-black px-3 py-3 text-sm text-white" /></label><button disabled={!claimCode.trim() || busy} className="glass-solid mt-4 rounded-full px-5 py-2.5 text-sm font-semibold text-black disabled:opacity-40">{busy ? "Claiming…" : "Claim code"}</button></form></section></div>
    <section className={`${card} mt-8 overflow-hidden`}><div className="flex items-center justify-between border-b border-white/10 p-5"><h2 className="text-xl font-medium">Referral history</h2><button type="button" disabled={loading} onClick={() => void load()} className="rounded-full border border-white/10 px-3 py-2 text-xs text-white/55 disabled:opacity-40">Refresh</button></div><div className="divide-y divide-white/10">{referrals.map((referral) => <article key={referral.id} className="grid gap-3 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-center"><div><p className="text-sm">Author {shortId(referral.referred_user_id)}</p><p className="mt-1 text-xs text-white/35">Started {new Date(referral.created_at).toLocaleDateString()}</p></div>{referral.flagged && <p className="text-xs text-red-200/70">Held for review</p>}<span className={`w-fit rounded-full border px-2.5 py-1 text-[10px] capitalize ${tone(referral.status)}`}>{referral.status}</span></article>)}{!loading && referrals.length === 0 && <p className="p-10 text-center text-sm text-white/35">No referrals yet. Share your link to get started.</p>}</div></section>
    <section className={`${card} mt-8 overflow-hidden`}><div className="border-b border-white/10 p-5"><h2 className="text-xl font-medium">Credit ledger</h2><p className="mt-1 text-xs text-white/35">Append-only credits and deductions, newest first.</p></div><div className="divide-y divide-white/10">{entries.slice(0, 30).map((entry) => <article key={entry.id} className="grid gap-2 p-4 text-sm sm:grid-cols-[1fr_auto_auto] sm:items-center"><div><p className="capitalize">{entry.source.replaceAll("_", " ")}</p><time dateTime={entry.created_at} className="mt-1 block text-xs text-white/35">{new Date(entry.created_at).toLocaleString()}</time></div><span className={entry.amount >= 0 ? "text-emerald-200" : "text-red-200"}>{entry.amount >= 0 ? "+" : ""}{entry.amount}</span><span className="text-white/45">Balance {entry.balance_after}</span></article>)}{!loading && entries.length === 0 && <p className="p-10 text-center text-sm text-white/35">No credit entries yet.</p>}</div></section>
  </main>;
}
