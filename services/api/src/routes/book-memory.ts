import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import { parseNodes } from "../lib/authoring.js";
import { requireWorkspaceEditor, requireWorkspaceMember } from "../lib/authorize.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { searchBookContext, searchSchema } from "../lib/retrieval.js";

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const editableRoles = new Set(["owner", "admin", "editor", "writer", "illustrator", "designer"]);
const sourceRef = z.object({
  chapterId: id,
  documentVersionId: id.optional(),
  nodeId: z.string().min(1).max(200).optional(),
  textHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  note: z.string().trim().max(500).optional(),
}).strict().refine((ref) => !ref.textHash || !!ref.nodeId, "A text hash needs a source node.");
const attributes = z.record(z.string().min(1).max(80), z.unknown()).superRefine((value, ctx) => {
  if (Object.keys(value).length > 40 || JSON.stringify(value).length > 24_000) {
    ctx.addIssue({ code: "custom", message: "Use at most 40 attributes and 24,000 characters." });
  }
  if (["imageAssetIds", "__proto__", "constructor", "prototype"].some((key) => Object.hasOwn(value, key))) {
    ctx.addIssue({ code: "custom", message: "Reserved attribute name. Use imageAssetIds for image links." });
  }
});
const bibleSchema = z.object({
  type: z.enum(["character", "location", "place", "organization", "fact", "object", "event", "term", "timeline", "style"]),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(12_000).default(""),
  attributes: attributes.default({}),
  imageAssetIds: z.array(id).max(20).default([]),
  sourceRefs: z.array(sourceRef).max(30).default([]),
}).strict();
const updateBibleSchema = bibleSchema.extend({ expectedUpdatedAt: timestamp });
const deleteBibleSchema = z.object({ expectedUpdatedAt: timestamp }).strict();

function isbnChecksum(value: string) {
  if (!/^(978|979)\d{10}$/.test(value)) return false;
  return [...value].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 3 : 1), 0) % 10 === 0;
}

const metadataSchema = z.object({
  expectedUpdatedAt: timestamp.nullable(),
  description: z.string().trim().max(20_000).default(""),
  keywords: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  categories: z.array(z.string().trim().min(1).max(180)).max(20).default([]),
  isbn13: z.string().refine(isbnChecksum, "Enter a valid 13-digit ISBN checksum.").nullable().default(null),
  edition: z.string().trim().max(100).nullable().default(null),
  publicationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Enter a valid calendar date.").nullable().default(null),
}).strict();

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(422, "Check the submitted fields.", { issues: result.error.issues });
  return result.data;
}

async function scopedBook(app: FastifyInstance, req: FastifyRequest, edit = false) {
  const bookId = parse(id, (req.params as { bookId: string }).bookId);
  const sb = app.supabaseFactory(req.userToken);
  const { data: book, error } = await sb.from("books").select("*").eq("id", bookId).maybeSingle();
  if (error) throw new AppError(500, "Could not load the book.");
  if (!book) throw new AppError(404, "Book not found.");
  const role = await (edit ? requireWorkspaceEditor : requireWorkspaceMember)(sb, book.workspace_id, req.userId);
  return { sb, book, bookId, role };
}

async function validateReferences(sb: SupabaseClient, bookId: string, workspaceId: string, body: z.infer<typeof bibleSchema>) {
  const imageIds = [...new Set(body.imageAssetIds)];
  if (imageIds.length) {
    const { data, error } = await sb.from("assets").select("id,mime_type,checksum,storage_path,size_bytes")
      .in("id", imageIds).eq("workspace_id", workspaceId).is("deleted_at", null);
    if (error) throw new AppError(500, "Could not verify linked images.");
    if (data?.length !== imageIds.length || (await clearedImages(sb, data)).length !== imageIds.length) {
      throw new AppError(422, "Linked images must be scan-cleared current images in this workspace. Reload and remove unavailable links.");
    }
  }
  const chapterIds = [...new Set(body.sourceRefs.map((ref) => ref.chapterId))];
  let chapters: { id: string; current_document_version_id: string | null }[] = [];
  if (chapterIds.length) {
    const { data, error } = await sb.from("chapters").select("id,current_document_version_id").eq("book_id", bookId).in("id", chapterIds);
    if (error) throw new AppError(500, "Could not verify source chapters.");
    if (data?.length !== chapterIds.length) throw new AppError(422, "Source chapters must belong to this book.");
    chapters = data;
  }
  const chapterVersions = new Map(chapters.map((chapter) => [chapter.id, chapter.current_document_version_id]));
  const versionIds = [...new Set(body.sourceRefs.flatMap((ref) => {
    const versionId = ref.documentVersionId ?? (ref.nodeId ? chapterVersions.get(ref.chapterId) : null);
    if (ref.nodeId && !versionId) throw new AppError(422, "A source node needs a saved chapter version.");
    return versionId ? [versionId] : [];
  }))];
  let versions: { id: string; chapter_id: string; content_json: unknown }[] = [];
  if (versionIds.length) {
    const { data, error } = await sb.from("document_versions").select("id,chapter_id,content_json").in("id", versionIds);
    if (error) throw new AppError(500, "Could not verify source versions.");
    versions = data ?? [];
    if (body.sourceRefs.some((ref) => ref.documentVersionId && !versions.some((version) => version.id === ref.documentVersionId && version.chapter_id === ref.chapterId))) {
      throw new AppError(422, "Each source version must belong to its referenced chapter.");
    }
  }
  const nodesByVersion = new Map<string, ReturnType<typeof parseNodes>>();
  return body.sourceRefs.map((ref) => {
    if (!ref.nodeId) return ref;
    const versionId = ref.documentVersionId ?? chapterVersions.get(ref.chapterId);
    const version = versions.find((item) => item.id === versionId && item.chapter_id === ref.chapterId);
    if (!version) throw new AppError(422, "The cited manuscript version is unavailable.");
    if (!nodesByVersion.has(version.id)) nodesByVersion.set(version.id, parseNodes(version.content_json));
    const node = nodesByVersion.get(version.id)?.find((item) => item.id === ref.nodeId);
    if (!node) throw new AppError(422, "The cited manuscript node is unavailable in that saved version.");
    const textHash = typeof node.text === "string" ? createHash("sha256").update(node.text).digest("hex") : undefined;
    if (ref.textHash && ref.textHash !== textHash) throw new AppError(422, "The cited manuscript text changed. Reload before saving this evidence.");
    return { ...ref, documentVersionId: version.id, ...(textHash ? { textHash } : {}) };
  });
}

type MemoryImage = { id: string; mime_type: string; checksum: string; storage_path: string; size_bytes: number };

// Asset completion is not scan clearance. Match the exact current version;
// an older clean version must never bless replaced or quarantined bytes.
async function clearedImages<T extends MemoryImage>(sb: SupabaseClient, assets: T[]): Promise<T[]> {
  const candidates = assets.filter((asset) => asset.mime_type?.startsWith("image/")
    && /^[a-f0-9]{64}$/.test(asset.checksum) && Number.isSafeInteger(asset.size_bytes) && asset.size_bytes > 0);
  if (!candidates.length) return [];
  const { data: versions, error } = await sb.from("asset_versions")
    .select("asset_id,storage_path,checksum,mime_type,size_bytes,scan_status").in("asset_id", candidates.map((asset) => asset.id));
  if (error) throw new AppError(500, "Could not verify image scan clearance. Try again.");
  return candidates.filter((asset) => versions?.some((version) => version.asset_id === asset.id
    && version.storage_path === asset.storage_path && version.checksum === asset.checksum
    && version.mime_type === asset.mime_type && version.size_bytes === asset.size_bytes
    && ["clean", "trusted_generated"].includes(String(version.scan_status))));
}

function bibleRow(body: z.infer<typeof bibleSchema>, sourceRefs: z.infer<typeof sourceRef>[]) {
  return {
    type: body.type,
    name: body.name,
    description: body.description || null,
    attributes_json: { ...body.attributes, imageAssetIds: [...new Set(body.imageAssetIds)] },
    source_refs_json: sourceRefs,
  };
}

function updatedTimestamp(previous: string) {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

export function bookMemoryRoutes(app: FastifyInstance) {
  app.post("/books/:bookId/bible/evidence", async (req, reply) => {
    const body = parse(z.object({ chapterId: id, documentVersionId: id,
      nodeId: z.string().min(1).max(200), textHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(), req.body);
    const { sb, bookId } = await scopedBook(app, req);
    const { data: chapter, error: chapterError } = await sb.from("chapters")
      .select("id,title,current_document_version_id").eq("id", body.chapterId).eq("book_id", bookId).maybeSingle();
    if (chapterError) throw new AppError(500, "Could not load the source chapter.");
    if (!chapter) throw new AppError(404, "Source chapter not found in this book.");
    const { data: version, error: versionError } = await sb.from("document_versions")
      .select("id,version_number,content_json").eq("id", body.documentVersionId).eq("chapter_id", chapter.id).maybeSingle();
    if (versionError) throw new AppError(500, "Could not load the cited manuscript version.");
    if (!version) throw new AppError(404, "Cited manuscript version not found.");
    const node = parseNodes(version.content_json).find((value) => value.id === body.nodeId);
    if (typeof node?.text !== "string") throw new AppError(404, "Cited text passage not found.");
    if (createHash("sha256").update(node.text).digest("hex") !== body.textHash) {
      throw new AppError(409, "This citation does not match the saved passage. Reload the candidate before using it.");
    }
    reply.header("cache-control", "private, no-store");
    return { chapterTitle: chapter.title, versionNumber: version.version_number,
      isCurrentVersion: chapter.current_document_version_id === version.id,
      text: node.text.slice(0, 24000), truncated: node.text.length > 24000 };
  });
  app.post("/books/:bookId/search", async (req) => {
    const body = parse(searchSchema, req.body);
    const { sb, bookId } = await scopedBook(app, req);
    return { results: await searchBookContext(sb, bookId, body), strategy: "postgres_full_text", query: body.query };
  });
  app.get("/books/:bookId/memory", async (req) => {
    const { sb, book, bookId, role } = await scopedBook(app, req);
    const [metadata, items, chapters, assets] = await Promise.all([
      sb.from("book_metadata").select("*").eq("book_id", bookId).maybeSingle(),
      sb.from("book_bible_items").select("*").eq("book_id", bookId).order("created_at"),
      sb.from("chapters").select("id,title,current_document_version_id").eq("book_id", bookId).order("order_index"),
      sb.from("assets").select("id,name,mime_type,checksum,status,storage_path,size_bytes").eq("workspace_id", book.workspace_id).is("deleted_at", null).order("created_at"),
    ]);
    if ([metadata, items, chapters, assets].some((result) => result.error)) throw new AppError(500, "Could not load book memory. Try again.");
    return {
      book, metadata: metadata.data, items: items.data ?? [], chapters: chapters.data ?? [],
      imageAssets: (await clearedImages(sb, assets.data ?? [])).map(({ id, name, mime_type, checksum, status }) => ({ id, name, mime_type, checksum, status })),
      canEdit: editableRoles.has(role),
    };
  });

  app.post("/books/:bookId/bible", async (req, reply) => {
    const body = parse(bibleSchema, req.body);
    const { sb, book, bookId } = await scopedBook(app, req, true);
    const sourceRefs = await validateReferences(sb, bookId, book.workspace_id, body);
    const { data, error } = await sb.from("book_bible_items").insert({ book_id: bookId, ...bibleRow(body, sourceRefs) }).select("*").single();
    if (error || !data) throw new AppError(500, "Could not save the memory entry.");
    return reply.status(201).send({ item: data });
  });

  app.put("/books/:bookId/bible/:itemId", async (req) => {
    const body = parse(updateBibleSchema, req.body);
    const itemId = parse(id, (req.params as { itemId: string }).itemId);
    const { sb, book, bookId } = await scopedBook(app, req, true);
    const sourceRefs = await validateReferences(sb, bookId, book.workspace_id, body);
    const { data, error } = await sb.from("book_bible_items")
      .update({ ...bibleRow(body, sourceRefs), updated_at: updatedTimestamp(body.expectedUpdatedAt) })
      .eq("id", itemId).eq("book_id", bookId).eq("updated_at", body.expectedUpdatedAt).select("*").maybeSingle();
    if (error) throw new AppError(500, "Could not save the memory entry.");
    if (!data) throw new AppError(409, "This entry changed or was removed. Reload before saving your changes.");
    return { item: data };
  });

  app.delete("/books/:bookId/bible/:itemId", async (req) => {
    const body = parse(deleteBibleSchema, req.body);
    const itemId = parse(id, (req.params as { itemId: string }).itemId);
    const { sb, bookId } = await scopedBook(app, req, true);
    const { data, error } = await sb.from("book_bible_items").delete()
      .eq("id", itemId).eq("book_id", bookId).eq("updated_at", body.expectedUpdatedAt).select("id").maybeSingle();
    if (error) throw new AppError(500, "Could not delete the memory entry.");
    if (!data) throw new AppError(409, "This entry changed or was removed. Reload before deleting it.");
    return { deleted: true, itemId };
  });

  app.put("/books/:bookId/metadata", async (req) => {
    const body = parse(metadataSchema, req.body);
    const { sb, bookId } = await scopedBook(app, req, true);
    const row = {
      description: body.description || null,
      keywords: [...new Set(body.keywords)],
      categories: [...new Set(body.categories)],
      isbn13: body.isbn13,
      edition: body.edition || null,
      publication_date: body.publicationDate,
    };
    // Null explicitly means the user loaded an empty record. Do not upsert:
    // another author may have created metadata since that read.
    const query = body.expectedUpdatedAt === null
      ? sb.from("book_metadata").insert({ book_id: bookId, ...row })
      : sb.from("book_metadata").update({ ...row, updated_at: updatedTimestamp(body.expectedUpdatedAt) })
        .eq("book_id", bookId).eq("updated_at", body.expectedUpdatedAt);
    const { data, error } = await query.select("*").maybeSingle();
    if (error?.code === "23505" || (!error && !data)) throw new AppError(409, "Metadata changed since you loaded it. Reload before saving.");
    if (error) throw new AppError(500, "Could not save book metadata.");
    return { metadata: data };
  });
}
