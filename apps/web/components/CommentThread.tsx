"use client";

import { useState } from "react";

export interface Comment {
  id: string;
  nodeId: string;
  authorId: string;
  body: string;
  resolved: boolean;
  createdAt: string;
  parentId?: string | null;
}

export interface CommentThreadProps {
  comments: Comment[];
  currentUser: string;
  onReply: (parentId: string, body: string) => void;
  onResolve: (commentId: string, resolved: boolean) => void;
}

export default function CommentThread({ comments, currentUser, onReply, onResolve }: CommentThreadProps) {
  const roots = comments.filter((c) => !c.parentId);
  const replies = (id: string) => comments.filter((c) => c.parentId === id);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  return (
    <aside aria-label="Comments" style={{ padding: 8 }}>
      <h3 style={{ margin: "4px 8px" }}>Comments</h3>
      {roots.length === 0 && <p style={{ padding: "0 8px", color: "#777" }}>No comments yet.</p>}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {roots.map((c) => (
          <li
            key={c.id}
            style={{
              margin: "4px 8px",
              padding: 8,
              border: "1px solid #eee",
              borderRadius: 4,
              opacity: c.resolved ? 0.55 : 1,
            }}
          >
            <small>
              <strong>{c.authorId}</strong> · {new Date(c.createdAt).toLocaleString()} · node {c.nodeId}
              {c.resolved && " · resolved"}
            </small>
            <p style={{ margin: "4px 0" }}>{c.body}</p>
            <ul style={{ listStyle: "none", paddingLeft: 12 }}>
              {replies(c.id).map((r) => (
                <li key={r.id} style={{ borderLeft: "2px solid #eee", paddingLeft: 8, margin: "4px 0" }}>
                  <small>
                    <strong>{r.authorId}</strong> · {new Date(r.createdAt).toLocaleString()}
                  </small>
                  <p style={{ margin: "2px 0" }}>{r.body}</p>
                </li>
              ))}
            </ul>
            <div style={{ display: "flex", gap: 4 }}>
              <input
                aria-label="Reply"
                placeholder={`Reply as ${currentUser}`}
                value={drafts[c.id] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                style={{ flex: 1 }}
              />
              <button
                disabled={!drafts[c.id]?.trim()}
                onClick={() => {
                  onReply(c.id, drafts[c.id].trim());
                  setDrafts((d) => ({ ...d, [c.id]: "" }));
                }}
              >
                Reply
              </button>
              <button onClick={() => onResolve(c.id, !c.resolved)}>
                {c.resolved ? "Reopen" : "Resolve"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
