"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";
import type { Chapter as ModelChapter, BookNode } from "@bookworm/book-model";

export type EditorPermission = "editor" | "viewer";

export interface EditorDocument {
  chapterId: string;
  version: number;
  nodes: BookNode[];
}

export interface EditorOperation {
  operationId: string;
  type: string;
  target: { chapterId: string; nodeId: string };
  payload: Record<string, unknown>;
  source: "human";
  expectedVersion: number;
}

export interface RichBookEditorProps {
  document: EditorDocument;
  selection?: { nodeId: string } | null;
  permissions: EditorPermission;
  onOperation: (op: EditorOperation) => void;
}

const PM_TYPES: Record<string, string> = {
  paragraph: "paragraph",
  heading: "heading",
  quote: "blockquote",
  listItem: "listItem",
};

function nodeToPm(node: BookNode): Record<string, unknown> {
  const pm: Record<string, unknown> = {
    type: PM_TYPES[node.type] ?? "paragraph",
    attrs: { nodeId: node.id, ...(node.type === "heading" ? { level: node.level ?? 1 } : {}) },
  };
  if (node.text) pm.content = [{ type: "text", text: node.text }];
  return pm;
}

export function chapterToPmDoc(chapter: ModelChapter) {
  return { type: "doc", content: chapter.nodes.map(nodeToPm) };
}

// ponytail: whole-node replace_text per updated block. Fine-grained
// insert/delete range diffs can come later if op volume matters.
export default function RichBookEditor({ document, permissions, onOperation }: RichBookEditorProps) {
  const lastVersion = useRef(document.version);
  const prevTexts = useRef(new Map<string, string>());

  const editor = useEditor({
    extensions: [StarterKit],
    editable: permissions === "editor",
    immediatelyRender: false,
    content: { type: "doc", content: document.nodes.map(nodeToPm) },
    onUpdate({ editor: e }) {
      e.state.doc.descendants((n, _pos) => {
        const nodeId = (n.attrs as { nodeId?: string }).nodeId;
        if (!nodeId) return false; // top-level blocks only
        const text = n.textBetween(0, n.content.size);
        const prev = prevTexts.current.get(nodeId);
        if (prev !== undefined && prev !== text) {
          onOperation({
            operationId: crypto.randomUUID(),
            type: "replace_text",
            target: { chapterId: document.chapterId, nodeId },
            payload: { nodeId, from: 0, to: prev.length, text },
            source: "human",
            expectedVersion: lastVersion.current,
          });
          prevTexts.current.set(nodeId, text);
        }
        return false;
      });
    },
  });

  // Re-init when the chapter changes or after a conflict-triggered reload.
  useEffect(() => {
    if (!editor) return;
    lastVersion.current = document.version;
    prevTexts.current = new Map(document.nodes.map((n) => [n.id, n.text ?? ""]));
    editor.commands.setContent({ type: "doc", content: document.nodes.map(nodeToPm) });
  }, [editor, document.chapterId, document.version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    editor?.setEditable(permissions === "editor");
  }, [editor, permissions]);

  return (
    <div style={{ border: "1px solid #ccc", borderRadius: 6, padding: 16, minHeight: 300 }}>
      {permissions === "viewer" && <p style={{ color: "#777", fontSize: 13 }}>Read-only (viewer role)</p>}
      <EditorContent editor={editor} />
    </div>
  );
}
