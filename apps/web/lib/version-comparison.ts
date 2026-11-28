import { BookNodeSchema, type BookNode } from "@bookworm/book-model/schema";
import type { DocumentVersionSnapshot } from "@bookworm/api-client";

export interface RevisionText { id: string; version_number: number; plain_text?: string | null }
export interface TextChange { kind: "same" | "add" | "del"; text: string }
/** Preserve every character while bounding quadratic work and DOM output. */
export function compareRevisionText(first: RevisionText, second: RevisionText) {
  const [before, after] = [first, second].sort((a, b) => a.version_number - b.version_number);
  if (typeof before.plain_text !== "string" || typeof after.plain_text !== "string") return null;
  const a = before.plain_text, b = after.plain_text;
  const changes: TextChange[] = [];
  const push = (kind: TextChange["kind"], text: string) => {
    if (!text) return;
    const previous = changes.at(-1);
    if (previous?.kind === kind) previous.text += text; else changes.push({ kind, text });
  };
  if (a === b) return { before, after, changes: [{ kind: "same" as const, text: a }], mode: "exact" as const, identical: true };
  const left = a.match(/\s+|\S+/gu) ?? [], right = b.match(/\s+|\S+/gu) ?? [];
  if ((left.length + 1) * (right.length + 1) > 500_000) return { before, after, changes: [{ kind: "del" as const, text: a }, { kind: "add" as const, text: b }], mode: "full" as const, identical: false };
  const width = right.length + 1, table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { push("same", left[i++]); j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) push("del", left[i++]);
    else push("add", right[j++]);
  }
  while (i < left.length) push("del", left[i++]);
  while (j < right.length) push("add", right[j++]);
  return { before, after, changes, mode: "exact" as const, identical: false };
}

export interface BlockChange {
  id: string; before?: BookNode; after?: BookNode; beforePosition?: number; afterPosition?: number;
  kind: "added" | "removed" | "changed" | "moved"; fields: string[]; moved: boolean;
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) ?? "(missing)";
}

/** Canonical blocks, including unknown schema extensions; insertion is not a move. */
export function compareRevisionBlocks(before: BookNode[], after: BookNode[]) {
  const left = new Map(before.map((node, index) => [node.id, { node, index }]));
  const right = new Map(after.map((node, index) => [node.id, { node, index }]));
  if (left.size !== before.length || right.size !== after.length) throw new Error("Saved revision contains duplicate block IDs.");
  const commonLeft = new Map(before.filter(node => right.has(node.id)).map((node, index) => [node.id, index]));
  const commonRight = new Map(after.filter(node => left.has(node.id)).map((node, index) => [node.id, index]));
  const changes: BlockChange[] = [];
  for (const [id, previous] of left) {
    const next = right.get(id);
    if (!next) { changes.push({ id, before: previous.node, beforePosition: previous.index + 1, kind: "removed", fields: [], moved: false }); continue; }
    const fields = [...new Set([...Object.keys(previous.node), ...Object.keys(next.node)])]
      .filter(key => key !== "id" && stable(previous.node[key]) !== stable(next.node[key])).sort();
    const moved = commonLeft.get(id) !== commonRight.get(id);
    if (fields.length || moved) changes.push({ id, before: previous.node, after: next.node,
      beforePosition: previous.index + 1, afterPosition: next.index + 1, kind: fields.length ? "changed" : "moved", fields, moved });
  }
  for (const [id, next] of right) if (!left.has(id)) changes.push({ id, after: next.node,
    afterPosition: next.index + 1, kind: "added", fields: [], moved: false });
  return { changes, identical: changes.length === 0,
    added: changes.filter(change => change.kind === "added").length,
    removed: changes.filter(change => change.kind === "removed").length,
    changed: changes.filter(change => change.kind === "changed").length,
    moved: changes.filter(change => change.moved).length };
}

/** Revalidate transport data before showing it under a chapter/version label. */
export function readRevisionSnapshot(value: DocumentVersionSnapshot, chapterId: string, expected: RevisionText): BookNode[] {
  if (!value || value.version?.id !== expected.id || value.version?.chapter_id !== chapterId
    || value.version?.version_number !== expected.version_number || value.document?.chapterId !== chapterId
    || value.document?.version !== expected.version_number) throw new Error("Saved revision identity did not match this chapter. Reload its history.");
  const parsed = BookNodeSchema.array().max(20000).safeParse(value.document.nodes);
  if (!parsed.success || new Set(parsed.data.map(node => node.id)).size !== parsed.data.length)
    throw new Error("Saved revision format is unavailable. Its original content has not been changed.");
  return parsed.data;
}
