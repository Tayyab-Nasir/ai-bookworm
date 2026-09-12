"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Community } from "@bookworm/api-client";
import { apiClient } from "./api";

export default function CommunityDirectory() {
  const api = apiClient();
  const [communities, setCommunities] = useState<Community[]>([]);
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [joined, setJoined] = useState<Set<string>>(new Set());
  const joiningRef = useRef(false);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null); setCommunities([]);
    void api.listCommunities().then(result => {
      if (live) setCommunities(result.communities);
    }).catch(reason => {
      if (live) setError(reason instanceof Error ? reason.message : "Communities could not be loaded.");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, revision]);

  async function join(community: Community) {
    if (joiningRef.current) return;
    joiningRef.current = true; setJoining(community.id); setError(null); setNotice(null);
    try {
      const result = await api.joinCommunity(community.id);
      setJoined(previous => new Set([...previous, community.id]));
      setNotice(result.alreadyMember ? `You already belong to ${community.name}.` : `You joined ${community.name}. Open the discussion to post or reply.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not join this community."); }
    finally { joiningRef.current = false; setJoining(null); }
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
      <button type="button" disabled={loading || joining !== null} onClick={() => setRevision(value => value + 1)} className="rounded-full border border-white/20 px-5 py-3 text-sm disabled:opacity-40">Refresh communities</button>
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
          {community.visibility === "public" && <button type="button" disabled={joining !== null || joined.has(community.id)} onClick={() => void join(community)} className="rounded-full bg-white px-4 py-2.5 text-sm font-medium text-black disabled:opacity-50">
            {joining === community.id ? "Joining…" : joined.has(community.id) ? "Joined" : "Join community"}
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
