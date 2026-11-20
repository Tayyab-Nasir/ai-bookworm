"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Community, CommunityJoinOutcome } from "@bookworm/api-client";
import { apiClient } from "./api";
import { readBrowserSession } from "../lib/browser-session";
import { communityJoinStorage, forgetCommunityJoin, readCommunityJoin, rememberCommunityJoin, type CommunityJoinMarker } from "../lib/community-join-recovery";

function verifiedOutcome(value: CommunityJoinOutcome): CommunityJoinOutcome {
  if (!value || typeof value !== "object") throw new Error("The service did not confirm the join request.");
  if (value.state === "joined" && typeof value.role === "string" && value.role.trim() && value.role.length <= 100
    && typeof value.alreadyMember === "boolean") return value;
  if (value.state === "rejected" && ["not_found", "not_open", "inactive"].includes(value.reason)) return value;
  if (value.state === "closed" || value.state === "not_seen") return value;
  throw new Error("The service did not confirm the join request.");
}

function outcomeMessage(outcome: Exclude<CommunityJoinOutcome, { state: "not_seen" }>): string {
  if (outcome.state === "joined") return "Your earlier join was processed. Your current membership is shown below.";
  if (outcome.state === "closed") return "The earlier join was stopped before it could be processed.";
  if (outcome.reason === "inactive") return "Your membership is inactive. Contact a community moderator for help.";
  if (outcome.reason === "not_open") return "This community is no longer open to join.";
  return "This community is no longer available.";
}

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
  const [pending, setPending] = useState<CommunityJoinMarker | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState<"check" | "close" | null>(null);
  const actor = useRef<string | null>(null);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const joiningRef = useRef(false);

  const refresh = useCallback(async () => {
    const ticket = ++epoch.current;
    const valid = () => mounted.current && epoch.current === ticket;
    actor.current = null;
    setLoading(true); setError(null); setNotice(null); setCommunities([]); setJoined(new Set()); setInactive(new Set()); setMembershipVerified(false);
    setPending(null); setStorageReady(false); setStorageError(null);
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
      try {
        setPending(readCommunityJoin(communityJoinStorage(), session.id));
        setStorageReady(true);
      } catch (reason) {
        setStorageError(reason instanceof Error ? reason.message : "Community join recovery is unavailable in this tab.");
      }
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
    if (!owner || joiningRef.current || !membershipVerified || !storageReady || pending || inactive.has(community.id)) return;
    const ticket = epoch.current;
    const valid = () => mounted.current && actor.current === owner && epoch.current === ticket;
    joiningRef.current = true; setJoining(community.id); setError(null); setNotice(null);
    let sent = false;
    try {
      await readBrowserSession(owner);
      if (!valid()) return;
      const marker: CommunityJoinMarker = { version: 1, communityId: community.id, operationId: crypto.randomUUID() };
      rememberCommunityJoin(communityJoinStorage(), owner, marker);
      setPending(marker);
      sent = true;
      const result = verifiedOutcome(await apiClient(owner).requestCommunityJoin(community.id, marker.operationId));
      await readBrowserSession(owner);
      if (!valid()) return;
      if (result.state === "not_seen") throw new Error("The service did not confirm the join request.");
      if (!forgetCommunityJoin(communityJoinStorage(), owner, marker)) throw new Error("The saved join request changed. Refresh before continuing.");
      setPending(null);
      await refresh();
      if (mounted.current && actor.current === owner) setNotice(result.state === "joined"
        ? `Your join for ${community.name} was processed. Your current membership is shown below.`
        : outcomeMessage(result));
    } catch (reason) {
      if (!valid()) return;
      actor.current = null; epoch.current++;
      setCommunities([]); setJoined(new Set()); setInactive(new Set()); setMembershipVerified(false);
      setError(sent ? "Your membership could not be confirmed. Refresh communities to check your earlier request." : reason instanceof Error ? reason.message : "Could not verify your account.");
    } finally {
      joiningRef.current = false;
      if (mounted.current) setJoining(null);
    }
  }

  async function recover(mode: "check" | "close") {
    const owner = actor.current;
    const marker = pending;
    if (!owner || !marker || joiningRef.current || !storageReady) return;
    const ticket = epoch.current;
    const valid = () => mounted.current && actor.current === owner && epoch.current === ticket;
    joiningRef.current = true; setRecovering(mode); setError(null); setNotice(null);
    try {
      await readBrowserSession(owner);
      if (!valid()) return;
      const client = apiClient(owner);
      const result = verifiedOutcome(await (mode === "check"
        ? client.recoverCommunityJoin(marker.communityId, marker.operationId)
        : client.closeCommunityJoin(marker.communityId, marker.operationId)));
      await readBrowserSession(owner);
      if (!valid()) return;
      if (result.state === "not_seen") {
        if (mode === "close") throw new Error("The service did not confirm the join request.");
        setNotice("The request has not appeared yet and may still arrive. You can check again or stop it before joining.");
        return;
      }
      if (!forgetCommunityJoin(communityJoinStorage(), owner, marker)) throw new Error("The saved join request changed. Refresh before continuing.");
      setPending(null);
      await refresh();
      if (mounted.current && actor.current === owner) setNotice(outcomeMessage(result));
    } catch {
      if (!valid()) return;
      actor.current = null; epoch.current++;
      setCommunities([]); setJoined(new Set()); setInactive(new Set()); setMembershipVerified(false);
      setError("Your earlier join could not be checked. Refresh communities and try again.");
    } finally {
      joiningRef.current = false;
      if (mounted.current) setRecovering(null);
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
    <div className="my-6 flex flex-col gap-3 sm:flex-row sm:items-end">
      <label className="block min-w-0 flex-1 text-sm text-white/65">Find a community
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} maxLength={200}
          placeholder="Search by name or description" className="mt-2 block w-full rounded-xl border border-white/15 bg-white/[0.03] px-4 py-3 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white" />
      </label>
      <button type="button" disabled={loading || joining !== null || recovering !== null} onClick={() => void refresh()} className="w-full rounded-full border border-white/20 px-5 py-3 text-sm disabled:opacity-40 sm:w-auto">Refresh communities</button>
    </div>
    {error && <div role="alert" className="mb-6 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-100">{error}</div>}
    {storageError && <div role="alert" className="mb-6 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-100">{storageError}</div>}
    {notice && <div role="status" className="mb-6 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">{notice}</div>}
    {pending && <section aria-label="Earlier join request" className="mb-6 rounded-xl border border-amber-300/20 bg-amber-300/5 p-4 text-sm text-white/80">
      <p className="font-medium text-white">An earlier join needs your attention.</p>
      <p className="mt-1 leading-6 text-white/65">Check its result, or stop it if it has not been processed. Stopping does not remove an existing membership. Keep this tab open until the request is resolved.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" disabled={!actor.current || loading || joining !== null || recovering !== null} onClick={() => void recover("check")} className="rounded-full border border-white/25 px-4 py-2 disabled:opacity-40">{recovering === "check" ? "Checking…" : "Check previous request"}</button>
        <button type="button" disabled={!actor.current || loading || joining !== null || recovering !== null} onClick={() => void recover("close")} className="rounded-full border border-white/25 px-4 py-2 disabled:opacity-40">{recovering === "close" ? "Stopping…" : "Stop if not joined"}</button>
      </div>
    </section>}
    {loading ? <p role="status" className="py-12 text-white/60">Loading communities…</p> : <section aria-label="Communities" className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
      {visible.map(community => <article key={community.id} className="flex min-w-0 flex-col rounded-2xl border border-white/10 bg-white/[0.035] p-6">
        <span className="w-fit rounded-full border border-white/15 px-3 py-1 text-xs capitalize text-white/65">{community.visibility}</span>
        <h2 className="mt-5 break-words text-xl font-medium"><Link href={`/community/${encodeURIComponent(community.id)}`} className="underline-offset-4 hover:underline">{community.name}</Link></h2>
        <p className="mt-3 flex-1 whitespace-pre-wrap break-words text-sm leading-6 text-white/55">{community.description || "A space for authors to connect and discuss their work."}</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link href={`/community/${encodeURIComponent(community.id)}`} className="rounded-full border border-white/20 px-4 py-2.5 text-sm">Open discussion</Link>
          {community.visibility === "public" && <button type="button" disabled={joining !== null || recovering !== null || !membershipVerified || !storageReady || pending !== null || joined.has(community.id) || inactive.has(community.id)} onClick={() => void join(community)} className="rounded-full bg-white px-4 py-2.5 text-sm font-medium text-black disabled:opacity-50">
            {joining === community.id ? "Joining…" : !membershipVerified ? "Membership unavailable" : joined.has(community.id) ? "Joined" : inactive.has(community.id) ? "Membership inactive" : pending ? "Resolve earlier join" : !storageReady ? "Join unavailable" : "Join community"}
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
