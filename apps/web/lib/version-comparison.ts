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
