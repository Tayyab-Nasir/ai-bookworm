"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Community } from "@bookworm/api-client";
import { apiClient } from "./api";
import { readBrowserSession } from "../lib/browser-session";

export default function CommunityDirectory() {
  const [communities, setCommunities] = useState<Community[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [joined, setJoined] = useState<Set<string>>(new Set());
  const [inactive, setInactive] = useState<Set<string>>(new Set());
  const [membershipVerified, setMembershipVerified] = useState(false);
  const actor = useRef<string | null>(null);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const joiningRef = useRef(false);
  const uncertainByActor = useRef(new Map<string, Set<string>>());

  const refresh = useCallback(async () => {
    const ticket = ++epoch.current;
    const valid = () => mounted.current && epoch.current === ticket;
    actor.current = null;
    setLoading(true); setError(null); setNotice(null); setCommunities([]); setJoined(new Set()); setInactive(new Set()); setMembershipVerified(false);
    try {
      const session = await readBrowserSession();
      if (!valid()) return;
      const client = apiClient(session.id);
      const [directory, membership] = await Promise.allSettled([client.listCommunities(), client.listCommunityMemberships(AbortSignal.timeout(12_000))]);
      await readBrowserSession(session.id);
      if (!valid()) return;
      if (directory.status === "rejected") throw directory.reason;
      actor.current = session.id;
      setCommunities(directory.value.communities);
      if (membership.status === "rejected" || !membership.value || !Array.isArray(membership.value.memberships)
          || membership.value.memberships.some(item => !item || typeof item.communityId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(item.communityId) || typeof item.active !== "boolean")
          || new Set(membership.value.memberships.map(item => item.communityId)).size !== membership.value.memberships.length) {
        setError("Community membership could not be verified. You can open discussions; refresh before joining.");
        return;
      }
      const active = new Set(membership.value.memberships.filter(item => item.active).map(item => item.communityId));
      setJoined(active);
      setInactive(new Set(membership.value.memberships.filter(item => !item.active).map(item => item.communityId)));
      setMembershipVerified(true);
      const uncertain = uncertainByActor.current.get(session.id);
      let resolved = false;
      if (uncertain) {
        for (const id of active) if (uncertain.delete(id)) resolved = true;
        if (!uncertain.size) uncertainByActor.current.delete(session.id);
      }
      if (uncertainByActor.current.get(session.id)?.size) setNotice("A previous join may still complete. Refresh communities to check, or try joining again.");
      else if (resolved) setNotice("Your community membership is active.");
    } catch (reason) {
      if (valid()) setError(reason instanceof Error ? reason.message : "Communities could not be loaded.");
    } finally { if (valid()) setLoading(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const verify = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", verify);
    document.addEventListener("visibilitychange", verify);
    return () => { mounted.current = false; epoch.current++; actor.current = null; window.removeEventListener("focus", verify); document.removeEventListener("visibilitychange", verify); };
  }, [refresh]);

  async function join(community: Community) {
    const owner = actor.current;
    if (!owner || joiningRef.current || !membershipVerified || inactive.has(community.id)) return;
    const ticket = epoch.current;
    const valid = () => mounted.current && actor.current === owner && epoch.current === ticket;
    joiningRef.current = true; setJoining(community.id); setError(null); setNotice(null);
    let sent = false;
    try {
      await readBrowserSession(owner);
      if (!valid()) return;
      sent = true;
      const uncertain = new Set(uncertainByActor.current.get(owner)); uncertain.add(community.id);
      uncertainByActor.current.set(owner, uncertain);
      const result = await apiClient(owner).joinCommunity(community.id);
      if (result.communityId !== community.id || typeof result.role !== "string" || !result.role.trim() || result.role.length > 100
          || (result.alreadyMember !== undefined && typeof result.alreadyMember !== "boolean")) throw new Error("The service did not confirm the community membership.");
      await readBrowserSession(owner);
      if (!valid()) return;
      uncertain.delete(community.id);
      if (!uncertain.size) uncertainByActor.current.delete(owner);
      setJoined(previous => new Set(previous).add(community.id));
      setNotice(result.alreadyMember ? `You already belong to ${community.name}.` : `You joined ${community.name}. Open the discussion to post or reply.`);
    } catch (reason) {
      if (!valid()) return;
      actor.current = null; epoch.current++;
      setCommunities([]); setJoined(new Set()); setInactive(new Set()); setMembershipVerified(false);
      setError(sent ? "Your membership could not be confirmed. Refresh communities before trying again." : reason instanceof Error ? reason.message : "Could not verify your account.");
    } finally {
      joiningRef.current = false;
      if (mounted.current) {
        setJoining(null);
        if (actor.current === owner && uncertainByActor.current.get(owner)?.size) setNotice("A previous join may still complete. Refresh communities to check, or try joining again.");
      }
    }
  }
  const needle = query.trim().toLocaleLowerCase();
  const visible = communities.filter(community => `${community.name} ${community.description ?? ""}`.toLocaleLowerCase().includes(needle));

  return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
    <div className="border-b border-white/10 pb-8">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">The author community</p>
      <h1 className="mt-2 text-4xl font-medium tracking-[-0.055em]">Good books start with a conversation.</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-white/55">Find your writing circle, exchange feedback and share the work behind your next book. Public communities are open to join; private spaces require membership.</p>
    </div>
    <div className="my-6 flex flex-wrap items-end gap-3">
      <label className="block min-w-0 flex-1 text-sm text-white/65">Find a community
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} maxLength={200}
          placeholder="Search by name or description" className="mt-2 block w-full rounded-xl border border-white/15 bg-white/[0.03] px-4 py-3 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white" />
      </label>
      <button type="button" disabled={loading || joining !== null} onClick={() => void refresh()} className="rounded-full border border-white/20 px-5 py-3 text-sm disabled:opacity-40">Refresh communities</button>
    </div>
    {error && <div role="alert" className="mb-6 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-100">{error}</div>}
    {notice && <div role="status" className="mb-6 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">{notice}</div>}
    {loading ? <p role="status" className="py-12 text-white/60">Loading communities…</p> : <section aria-label="Communities" className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
      {visible.map(community => <article key={community.id} className="flex min-w-0 flex-col rounded-2xl border border-white/10 bg-white/[0.035] p-6">
        <span className="w-fit rounded-full border border-white/15 px-3 py-1 text-xs capitalize text-white/65">{community.visibility}</span>
        <h2 className="mt-5 break-words text-xl font-medium"><Link href={`/community/${encodeURIComponent(community.id)}`} className="underline-offset-4 hover:underline">{community.name}</Link></h2>
        <p className="mt-3 flex-1 whitespace-pre-wrap break-words text-sm leading-6 text-white/55">{community.description || "A space for authors to connect and discuss their work."}</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link href={`/community/${encodeURIComponent(community.id)}`} className="rounded-full border border-white/20 px-4 py-2.5 text-sm">Open discussion</Link>
          {community.visibility === "public" && <button type="button" disabled={joining !== null || !membershipVerified || joined.has(community.id) || inactive.has(community.id)} onClick={() => void join(community)} className="rounded-full bg-white px-4 py-2.5 text-sm font-medium text-black disabled:opacity-50">
            {joining === community.id ? "Joining…" : !membershipVerified ? "Membership unavailable" : joined.has(community.id) ? "Joined" : inactive.has(community.id) ? "Membership inactive" : "Join community"}
          </button>}
        </div>
      </article>)}
      {!error && visible.length === 0 && <div className="rounded-2xl border border-dashed border-white/15 p-8 md:col-span-2 lg:col-span-3">
        <h2 className="text-xl font-medium">{needle ? "No matching communities" : "No communities available yet"}</h2>
        <p className="mt-2 text-sm text-white/55">{needle ? "Try another name or clear your search." : "Public communities and private spaces you can access will appear here."}</p>
      </div>}
    </section>}
  </main>;
}
