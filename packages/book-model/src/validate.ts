import { BookModelSchema } from "./schema.js";

export interface BookIssue {
  code: "schema_error" | "missing_title" | "duplicate_node_id" | "empty_chapter";
  message: string;
  chapterId?: string;
  nodeId?: string;
}

export interface BookValidation {
  valid: boolean;
  issues: BookIssue[];
}

export function validateBookModel(json: unknown): BookValidation {
  const parsed = BookModelSchema.safeParse(json);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((i) => ({
        code: "schema_error" as const,
        message: `${i.path.join(".")}: ${i.message}`,
      })),
    };
  }
  const book = parsed.data;
  const issues: BookIssue[] = [];

  if (!book.metadata.title.trim())
    issues.push({ code: "missing_title", message: "metadata.title is blank" });

  const seen = new Set<string>();
  for (const chapter of book.chapters) {
    if (chapter.nodes.length === 0)
      issues.push({
        code: "empty_chapter",
        message: `chapter "${chapter.title}" has no nodes`,
        chapterId: chapter.id,
      });
    for (const node of chapter.nodes) {
      if (seen.has(node.id))
        issues.push({
          code: "duplicate_node_id",
          message: `duplicate node id ${node.id}`,
          chapterId: chapter.id,
          nodeId: node.id,
        });
      seen.add(node.id);
    }
  }

  return { valid: issues.length === 0, issues };
}
