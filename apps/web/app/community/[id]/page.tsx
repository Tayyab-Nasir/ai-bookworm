"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { CommunityPost, CommunityComment, Report } from "@bookworm/api-client";
import { apiClient } from "../../../components/api";

const KINDS = ["like", "love", "insightful", "celebrate"] as const;

export default function CommunityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = apiClient();
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [comments, setComments] = useState<Record<string, CommunityComment[]>>({});
  const [commentDraft, setCommentDraft] = useState<Record<string, string>>({});
  const [queue, setQueue] = useState<Report[]>([]);
  const [showQueue, setShowQueue] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const r = await api.listCommunityPosts(id);
      setPosts(r.posts);
      setRole(r.role);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadComments = async (postId: string) => {
    if (!api) return;
    const r = await api.listPostComments(postId);
    setComments((c) => ({ ...c, [postId]: r.comments }));
  };

  const isMod = role === "owner" || role === "moderator";

  return (
    <main style={{ padding: 16 }}>
      <h1>Community</h1>
      {error && <p role="alert" style={{ color: "#e53935" }}>{error}</p>}
      {isMod && (
        <p>
          <button
            onClick={async () => {
              setShowQueue(!showQueue);
              if (!showQueue && api) setQueue((await api.moderationQueue()).reports);
            }}
          >
            Moderation queue
          </button>
        </p>
      )}
      {showQueue && (
        <section>
          <h2>Open reports</h2>
          {queue.length === 0 && <p>None.</p>}
          <ul>
            {queue.map((r) => (
              <li key={r.id}>
                {r.entity_type} {r.entity_id}: {r.reason}{" "}
                <button onClick={async () => { await api?.moderateReport(r.id, "remove"); setQueue((q) => q.filter((x) => x.id !== r.id)); await load(); }}>Remove</button>
                <button onClick={async () => { await api?.moderateReport(r.id, "dismiss"); setQueue((q) => q.filter((x) => x.id !== r.id)); }}>Dismiss</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {role && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await api?.createCommunityPost(id, { body });
            setBody("");
            await load();
          }}
          style={{ marginBottom: 16 }}
        >
          <textarea required placeholder="Write a post..." value={body} onChange={(e) => setBody(e.target.value)} />
          <button type="submit">Post</button>
        </form>
      )}

      <ul>
        {posts.map((p) => (
          <li key={p.id} style={{ marginBottom: 16 }}>
            {p.title && <strong>{p.title} </strong>}
            {p.body}
            <div style={{ display: "flex", gap: 8 }}>
              {KINDS.map((k) => (
                <button key={k} onClick={() => api?.toggleReaction(p.id, k)} disabled={!role}>{k}</button>
              ))}
              <button
                onClick={async () => {
                  const reason = window.prompt("Report reason");
                  if (reason) await api?.createReport({ entityType: "post", entityId: p.id, reason });
                }}
              >
                Report
              </button>
              <button onClick={() => void loadComments(p.id)}>Comments</button>
            </div>
            {(comments[p.id] ?? []).map((c) => (
              <p key={c.id} style={{ marginLeft: 16 }}>{c.body}</p>
            ))}
            {role && comments[p.id] && (
              <form
                style={{ marginLeft: 16 }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  await api?.createPostComment(p.id, { body: commentDraft[p.id] ?? "" });
                  setCommentDraft((d) => ({ ...d, [p.id]: "" }));
                  await loadComments(p.id);
                }}
              >
                <input
                  placeholder="Comment..."
                  value={commentDraft[p.id] ?? ""}
                  onChange={(e) => setCommentDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                />
              </form>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
