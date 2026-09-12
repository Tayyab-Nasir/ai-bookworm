"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { CommunityPost, CommunityComment, Report } from "@bookworm/api-client";
import { apiClient } from "../../../components/api";
import { AuthorHeader } from "../../../components/AuthorShell";

const KINDS = ["like", "love", "insightful", "celebrate"] as const;

export default function CommunityDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <CommunityDiscussion key={id} id={id} />;
}

function CommunityDiscussion({ id }: { id: string }) {
  const api = apiClient();
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [comments, setComments] = useState<Record<string, CommunityComment[]>>({});
  const [commentDraft, setCommentDraft] = useState<Record<string, string>>({});
  const [queue, setQueue] = useState<Report[]>([]);
  const [showQueue, setShowQueue] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reportPost, setReportPost] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState("");
  const gate = useRef(false);
  const live = useRef(true);

  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  async function act(work: () => Promise<void>) {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError(null); setNotice(null);
    try { await work(); }
    catch (reason) { if (live.current) setError(reason instanceof Error ? reason.message : "The request could not be confirmed. Refresh before trying again."); }
    finally { gate.current = false; if (live.current) setBusy(false); }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listCommunityPosts(id);
      if (!live.current) return;
      setPosts(r.posts);
      setRole(r.role);
      setComments({});
      if (r.role !== "owner" && r.role !== "moderator") { setQueue([]); setShowQueue(false); }
    } catch (e) {
      if (live.current) { setRole(null); setPosts([]); setComments({}); setQueue([]); setShowQueue(false); setError(e instanceof Error ? e.message : "Discussion could not be loaded."); }
    } finally {
      if (live.current) setLoading(false);
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadComments = async (postId: string) => {
    const r = await api.listPostComments(postId);
    if (live.current) setComments((c) => ({ ...c, [postId]: r.comments }));
  };

  const isMod = role === "owner" || role === "moderator";

  return (
    <div className="min-h-screen bg-black pb-16">
      <AuthorHeader />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-8">
        <Link href="/community" className="mb-5 inline-block text-sm text-white/65 underline underline-offset-4">All communities</Link>
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-medium tracking-[-0.04em] text-white sm:text-4xl">Community</h1>
            <p className="mt-2 text-sm text-[#9a9a9a]">Join the conversation with fellow authors</p>
          </div>
          {isMod && (
            <button
              disabled={busy || loading}
              onClick={() => void act(async () => {
                if (showQueue) { setShowQueue(false); return; }
                const result = await api.moderationQueue();
                setQueue(result.reports); setShowQueue(true);
              })}
              className="glass-ghost metal-shine"
            >
              {showQueue ? "Hide" : "Moderation Queue"}
            </button>
          )}
        </div>

        {error && (
          <div role="alert" className="mb-6 rounded-lg border border-red-400/20 bg-red-400/10 p-4 text-red-100">
            {error}
          </div>
        )}
        {notice && <p role="status" className="mb-6 text-sm text-emerald-100">{notice}</p>}
        <button type="button" disabled={busy || loading} onClick={() => void act(load)} className="mb-6 rounded-full border border-white/20 px-4 py-2 text-sm disabled:opacity-40">Refresh discussion</button>
        {loading && <p role="status" className="mb-6 text-white/60">Loading discussion…</p>}
        {!loading && !role && !error && <p className="mb-6 text-sm text-white/60">You can read this discussion. Join from the community directory to post or reply.</p>}

        {showQueue && (
          <div className="mb-8 rounded-2xl border border-white/10 bg-white/[0.025] p-6">
            <h3 className="mb-4 text-lg font-semibold text-white">Open Reports</h3>
            <p className="mb-4 text-xs text-white/60">Reports across all communities you moderate.</p>
            {queue.length === 0 ? (
              <p className="text-[#6f6f6f]">No open reports.</p>
            ) : (
              <div className="space-y-3">
                {queue.map((r) => (
                  <div key={r.id} className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                    <p className="text-sm text-[#d8d8d8]">
                      <span className="font-medium">{r.entity_type}</span> {r.entity_id}: {r.reason}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        disabled={busy || loading}
                        onClick={() => void act(async () => {
                          await api.moderateReport(r.id, "remove");
                          setQueue((q) => q.filter((x) => x.id !== r.id));
                          setComments({}); setNotice("Reported content removed.");
                          await load();
                        })}
                        className="glass-ghost text-xs"
                      >
                        Remove
                      </button>
                      <button
                        disabled={busy || loading}
                        onClick={() => void act(async () => {
                          await api.moderateReport(r.id, "dismiss");
                          setQueue((q) => q.filter((x) => x.id !== r.id));
                          setNotice("Report dismissed.");
                        })}
                        className="glass-ghost text-xs"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {role && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!body.trim()) return;
              void act(async () => {
                const post = await api.createCommunityPost(id, { body: body.trim() });
                setPosts(previous => [post, ...previous.filter(item => item.id !== post.id)]);
                setBody(""); setNotice("Post published.");
              });
            }}
            className="mb-8 rounded-2xl border border-white/10 bg-white/[0.025] p-6"
          >
            <h3 className="mb-4 text-lg font-semibold text-white">Write a post</h3>
            <textarea
              required
              aria-label="Post text"
              maxLength={20000}
              disabled={busy || loading}
              placeholder="What's on your mind?"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="mb-4 min-h-[100px] w-full resize-y rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-[15px] text-white outline-none transition-colors duration-300 placeholder:text-[#5a5a5a] focus:border-white/30 focus-visible:ring-0"
              rows={3}
            />
            <div className="flex justify-end">
              <button type="submit" disabled={busy || loading || !body.trim()} className="glass-solid metal-shine disabled:opacity-40">
                <span className="relative z-10 px-2">Post</span>
              </button>
            </div>
          </form>
        )}

        <div className="space-y-6">
          {posts.length === 0 && !error && !loading && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-6 text-center">
              <h3 className="text-lg font-semibold text-white">No posts yet</h3>
              <p className="mt-2 text-sm text-[#6f6f6f]">Be the first to start a conversation.</p>
            </div>
          )}
          {posts.map((p) => (
            <article
              key={p.id}
              className="rounded-2xl border border-white/10 bg-white/[0.025] p-6 transition-colors duration-300 hover:border-white/20"
            >
              {p.title && <h3 className="mb-2 text-lg font-semibold text-white">{p.title}</h3>}
              {p.status !== "published" && <p className="mb-2 text-xs text-amber-100">{p.status} · visible to moderators</p>}
              <p className="mb-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-[#d8d8d8]">{p.body}</p>
              <div className="mb-4 flex items-center gap-3 text-xs text-[#6f6f6f]">
                <span>by {p.author_id.slice(0, 8)}</span>
                <span>·</span>
                <span>{new Date(p.created_at).toLocaleDateString()}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    onClick={() => void act(async () => {
                      const result = await api.toggleReaction(p.id, k);
                      setNotice(`${k} reaction ${result.active ? "added" : "removed"}.`);
                    })}
                    disabled={!role || busy || loading || p.status !== "published"}
                    className="glass-ghost text-xs capitalize"
                  >
                    {k}
                  </button>
                ))}
                <button
                  disabled={busy || loading}
                  onClick={() => { setReportPost(p.id); setReportReason(""); }}
                  className="glass-ghost text-xs"
                >
                  Report
                </button>
                <button disabled={busy || loading} onClick={() => void act(() => loadComments(p.id))} className="glass-ghost text-xs">
                  Comments
                </button>
              </div>
              {reportPost === p.id && <form className="mt-4 space-y-3" onSubmit={event => {
                event.preventDefault();
                if (!reportReason.trim()) return;
                void act(async () => {
                  await api.createReport({ entityType: "post", entityId: p.id, reason: reportReason.trim() });
                  setReportPost(null); setReportReason(""); setNotice("Report sent for moderation.");
                });
              }}>
                <label className="block text-sm">Report reason<textarea required maxLength={1000} disabled={busy} value={reportReason} onChange={event => setReportReason(event.target.value)} className="mt-2 block w-full rounded-xl border border-white/20 bg-black p-3" /></label>
                <button disabled={busy || !reportReason.trim()} className="glass-ghost text-xs">Send report</button>
                <button type="button" disabled={busy} onClick={() => setReportPost(null)} className="glass-ghost text-xs">Cancel report</button>
              </form>}
              {comments[p.id]?.length === 0 && <p className="mt-4 text-sm text-white/60">No comments yet.</p>}
              {(comments[p.id] ?? []).length > 0 && (
                <div className="mt-4 space-y-3 border-l-2 border-white/10 pl-4">
                  {(comments[p.id] ?? []).map((c) => (
                    <div key={c.id} className="text-sm">
                      <p className="whitespace-pre-wrap break-words text-[#d8d8d8]">{c.body}</p>
                      <p className="mt-1 text-xs text-[#6f6f6f]">by {c.author_id.slice(0, 8)}</p>
                    </div>
                  ))}
                </div>
              )}
              {role && p.status === "published" && (
                <form
                  className="mt-4 flex flex-wrap gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const draft = commentDraft[p.id] ?? "";
                    if (!draft.trim()) return;
                    void act(async () => {
                      const comment = await api.createPostComment(p.id, { body: draft.trim() });
                      setComments(previous => ({ ...previous, [p.id]: [...(previous[p.id] ?? []).filter(item => item.id !== comment.id), comment] }));
                      setCommentDraft((d) => ({ ...d, [p.id]: "" })); setNotice("Reply published.");
                    });
                  }}
                >
                  <input
                    placeholder="Write a comment..."
                    aria-label="Comment text"
                    maxLength={5000}
                    disabled={busy || loading}
                    value={commentDraft[p.id] ?? ""}
                    onChange={(e) => setCommentDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                    className="h-10 flex-1 rounded-full border border-white/10 bg-white/[0.04] px-5 text-sm text-white outline-none transition-colors duration-300 placeholder:text-[#5a5a5a] focus:border-white/30 focus-visible:ring-0"
                  />
                  <button type="submit" disabled={busy || loading || !(commentDraft[p.id] ?? "").trim()} className="glass-solid metal-shine text-xs disabled:opacity-40">
                    <span className="relative z-10 px-2">Reply</span>
                  </button>
                </form>
              )}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
