import type { BookNode } from "./schema.js";

export type InlineRun = { type: "hardBreak" } | { type: "text"; text: string; marks?: { type: string }[] };
const MARKS = new Set(["bold", "italic", "strike", "code", "underline"]);

export function safeInline(value: unknown): InlineRun[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part): InlineRun[] => {
    if (!part || typeof part !== "object") return [];
    if (part.type === "hardBreak") return [{ type: "hardBreak" }];
    if (part.type !== "text" || typeof part.text !== "string" || !part.text) return [];
    const marks = Array.isArray(part.marks)
      ? [...new Set<string>(part.marks.filter((m: unknown): m is { type: string } => !!m && typeof m === "object" && "type" in m && typeof m.type === "string" && MARKS.has(m.type)).map((m: { type: string }) => m.type))].map((type) => ({ type }))
      : [];
    return [{ type: "text", text: part.text, marks }];
  });
}

export const inlineText = (runs: InlineRun[]): string => runs.map((part) => part.type === "hardBreak" ? "\n" : part.text).join("");

export function nodeInline(node: Pick<BookNode, "text" | "attributes">): InlineRun[] {
  const text = node.text ?? "";
  const stored = safeInline(node.attributes?.richText);
  // Older clients and imports can update text without updating formatting.
  // Canonical text wins; stale runs must never hide an accepted edit.
  if (inlineText(stored) === text) return stored;
  return text.split("\n").flatMap((line, index): InlineRun[] => [
    ...(index ? [{ type: "hardBreak" } as const] : []),
    ...(line ? [{ type: "text", text: line } as const] : []),
  ]);
}

export function replaceNodeText(node: BookNode, from: number, to: number, replacement: string): BookNode {
  const runs = nodeInline(node);
  let offset = 0;
  const slice = (start: number, end: number): InlineRun[] => {
    offset = 0;
    return runs.flatMap((run): InlineRun[] => {
      const text = run.type === "hardBreak" ? "\n" : run.text;
      const value = text.slice(Math.max(0, start - offset), Math.max(0, end - offset));
      offset += text.length;
      return !value ? [] : run.type === "hardBreak" ? [run] : [{ ...run, text: value }];
    });
  };
  const before = slice(0, from);
  const after = slice(to, (node.text ?? "").length);
  offset = 0;
  const anchor = runs.find((run) => {
    offset += run.type === "hardBreak" ? 1 : run.text.length;
    return offset > from;
  }) ?? runs.at(-1);
  const inserted = nodeInline({ text: replacement }).map((run) => run.type === "text" && anchor?.type === "text" ? { ...run, marks: anchor.marks } : run);
  const richText = [...before, ...inserted, ...after];
  return { ...node, text: inlineText(richText), attributes: { ...node.attributes, richText } };
}
