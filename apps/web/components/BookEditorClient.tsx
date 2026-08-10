"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient, ApiClientError, type DocumentOperation } from "@bookworm/api-client";
import type { Chapter } from "@bookworm/types";
import type { BookNode } from "@bookworm/book-model";
import BookTree from "./BookTree";
import RichBookEditor, { type EditorDocument, type EditorOperation } from "./RichBookEditor";
import VersionTimeline, { type VersionSummary } from "./VersionTimeline";
import CommentThread, { type Comment } from "./CommentThread";

// ponytail: API has no versions/reorder/comments endpoints yet (Step 6 spec
// lists only /v1/books, /chapters, /operations). Versions/comments are
// component-driven local state; wire endpoints when they land.
interface VersionEntry extends VersionSummary {
  nodes: BookNode[];
}

const DEMO_NODES: BookNode[] = [
  { id: "n1", type: "heading", level: 1, text: "Chapter One" },
  { id: "n2", type: "paragraph", text: "It was a bright cold day in April." },
];

const DEMO_CHAPTER: Chapter = {
  id: "demo-chapter",
  book_id: "demo-book",
  order_index: 0,
  title: "Demo chapter (offline)",
  status: "draft",
  current_document_version_id: null,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

export default function BookEditorClient({ bookId }: { bookId: string }) {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [nodesByChapter, setNodesByChapter] = useState<Record<string, BookNode[]>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const client = useCallback(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_URL;
    const token = process.env.NEXT_PUBLIC_API_TOKEN;
    return baseUrl && token ? createClient({ baseUrl, token }) : null;
  }, []);

  const load = useCallback(async () => {
    const api = client();
    if (!api) {
      // Demo/offline mode: no API configured, still render the shell.
      setChapters([DEMO_CHAPTER]);
      setNodesByChapter({ [DEMO_CHAPTER.id]: DEMO_NODES });
      setActiveId(DEMO_CHAPTER.id);
      setVersion(0);
      setVersions([
        {
          id: "v0",
          version_number: 0,
          created_by: "demo",
          change_summary: "Initial draft",
          created_at: new Date(0).toISOString(),
          plain_text: "Chapter One It was a bright cold day in April.",
          nodes: DEMO_NODES,
        },
      ]);
      return;
    }
    try {
      const { chapters: list } = await api.listChapters(bookId);
      setChapters(list);
      setActiveId((id) => id ?? list[0]?.id ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load chapters");
    }
  }, [bookId, client]);

  useEffect(() => {
    void load();
  }, [load]);

  const onOperation = useCallback(
    async (op: EditorOperation) => {
      const api = client();
      setVersions((vs) => [
        {
          id: op.operationId,
          version_number: op.expectedVersion + 1,
          created_by: "you",
          change_summary: op.type,
          created_at: new Date().toISOString(),
          nodes: nodesByChapter[op.target.chapterId] ?? [],
        },
        ...vs,
      ]);
      setVersion(op.expectedVersion + 1);
      if (!api) return; // demo mode
      try {
        const res = await api.applyOperation(op.target.chapterId, op as DocumentOperation);
        setVersion(res.version);
        setConflict(null);
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 409) {
          setConflict(`Conflict: server is at a newer version. Latest: ${JSON.stringify(e.details ?? {})}`);
          await load(); // reload latest state
        } else {
          setError(e instanceof Error ? e.message : "operation failed");
        }
      }
    },
    [client, load, nodesByChapter],
  );

  const onReorder = useCallback((orderedIds: string[]) => {
    setChapters((cs) =>
      orderedIds
        .map((id, i) => {
          const c = cs.find((x) => x.id === id);
          return c ? { ...c, order_index: i } : null;
        })
        .filter((c): c is Chapter => c !== null),
    );
    // ponytail: local-only reorder until a chapter reorder endpoint exists.
  }, []);

  const onRestore = useCallback(
    (versionId: string) => {
      const v = versions.find((x) => x.id === versionId);
      if (!v || !activeId) return;
      setNodesByChapter((m) => ({ ...m, [activeId]: v.nodes }));
      setVersion((n) => n + 1);
    },
    [versions, activeId],
  );

  const doc: EditorDocument | null = activeId
    ? { chapterId: activeId, version, nodes: nodesByChapter[activeId] ?? [] }
    : null;

  return (
    <main style={{ display: "grid", gridTemplateColumns: "240px 1fr 300px", gap: 16, padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <div>
        <BookTree chapters={chapters} activeId={activeId} onSelect={setActiveId} onReorder={onReorder} />
        <CommentThread
          comments={comments}
          currentUser="you"
          onReply={(parentId, body) =>
            setComments((cs) => [
              ...cs,
              {
                id: crypto.randomUUID(),
                nodeId: activeId ?? "",
                authorId: "you",
                body,
                resolved: false,
                createdAt: new Date().toISOString(),
                parentId,
              },
            ])
          }
          onResolve={(id, resolved) =>
            setComments((cs) => cs.map((c) => (c.id === id ? { ...c, resolved } : c)))
          }
        />
      </div>
      <section>
        {conflict && (
          <div role="alert" style={{ background: "#fff3cd", border: "1px solid #ffe08a", padding: 8, borderRadius: 4, marginBottom: 8 }}>
            {conflict} — latest content reloaded.
            <button style={{ marginLeft: 8 }} onClick={() => setConflict(null)}>Dismiss</button>
          </div>
        )}
        {error && (
          <div role="alert" style={{ background: "#f8d7da", border: "1px solid #f1aeb5", padding: 8, borderRadius: 4, marginBottom: 8 }}>
            {error}
          </div>
        )}
        {doc ? (
          <RichBookEditor document={doc} permissions="editor" onOperation={onOperation} />
        ) : (
          <p>No chapter selected.</p>
        )}
      </section>
      <VersionTimeline versions={versions} onCompare={() => {}} onRestore={onRestore} />
    </main>
  );
}
