"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BillingUsageSummary, Plan } from "@bookworm/api-client";
import type { Workspace } from "@bookworm/types";
import { apiClient } from "./api";

const cardClass = "rounded-2xl border border-white/10 bg-white/[0.035] p-5";

function channelName(channel: string) {
  return ({ export: "Universal export", kdp: "Amazon KDP", apple_books: "Apple Books", barnes_noble: "Barnes & Noble Press", lulu: "Lulu", google_play: "Google Play Books" } as Record<string, string>)[channel] ?? channel;
}

function meter(summary: BillingUsageSummary | null, key: string, quotaKey?: string) {
  const used = Number(summary?.usage[key] ?? 0);
  const limit = quotaKey ? Number(summary?.entitlements.entitlements[quotaKey] ?? 0) : null;
  return { used, limit, percent: limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0 };
}

export default function BillingCenter() {
  const api = apiClient();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [summary, setSummary] = useState<BillingUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (requestedWorkspaceId?: string) => {
    setLoading(true); setError(null);
    try {
      const [workspaceResult, planResult] = await Promise.all([api.listWorkspaces(), api.listPlans()]);
      const requested = requestedWorkspaceId ?? new URLSearchParams(window.location.search).get("ws")
        ?? window.localStorage.getItem("bookworm:workspaceId");
      const selected = workspaceResult.workspaces.find((item) => item.id === requested) ?? workspaceResult.workspaces[0] ?? null;
      setWorkspaces(workspaceResult.workspaces); setPlans(planResult.plans);
      setWorkspace(selected);
      if (selected) {
        window.localStorage.setItem("bookworm:workspaceId", selected.id);
        setSummary(await api.getUsage(selected.organization_id));
      } else setSummary(null);
      const result = new URLSearchParams(window.location.search).get("checkout");
      setNotice(result === "success" ? "Checkout returned successfully. Subscription status updates after Stripe confirms the webhook." : null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load billing details."); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const currentPlan = summary?.entitlements.plan.name.toLowerCase() ?? "free";
  const sortedPlans = useMemo(() => [...plans].sort((a, b) => a.price_cents - b.price_cents), [plans]);
  const ai = meter(summary, "ai_credits", "ai_credits_monthly");
  const images = meter(summary, "image_credits", "image_credits_monthly");
  const audio = meter(summary, "audio_credits", "audio_credits_monthly");
  const translations = meter(summary, "translation_credits", "translation_credits_monthly");

  const checkout = async (plan: Plan) => {
    if (!workspace || busy || plan.price_cents <= 0) return;
    setBusy(plan.id); setError(null); setNotice(null);
    try {
      const origin = window.location.origin;
      const result = await api.createBillingCheckout({
        organizationId: workspace.organization_id, planId: plan.id,
        successUrl: `${origin}/billing?checkout=success`, cancelUrl: `${origin}/billing?checkout=cancelled`,
      });
      window.location.assign(result.checkoutUrl);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Checkout could not be started."); setBusy(null); }
  };

  const portal = async () => {
    if (!workspace || busy) return;
    setBusy("portal"); setError(null); setNotice(null);
    try {
      const result = await api.createBillingPortal({ organizationId: workspace.organization_id, returnUrl: `${window.location.origin}/billing` });
      window.location.assign(result.portalUrl);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The billing portal could not be opened."); setBusy(null); }
  };

  return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-8">
      <div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#8f8f8f]">Plans & usage</p><h1 className="mt-2 text-4xl font-medium tracking-[-0.055em]">Billing and credits</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-white/55">See the active plan, monthly AI/image consumption, publishing access, and Stripe-managed subscription controls for the selected organization.</p></div>
      <div className="flex flex-wrap gap-2"><Link href="/referrals" className="glass-ghost rounded-full px-5 py-2.5 text-sm">Referral credits</Link>{summary?.entitlements.subscription && <button type="button" onClick={() => void portal()} disabled={Boolean(busy)} className="glass-ghost rounded-full px-5 py-2.5 text-sm disabled:opacity-40">{busy === "portal" ? "Opening…" : "Manage subscription"}</button>}</div>
    </div>

    {workspaces.length > 0 && <label className="mt-6 block max-w-sm text-sm text-white/60">Workspace<select value={workspace?.id ?? ""} disabled={loading || Boolean(busy)} onChange={(event) => void load(event.target.value)} className="mt-2 block w-full rounded-xl border border-white/15 bg-black px-4 py-2.5 text-white">{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    {error && <div role="alert" className="mt-6 rounded-xl border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-100">{error}</div>}
    {notice && <p role="status" className="mt-6 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">{notice}</p>}

    {!loading && !workspace ? <section className={`${cardClass} mt-8`}><h2 className="text-xl font-medium">Create a workspace first</h2><p className="mt-2 text-sm text-white/50">Plans and usage attach to the organization that owns a workspace.</p><Link href="/dashboard" className="mt-5 inline-block underline">Go to dashboard</Link></section> : <>
      <section className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Current billing summary">
        <div className={cardClass}><p className="text-xs uppercase tracking-[0.14em] text-white/40">Current plan</p><p className="mt-4 text-2xl font-medium capitalize">{loading ? "—" : currentPlan}</p><p className="mt-2 text-xs text-white/45">{summary?.entitlements.subscription ? `${summary.entitlements.subscription.status}${summary.entitlements.subscription.current_period_end ? ` · through ${new Date(summary.entitlements.subscription.current_period_end).toLocaleDateString()}` : ""}` : "No paid subscription"}</p></div>
        <div className={cardClass}><p className="text-xs uppercase tracking-[0.14em] text-white/40">Credit balance</p><p className="mt-4 text-2xl font-medium">{loading ? "—" : summary?.creditBalance ?? 0}</p><p className="mt-2 text-xs text-white/45">Immutable credit-ledger balance</p></div>
        <div className={cardClass}><p className="text-xs uppercase tracking-[0.14em] text-white/40">Renders this month</p><p className="mt-4 text-2xl font-medium">{loading ? "—" : summary?.usage.rendering ?? 0}</p><p className="mt-2 text-xs text-white/45">EPUB/PDF render completions</p></div>
        <div className={cardClass}><p className="text-xs uppercase tracking-[0.14em] text-white/40">Packages this month</p><p className="mt-4 text-2xl font-medium">{loading ? "—" : summary?.usage.publishing ?? 0}</p><p className="mt-2 text-xs text-white/45">Retailer export packages</p></div>
      </section>

      <section className={`${cardClass} mt-6`} aria-labelledby="monthly-usage"><h2 id="monthly-usage" className="text-xl font-medium">Monthly generation usage</h2><div className="mt-5 grid gap-6 md:grid-cols-2 xl:grid-cols-4">{[["AI credits", ai], ["Image credits", images], ["Audio credits", audio], ["Translation credits", translations]].map(([label, value]) => { const usage = value as ReturnType<typeof meter>; return <div key={label as string}><div className="flex justify-between text-sm"><span>{label as string}</span><span className="text-white/50">{usage.used} / {usage.limit ?? 0}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-white" style={{ width: `${usage.percent}%` }} /></div></div>; })}</div>
        <div className="mt-6 border-t border-white/10 pt-5"><p className="text-sm text-white/50">Publishing channels</p><div className="mt-3 flex flex-wrap gap-2">{(summary?.entitlements.entitlements.publishing_channels ?? []).map((item) => <span key={item} className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs">{channelName(item)}</span>)}</div></div>
      </section>

      <section className="mt-10" aria-labelledby="available-plans"><div><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#8f8f8f]">Upgrade options</p><h2 id="available-plans" className="mt-2 text-2xl font-medium tracking-[-0.04em]">Available plans</h2></div>
        <div className="mt-5 grid gap-4 lg:grid-cols-3">{sortedPlans.map((plan) => { const ent = plan.entitlements_json; const active = plan.name.toLowerCase() === currentPlan; const channels = Array.isArray(ent.publishing_channels) ? ent.publishing_channels.filter((item): item is string => typeof item === "string") : []; return <article key={plan.id} className={`${cardClass} flex min-h-80 flex-col ${active ? "border-white/35 bg-white/[0.07]" : ""}`}><div className="flex items-center justify-between gap-3"><h3 className="text-xl font-medium capitalize">{plan.name}</h3>{active && <span className="rounded-full bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-black">Current</span>}</div><p className="mt-5 text-4xl font-medium tracking-[-0.06em]">${(plan.price_cents / 100).toFixed(0)}<span className="text-sm font-normal tracking-normal text-white/45">/{plan.billing_period}</span></p><ul className="mt-6 space-y-2 text-sm text-white/60"><li>{Number(ent.books ?? 0)} books</li><li>{Number(ent.ai_credits_monthly ?? 0).toLocaleString()} AI credits/month</li><li>{Number(ent.image_credits_monthly ?? 0).toLocaleString()} image credits/month</li><li>{Number(ent.audio_credits_monthly ?? 0).toLocaleString()} audio credits/month</li><li>{Number(ent.translation_credits_monthly ?? 0).toLocaleString()} translation credits/month</li><li>{Number(ent.storage_gb ?? 0)} GB storage</li><li>{channels.map(channelName).join(", ") || "Universal export"}</li></ul><button type="button" onClick={() => void checkout(plan)} disabled={active || plan.price_cents <= 0 || Boolean(busy)} className="glass-solid mt-auto rounded-full px-5 py-2.5 text-sm font-semibold text-black disabled:opacity-40">{active ? "Current plan" : plan.price_cents <= 0 ? "Account tier" : busy === plan.id ? "Starting checkout…" : `Choose ${plan.name}`}</button></article>; })}</div>
      </section>
    </>}
  </main>;
}
