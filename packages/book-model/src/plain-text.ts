import type { BookNode } from "./schema.js";

/** Reading text in canonical block order; formatting and accessibility descriptions stay in the model. */
export function bookNodesPlainText(nodes: readonly BookNode[]): string {
  return nodes.flatMap((node) => {
    // Explicit text is authoritative, including an empty string. Older clients
    // may retain a table grid or rich-text runs after editing that text.
    const text = node.text ?? (node.type === "table" && node.rows
      ? node.rows.map((row) => row.join("\t")).join("\n") : "");
    const caption = node.type === "image" ? node.caption ?? "" : "";
    return [text, ...(caption && caption !== text ? [caption] : [])];
  }).filter((text) => text !== "").join("\n\n");
}

export function bookNodesWordCount(nodes: readonly BookNode[]): number {
  const text = bookNodesPlainText(nodes).trim();
  return text ? text.split(/\s+/u).length : 0;
}
