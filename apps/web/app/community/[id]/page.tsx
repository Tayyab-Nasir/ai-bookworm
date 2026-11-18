"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ApiClientError, type CommunityPost, type CommunityComment, type CommunityModerationReport } from "@bookworm/api-client";
import { apiClient } from "../../../components/api";
import { AuthorHeader } from "../../../components/AuthorShell";
import { readBrowserSession } from "../../../lib/browser-session";

const KINDS = ["like", "love", "insightful", "celebrate"] as const;
type DiscussionClient = ReturnType<typeof apiClient>;
type DiscussionScope = { actor: string };
type Confirmation = { message: string; reopenQueue?: boolean };
type ReportPage = Awaited<ReturnType<DiscussionClient["moderationQueue"]>>;
type OpenReports = Pick<ReportPage, "reports" | "hasMore"> & { nextOffset: number };

function canModerate(role: string | null) {
  return role === "owner" || role === "moderator";
}

function mergeReports(page: ReportPage, previous?: OpenReports | null): OpenReports {
  return {
    reports: previous ? [...previous.reports, ...page.reports.filter(row => !previous.reports.some(saved => saved.id === row.id))] : page.reports,
    hasMore: page.hasMore,
    nextOffset: page.offset + page.reports.length,
  };
}

export default function CommunityDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <CommunityDiscussion key={id} id={id} />;
}

function CommunityDiscussion({ id }: { id: string }) {
  const [view, setView] = useState<{ scope: DiscussionScope; posts: CommunityPost[]; role: string | null } | null>(null);
  const [body, setBody] = useState("");
  const [comments, setComments] = useState<Record<string, CommunityComment[]>>({});
  const [commentDraft, setCommentDraft] = useState<Record<string, string>>({});
  const [queue, setQueue] = useState<OpenReports | null>(null);
  const [review, setReview] = useState<{ report: CommunityModerationReport; action: "remove" | "dismiss" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reportPost, setReportPost] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState("");
  const actionInFlight = useRef<symbol | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const activeScope = useRef<DiscussionScope | null>(null);
  const draftOwner = useRef<DiscussionScope | null>(null);

  const load = useCallback(async (confirmed?: Confirmation & { owner: DiscussionScope }) => {
    const ticket = ++generation.current;
    const current = () => mounted.current && generation.current === ticket;
    activeScope.current = null;
    setView(null);
    setLoading(true);
    setError(null);
    setNotice(null);
    setComments({});
    setQueue(null);
    setReview(null);
    try {
      const { id: actor } = await readBrowserSession();
      if (!current()) return;
      if (draftOwner.current?.actor !== actor) {
        draftOwner.current = { actor };
        actionInFlight.current = null;
        setBusy(false);
        setBody("");
        setCommentDraft({});
        setReportPost(null);
        setReportReason("");
      }
      const api = apiClient(actor);
      const result = await api.listCommunityPosts(id);
      if (!current()) return;
      const confirmation = confirmed?.owner === draftOwner.current ? confirmed : undefined;
      const reopenQueue = confirmation?.reopenQueue && canModerate(result.role);
      const reports = reopenQueue ? await api.moderationQueue({ limit: 50, offset: 0 }).catch(() => null) : null;
      if (!current()) return;
      await readBrowserSession(actor);
      if (!current()) return;

      const scope = { actor };
      activeScope.current = scope;
      setView({ scope, posts: result.posts, role: result.role });
      setNotice(confirmation?.message ?? null);
      if (reports) setQueue(mergeReports(reports));
      else if (reopenQueue) setError("The decision was saved. Open the moderation queue again to refresh reports.");
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : "Discussion could not be loaded.");
    } finally {
      if (current()) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const verify = () => { if (document.visibilityState !== "hidden") void load(); };
    window.addEventListener("focus", verify);
    document.addEventListener("visibilitychange", verify);
    return () => {
      mounted.current = false;
      generation.current++;
      activeScope.current = null;
      window.removeEventListener("focus", verify);
      document.removeEventListener("visibilitychange", verify);
    };
  }, [load]);

  async function act<T>(
    kind: "read" | "write",
    request: (api: DiscussionClient) => Promise<T>,
    apply: (result: T, scope: DiscussionScope) => Confirmation | void,
  ) {
    const scope = view?.scope;
    const owner = draftOwner.current;
    if (!scope || !owner || activeScope.current !== scope || actionInFlight.current) return;
    const current = () => activeScope.current === scope;
    // A confirmed write can clear its original draft after a same-account
    // refresh. Older reads and results from a replaced account stay hidden.
    const ownsReply = () => current() || (kind === "write" && mounted.current && draftOwner.current === owner);
    const action = Symbol();
    actionInFlight.current = action;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await readBrowserSession(scope.actor);
      if (!current()) return;
      const [reply] = await Promise.allSettled([request(apiClient(scope.actor))]);
      if (!ownsReply()) return;
      await readBrowserSession(scope.actor);
      if (!ownsReply()) return;
      if (reply.status === "fulfilled") {
        const confirmation = apply(reply.value, scope);
        if (confirmation) {
          if (!current() || confirmation.reopenQueue) void load({ ...confirmation, owner });
          else setNotice(confirmation.message);
        }
      } else {
        const reason: unknown = reply.reason;
        if (reason instanceof ApiClientError && (reason.status === 401 || reason.status === 403)) void load();
        setError(reason instanceof Error ? reason.message : "The request could not be confirmed. Refresh before trying again.");
      }
    } catch {
      if (current()) void load();
    } finally {
      if (actionInFlight.current === action) {
        actionInFlight.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }

  function loadQueue(offset = 0) {
    void act("read", api => api.moderationQueue({ limit: 50, offset }), result => {
      setQueue(previous => mergeReports(result, offset ? previous : null));
      setReview(null);
    });
  }

  const posts = view?.posts ?? [];
  const role = view?.role ?? null;
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
          {canModerate(role) && (
            <button
              disabled={busy || loading}
              onClick={() => {
                if (queue) { setQueue(null); setReview(null); }
                else loadQueue();
              }}
              className="glass-ghost metal-shine"
            >
              {queue ? "Hide" : "Moderation Queue"}
            </button>
          )}
        </div>

        {error && (
          <div role="alert" className="mb-6 rounded-lg border border-red-400/20 bg-red-400/10 p-4 text-red-100">
            {error}
          </div>
        )}
        {notice && <p role="status" className="mb-6 text-sm text-emerald-100">{notice}</p>}
        <button type="button" disabled={loading || (busy && view !== null)} onClick={() => void load()} className="mb-6 rounded-full border border-white/20 px-4 py-2 text-sm disabled:opacity-40">Refresh discussion</button>
        {loading && <p role="status" className="mb-6 text-white/60">Loading discussion…</p>}
        {view && !role && !error && <p className="mb-6 text-sm text-white/60">You can read this discussion. Join from the community directory to post or reply.</p>}

        {queue && (
          <div className="mb-8 rounded-2xl border border-white/10 bg-white/[0.025] p-6">
            <h3 className="mb-4 text-lg font-semibold text-white">Open Reports</h3>
            <p className="mb-4 text-xs text-white/60">Reports across all communities you moderate.</p>
            <button type="button" disabled={busy || loading} onClick={() => loadQueue()} className="mb-4 glass-ghost text-xs">Refresh reports</button>
            {queue.reports.length === 0 ? (
              <p className="text-[#6f6f6f]">No open reports.</p>
            ) : (
              <div className="space-y-3">
                {queue.reports.map((r) => (
                  <div key={r.id} className="rounded-lg border border-white/10 bg-white/[0.04] p-4 break-words">
                    <p className="text-sm text-[#d8d8d8]">
                      <span className="font-medium">{r.entity_type}</span> {r.entity_id}: {r.reason}
                    </p>
                    {r.target && <div className="mt-3 space-y-2 text-sm text-white/75">
                      <p>{r.target.communityName ?? "Community"}: {r.target.type === "post" ? r.target.title ?? "Reported post" : "Reported reply"}</p>
                      <blockquote className="max-h-36 overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 p-3">{r.target.body}</blockquote>
                      {r.target.type === "comment" && r.target.parentBody && <details><summary>Parent post context</summary><p className="whitespace-pre-wrap mt-2">{r.target.parentBody}</p></details>}
                    </div>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        disabled={busy || loading}
                        onClick={() => setReview({ report: r, action: "remove" })}
                        className="glass-ghost text-xs"
                      >
                        Remove
                      </button>
                      <button
                        disabled={busy || loading}
                        onClick={() => setReview({ report: r, action: "dismiss" })}
                        className="glass-ghost text-xs"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {queue.hasMore && <button type="button" disabled={busy || loading} onClick={() => loadQueue(queue.nextOffset)} className="mt-4 glass-ghost text-xs">Load more reports</button>}
            {review && <section aria-label="Review moderation decision" className="mt-5 rounded-xl border border-amber-200/30 bg-amber-200/5 p-4 space-y-3">
              <h4 className="font-medium text-white">Confirm {review.action === "remove" ? "removal" : "dismissal"}</h4>
              <p className="text-sm text-white/75 break-words">{review.report.reason}</p>
              <p className="text-xs text-white/60">{review.action === "remove" ? "This soft-hides the reported content and preserves its audit history." : "This closes the report without removing the content."} The first saved decision cannot be replaced by a retry.</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => setReview(null)} className="glass-ghost text-xs">Cancel</button>
                <button type="button" disabled={busy || loading} onClick={() => {
                  const decision = review;
                  setReview(null);
                  void act("write", api => api.moderateReport(decision.report.id, decision.action), result => {
                    const message = result.alreadyResolved ? "Original moderation decision recovered." : result.status === "actioned" ? "Reported content removed." : "Report dismissed.";
                    return { message, reopenQueue: true };
                  });
                }} className="glass-solid text-xs">Confirm {review.action === "remove" ? "removal" : "dismissal"}</button>
              </div>
            </section>}
          </div>
        )}

        {role && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!body.trim()) return;
              void act("write", api => api.createCommunityPost(id, { body: body.trim() }), (post, scope) => {
                setView(previous => previous?.scope === scope
                  ? { ...previous, posts: [post, ...previous.posts.filter(item => item.id !== post.id)] } : previous);
                setBody("");
                return { message: "Post published." };
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
          {view && posts.length === 0 && !error && (
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
                    onClick={() => void act("write", api => api.toggleReaction(p.id, k), result => ({
                      message: `${k} reaction ${result.active ? "added" : "removed"}.`,
                    }))}
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
                <button disabled={busy || loading} onClick={() => void act("read", api => api.listPostComments(p.id), result => {
                  setComments(previous => ({ ...previous, [p.id]: result.comments }));
                })} className="glass-ghost text-xs">
                  Comments
                </button>
              </div>
              {reportPost === p.id && <form className="mt-4 space-y-3" onSubmit={event => {
                event.preventDefault();
                if (!reportReason.trim()) return;
                void act("write", api => api.createReport({ entityType: "post", entityId: p.id, reason: reportReason.trim() }), () => {
                  setReportPost(null);
                  setReportReason("");
                  return { message: "Report sent for moderation." };
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
                    void act("write", api => api.createPostComment(p.id, { body: draft.trim() }), comment => {
                      setComments(previous => ({ ...previous, [p.id]: [...(previous[p.id] ?? []).filter(item => item.id !== comment.id), comment] }));
                      setCommentDraft(d => ({ ...d, [p.id]: "" }));
                      return { message: "Reply published." };
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
