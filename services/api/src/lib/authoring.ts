import { z } from "zod";
import { BookModelSchema, BookNodeSchema, type BookModel, type BookNode } from "@bookworm/book-model";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "./supabase.js";
import { requireWorkspaceEditor, requireWorkspaceMember } from "./authorize.js";
import { AppError } from "../errors.js";

export const nodesSchema = z.array(BookNodeSchema).max(20000).superRefine((nodes, ctx) => {
  const seen = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    if (seen.has(node.id)) ctx.addIssue({ code: "custom", path: [index,"id"], message: "duplicate node ID" });
    seen.add(node.id);
  }
  if (JSON.stringify(nodes).length > 4_000_000) ctx.addIssue({ code: "custom", message: "chapter exceeds 4 MB" });
});

export function parseNodes(content: unknown): BookNode[] {
  const doc = content as { nodes?: unknown; type?: string; content?: unknown[] } | null;
  if (!doc || (doc.type === "doc" && !doc.content?.length)) return [];
  const parsed = nodesSchema.safeParse(doc.nodes);
  if (!parsed.success) throw new AppError(422, "Stored chapter format is not supported. The original version has been preserved.");
  return parsed.data;
}

export async function loadBook(sb: SupabaseClient, bookId: string, userId: string, edit = false) {
  const { data: book, error } = await sb.from("books").select("*").eq("id", bookId).maybeSingle();
  if (error) throw new AppError(500, "Could not load book");
  if (!book) throw new AppError(404, "book not found");
  const role = await (edit ? requireWorkspaceEditor : requireWorkspaceMember)(sb, book.workspace_id, userId);
  return { book, role };
}

export async function loadChapter(sb: SupabaseClient, chapterId: string, userId: string, edit = false) {
  const { data: chapter, error } = await sb.from("chapters").select("*").eq("id", chapterId).maybeSingle();
  if (error) throw new AppError(500, "Could not load chapter");
  if (!chapter) throw new AppError(404, "chapter not found");
  const { book, role } = await loadBook(sb, chapter.book_id, userId, edit);
  return { chapter, book, role };
}

export async function latestVersion(sb: SupabaseClient, chapterId: string) {
  const { data, error } = await sb.from("document_versions").select("*").eq("chapter_id", chapterId)
    .order("version_number", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new AppError(500, "Could not load document version");
  return data;
}

export function rpcError(error: { code?: string; message?: string; details?: string }): never {
  if (error.code === "40001" || error.code === "23505") {
    const currentVersion = Number(error.details);
    throw new AppError(409, error.code === "40001" ? "Document changed. Reload before saving." : "This operation has already been performed.",
      Number.isFinite(currentVersion) && currentVersion > 0 ? { currentVersion } : undefined);
  }
  if (error.code === "42501") throw new AppError(403, "role cannot edit");
  if (error.code === "P0002") throw new AppError(404, "book or chapter not found");
  if (error.code === "PGRST202" || error.code === "42883") throw new AppError(503, "Authoring database migration is not installed. No manuscript changes were saved.");
  if (error.code === "22023") throw new AppError(422, error.message ?? "Invalid document");
  throw new AppError(500, "Could not persist the manuscript. No success was recorded.");
}

export async function checkAssetReferences(sb: SupabaseClient, nodes: BookNode[], workspaceId: string) {
  const ids = [...new Set(nodes.flatMap((n) => typeof n.assetId === "string" ? [n.assetId] : []))];
  if (!ids.length) return;
  const { data, error } = await sb.from("assets").select("id,checksum,storage_path").eq("workspace_id", workspaceId).is("deleted_at", null).in("id", ids);
  if (error || !data || data.length !== ids.length || data.some((asset) => asset.checksum === "pending")) {
    throw new AppError(422, "A referenced image is missing, unconfirmed, or belongs to another workspace.");
  }
  const { data: versions, error: versionError } = await sb.from("asset_versions")
    .select("asset_id,storage_path,scan_status").in("asset_id", ids);
  const safeCurrent = new Set((versions ?? [])
    .filter((version) => ["clean", "trusted_generated"].includes(String(version.scan_status)))
    .map((version) => `${version.asset_id}:${version.storage_path}`));
  if (versionError || data.some((asset) => !safeCurrent.has(`${asset.id}:${asset.storage_path}`))) {
    throw new AppError(422, "A referenced image is quarantined and cannot be attached to a manuscript.");
  }
}

export async function appendVersion(sb: SupabaseClient, chapterId: string, expectedVersion: number,
  nodes: BookNode[], operationId: string, summary: string) {
  const plainText = nodes.map((node) => node.text ?? "").filter(Boolean).join("\n\n");
  const { data, error } = await sb.rpc("append_chapter_version", {
    p_chapter_id: chapterId, p_expected_version: expectedVersion,
    p_content_json: { schemaVersion: "1.0", nodes }, p_plain_text: plainText,
    p_word_count: plainText.trim() ? plainText.trim().split(/\s+/u).length : 0,
    p_change_summary: summary, p_operation_id: operationId,
  });
  if (error) rpcError(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new AppError(500, "Document write returned no version");
  return { version: row.version_number as number, document: { chapterId, version: row.version_number as number, nodes: parseNodes(row.content_json) }, versionId: row.id as string };
}

export async function assembleBookModel(sb: SupabaseClient, book: Record<string, unknown>): Promise<BookModel> {
  const bookId = String(book.id);
  const [{ data: chapters, error: chapterError }, { data: metadata, error: metadataError }, { data: style, error: styleError }, { data: bible, error: bibleError }] = await Promise.all([
    sb.from("chapters").select("id,title,order_index").eq("book_id", bookId).order("order_index"),
    sb.from("book_metadata").select("*").eq("book_id", bookId).maybeSingle(),
    sb.from("style_guides").select("*").eq("book_id", bookId).maybeSingle(),
    sb.from("book_bible_items").select("*").eq("book_id", bookId).order("created_at"),
  ]);
  if (chapterError || metadataError || styleError || bibleError) throw new AppError(500, "Could not assemble the saved book for rendering.");

  const renderedChapters = [];
  const referencedAssets = new Set<string>();
  for (const chapter of chapters ?? []) {
    const version = await latestVersion(sb, chapter.id);
    const nodes = parseNodes(version?.content_json);
    nodes.forEach((node) => { if (typeof node.assetId === "string") referencedAssets.add(node.assetId); });
    renderedChapters.push({ id: chapter.id, title: chapter.title, order: chapter.order_index, nodes });
  }
  await checkAssetReferences(sb, renderedChapters.flatMap((chapter) => chapter.nodes), String(book.workspace_id));
  const rules = style?.rules_json as { rules?: unknown } | null;
  const sourceRefs = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return BookModelSchema.parse({
    schemaVersion: "1.0",
    bookId,
    metadata: {
      title: String(book.title),
      ...(book.subtitle ? { subtitle: String(book.subtitle) } : {}),
      author: String(book.author_name),
      language: String(book.language),
      ...(metadata?.description ? { description: metadata.description } : {}),
      keywords: Array.isArray(metadata?.keywords) ? metadata.keywords : [],
      categories: Array.isArray(metadata?.categories) ? metadata.categories : [],
      isbn13: metadata?.isbn13 ?? null,
      edition: metadata?.edition ?? null,
    },
    styleGuide: {
      ...(style?.spelling_variant ? { spellingVariant: style.spelling_variant } : {}),
      ...(style?.tone ? { tone: style.tone } : {}),
      rules: Array.isArray(rules?.rules) ? rules.rules.filter((item): item is string => typeof item === "string") : [],
    },
    bookBible: { entities: (bible ?? []).map((entry) => ({
      id: entry.id, type: entry.type, name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      attributes: entry.attributes_json ?? {},
      sourceRefs: sourceRefs(entry.source_refs_json),
      ...(entry.confidence == null ? {} : { confidence: Number(entry.confidence) }),
    })) },
    chapters: renderedChapters,
    assets: [...referencedAssets].map((id) => ({ id, role: "illustration" })),
  });
}

export function bookModelFingerprint(model: BookModel): string {
  return createHash("sha256").update(JSON.stringify(model)).digest("hex");
}
