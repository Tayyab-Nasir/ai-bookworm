import type { BookNode } from "@bookworm/book-model";
import { nodeInline, safeInline, inlineText } from "@bookworm/book-model/rich-text";
export { manuscriptTableRows, manuscriptTableHeaderRows, withTableRows } from "../lib/manuscript-table";

export interface EditorJson {
  type?: string; text?: string; attrs?: Record<string, unknown>;
  content?: EditorJson[]; marks?: { type: string }[];
}

export const LIST_NUMBER_TYPES = { decimal: "1", "lower-alpha": "a", "upper-alpha": "A", "lower-roman": "i", "upper-roman": "I" } as const;
export function listNumberStyle(value: unknown): keyof typeof LIST_NUMBER_TYPES {
  return typeof value === "string" && Object.hasOwn(LIST_NUMBER_TYPES, value) ? value as keyof typeof LIST_NUMBER_TYPES : "decimal";
}
export function listNumberStyleFromType(value: unknown): keyof typeof LIST_NUMBER_TYPES {
  return listNumberStyle(Object.entries(LIST_NUMBER_TYPES).find(([, type]) => type === value)?.[0]);
}
export function listStart(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000_000 ? value : undefined;
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
      const numberStyle = listNumberStyle(node.attributes?.listNumberStyle), start = listStart(node.attributes?.listStart);
      const reversed = node.attributes?.listReversed === true;
      lists.length = Math.min(lists.length, depth + 1);
      if (lists[depth]?.type !== listType || (listType === "orderedList" && (listNumberStyleFromType(lists[depth].attrs?.type) !== numberStyle
        || Boolean(lists[depth].attrs?.reversed) !== reversed
        || (start !== undefined && start !== Number(lists[depth].attrs?.start ?? 1) + lists[depth].content!.length * (reversed ? -1 : 1))))) {
        const list: EditorJson = { type: listType, ...(listType === "orderedList" ? { attrs: { start: start ?? 1, type: LIST_NUMBER_TYPES[numberStyle], ...(reversed ? { reversed: true } : {}) } } : {}), content: [] };
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
  const add = (block: EditorJson, listStyle?: string, listDepth = 0, numbering?: { listStart: number; listNumberStyle: string; listReversed?: boolean }) => {
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
    const attributes: Record<string, unknown> = { ...original?.attributes, richText };
    delete attributes.listStart; delete attributes.listNumberStyle;
    delete attributes.listReversed;
    delete attributes.listStyle; delete attributes.listDepth;
    if (listStyle) Object.assign(attributes, { listStyle, listDepth }, numbering);
    nodes.push({ ...original, id, type, text, ...(type === "heading" ? { level: Number(block.attrs?.level ?? 1) } : {}), attributes });
    for (const child of block.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") addList(child, listDepth + 1);
    }
  };
  const addList = (list: EditorJson, depth: number) => {
    const start = listStart(list.attrs?.start) ?? 1, numberStyle = listNumberStyleFromType(list.attrs?.type);
    const reversed = list.attrs?.reversed === true;
    for (const [index, item] of (list.content ?? []).entries()) {
      const number = start + index * (reversed ? -1 : 1);
      if (list.type === "orderedList" && (number > 1_000_000 || number < 1)) throw new RangeError("List numbering exceeds its 1–1000000 range. Change the starting number or direction before saving.");
      add(item, list.type === "orderedList" ? "ordered" : "bullet", depth,
        list.type === "orderedList" ? { listStart: number, listNumberStyle: numberStyle, ...(reversed ? { listReversed: true } : {}) } : undefined);
    }
  };
  for (const block of doc.content ?? []) {
    if (block.type === "bulletList" || block.type === "orderedList") {
      addList(block, 0);
    } else add(block);
  }
  return nodes;
}
