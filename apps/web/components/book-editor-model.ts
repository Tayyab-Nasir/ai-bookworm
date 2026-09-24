import type { BookNode } from "@bookworm/book-model";
import { nodeInline, safeInline, inlineText } from "@bookworm/book-model/rich-text";

export interface EditorJson {
  type?: string; text?: string; attrs?: Record<string, unknown>;
  content?: EditorJson[]; marks?: { type: string }[];
}

export function manuscriptTableRows(node: BookNode): string[][] | null {
  const rows = node.rows;
  if (!Array.isArray(rows) || !rows.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) return null;
  return node.text === undefined || node.text === rows.map((row) => row.join("\t")).join("\n") ? rows : null;
}

export function manuscriptTableHeaderRows(node: BookNode): number {
  const rows = manuscriptTableRows(node);
  const count = node.attributes?.tableHeaderRows;
  return rows && typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= rows.length ? count : 0;
}

export function withTableRows(node: BookNode, rows: string[][]): BookNode {
  const { richText: _stale, ...attributes } = node.attributes ?? {};
  return { ...node, rows, text: rows.map((row) => row.join("\t")).join("\n"), attributes };
}

export function nodesToEditor(nodes: BookNode[]): EditorJson {
  const content: EditorJson[] = [];
  const lists: EditorJson[] = [];
  for (const node of nodes) {
    const attrs = { nodeId: node.id, canonical: node };
    if (node.type !== "listItem") lists.length = 0;
    if (node.type === "paragraph" || node.type === "caption" || node.type === "footnote") {
      content.push({ type: "paragraph", attrs, content: nodeInline(node) });
    } else if (node.type === "heading") {
      content.push({ type: "heading", attrs: { ...attrs, level: node.level ?? 1 }, content: nodeInline(node) });
    } else if (node.type === "quote") {
      content.push({ type: "blockquote", attrs, content: [{ type: "paragraph", content: nodeInline(node) }] });
    } else if (node.type === "listItem") {
      const listType = node.attributes?.listStyle === "ordered" ? "orderedList" : "bulletList";
      const depth = Math.min(Math.max(0, Math.floor(Number(node.attributes?.listDepth) || 0)), lists.length, 6);
      lists.length = Math.min(lists.length, depth + 1);
      if (lists[depth]?.type !== listType) {
        const list: EditorJson = { type: listType, content: [] };
        if (depth) lists[depth - 1].content!.at(-1)!.content!.push(list);
        else content.push(list);
        lists[depth] = list;
      }
      lists[depth].content!.push({ type: "listItem", attrs, content: [{ type: "paragraph", content: nodeInline(node) }] });
    } else {
      // Complex/imported nodes remain intact until their dedicated editor is used.
      content.push({ type: "preservedBlock", attrs });
    }
  }
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

export function editorToNodes(doc: EditorJson, makeId: () => string): BookNode[] {
  const nodes: BookNode[] = [];
  const seen = new Set<string>();
  const add = (block: EditorJson, listStyle?: string, listDepth = 0) => {
    const original = block.attrs?.canonical as BookNode | undefined;
    let id = typeof block.attrs?.nodeId === "string" ? block.attrs.nodeId : makeId();
    if (seen.has(id)) id = makeId();
    seen.add(id);
    if (block.type === "preservedBlock" && original) { nodes.push({ ...original, id }); return; }
    const contents = (block.type === "blockquote" || block.type === "listItem")
      ? (block.content ?? []).filter((child) => child.type !== "bulletList" && child.type !== "orderedList").flatMap((child, i) => [...(i ? [{ type: "hardBreak" }] : []), ...(child.content ?? [])]) : (block.content ?? []);
    const richText = safeInline(contents);
    const text = inlineText(richText);
    const type = block.type === "heading" ? "heading" : block.type === "blockquote" ? "quote" : block.type === "listItem" ? "listItem"
      : original && ["caption","footnote"].includes(original.type) ? original.type : "paragraph";
    nodes.push({ ...original, id, type, text, ...(type === "heading" ? { level: Number(block.attrs?.level ?? 1) } : {}),
      attributes: { ...original?.attributes, richText, ...(listStyle ? { listStyle, listDepth } : {}) } });
    for (const child of block.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") addList(child, listDepth + 1);
    }
  };
  const addList = (list: EditorJson, depth: number) => {
    for (const item of list.content ?? []) add(item, list.type === "orderedList" ? "ordered" : "bullet", depth);
  };
  for (const block of doc.content ?? []) {
    if (block.type === "bulletList" || block.type === "orderedList") {
      addList(block, 0);
    } else add(block);
  }
  return nodes;
}
