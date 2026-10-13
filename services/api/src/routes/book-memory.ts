import type { FastifyInstance, FastifyRequest, onSendHookHandler } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { BookMetadataSchema } from "@bookworm/book-model";
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
  requestId: id,
  type: z.enum(["character", "location", "place", "organization", "fact", "object", "event", "term", "timeline", "style"]),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(12_000).default(""),
  attributes: attributes.default({}),
  imageAssetIds: z.array(id).max(20).default([]),
  sourceRefs: z.array(sourceRef).max(30).default([]),
}).strict();
const updateBibleSchema = bibleSchema.extend({ expectedUpdatedAt: timestamp, expectedIncarnationId: id });
const deleteBibleSchema = z.object({ requestId: id, expectedUpdatedAt: timestamp, expectedIncarnationId: id }).strict();

const bibleItemSchema = z.object({
  id, book_id: id, mutation_incarnation_id: id, type: bibleSchema.shape.type, name: z.string().min(1).max(160),
  description: z.string().max(12_000).nullable(), attributes_json: z.record(z.unknown()),
  confidence: z.number().finite().nullable(),
  source_refs_json: z.array(sourceRef).max(30), created_at: timestamp, updated_at: timestamp,
}).passthrough();
const receiptSchema = z.object({ requestId: id, bookId: id, action: z.enum(["create", "update", "delete"]), itemId: id,
  intentHash: z.string().regex(/^[a-f0-9]{64}$/u), resultHash: z.string().regex(/^[a-f0-9]{64}$/u),
  resultUpdatedAt: timestamp, committedAt: timestamp }).strict();
const closureSchema = z.object({ requestId: id, bookId: id, closedAt: timestamp }).strict();
const mutationResultSchema = z.object({ receipt: receiptSchema.nullable(), disposition: z.enum(["unchanged", "changed", "deleted"]).nullable(),
  item: bibleItemSchema.nullable(), replayed: z.boolean(), closed: z.boolean().default(false), closure: closureSchema.nullable().default(null) }).strict();
const privateMutationResponse: onSendHookHandler = async (_req, reply, payload) => {
  reply.header("cache-control", "private, no-store"); return payload;
};
function requireMutationActor(req: FastifyRequest) {
  const actor = parse(id, req.headers["x-bookworm-actor"]);
  if (actor !== req.userId) throw new AppError(409, "The signed-in account changed. Use the original author's account to recover or retry this Book Bible request.", undefined, "book_bible_actor_changed");
}

function mutationError(error: { code?: string }): never {
  if (error.code === "42501") throw new AppError(403, "Current editing access is required for this Book Bible request.");
  if (error.code === "P0002") throw new AppError(404, "Book not found.");
  if (error.code === "22023") throw new AppError(422, "Check the saved Book Bible fields, images and source references.");
  if (error.code === "40001") throw new AppError(409, "This entry or the original request changed. Recover the original request before saving again.");
  if (error.code === "55000") throw new AppError(409, "This Book Bible request is durably closed. Recover its closure before starting another request.", undefined, "book_bible_request_closed");
  if (["PGRST202", "42883"].includes(error.code ?? "")) throw new AppError(503, "The durable Book Bible workflow migration is not installed. No direct-write fallback was used.");
  throw new AppError(503, "The Book Bible outcome could not be confirmed. Recover the original request before trying again.");
}

function mutationResult(value: unknown, expected: { bookId: string; requestId: string; action?: "create" | "update" | "delete"; itemId?: string; expectedIncarnationId?: string; recovery?: boolean; closure?: boolean }) {
  const parsed = mutationResultSchema.safeParse(value);
  const invalid = () => new AppError(503, "The saved Book Bible outcome could not be verified. Recover the original request before trying again.");
  if (!parsed.success) throw invalid();
  const result = parsed.data;
  if (result.closed ? !result.closure || result.closure.bookId !== expected.bookId || result.closure.requestId !== expected.requestId
    : result.closure !== null) throw invalid();
  if (!result.receipt) {
    if (!expected.recovery || result.disposition !== null || result.item !== null || result.replayed
      || (expected.closure && !result.closed)) throw invalid();
    return result;
  }
  const receipt = result.receipt;
  if (result.closed || receipt.bookId !== expected.bookId || receipt.requestId !== expected.requestId
    || (expected.action && receipt.action !== expected.action) || (expected.itemId && receipt.itemId !== expected.itemId)
    || result.disposition === null || (result.disposition === "deleted" ? result.item !== null
      : !result.item || result.item.id !== receipt.itemId || result.item.book_id !== receipt.bookId)
    || (result.disposition === "unchanged" && Date.parse(result.item!.updated_at) !== Date.parse(receipt.resultUpdatedAt))
    || (receipt.action === "delete" && result.disposition === "unchanged") || (expected.recovery && !result.replayed)
    || (!result.replayed && expected.action === "update" && result.item?.mutation_incarnation_id.toLowerCase() !== expected.expectedIncarnationId?.toLowerCase())
    || (!result.replayed && result.disposition !== (receipt.action === "delete" ? "deleted" : "unchanged"))) throw invalid();
  return result;
}

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
  publicationDate: BookMetadataSchema.shape.publicationDate.default(null),
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

function updatedTimestamp(previous: string) {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

export function bookMemoryRoutes(app: FastifyInstance) {
  app.post("/books/:bookId/bible/evidence", async (req, reply) => {
    const body = parse(z.object({ chapterId: id, documentVersionId: id,
      nodeId: z.string().min(1).max(200), textHash: z.string().regex(/^[a-f0-9]{64}$/u),
      offset: z.number().int().min(0).max(100000000).default(0) }).strict(), req.body);
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
    const startOffset = body.offset;
    if (startOffset > node.text.length || (startOffset > 0 && /[\uDC00-\uDFFF]/u.test(node.text.charAt(startOffset))
      && /[\uD800-\uDBFF]/u.test(node.text.charAt(startOffset - 1)))) {
      throw new AppError(422, "Choose a valid position in this saved passage.");
    }
    let endOffset = Math.min(node.text.length, startOffset + 24000);
    if (endOffset < node.text.length && /[\uDC00-\uDFFF]/u.test(node.text.charAt(endOffset))
      && /[\uD800-\uDBFF]/u.test(node.text.charAt(endOffset - 1))) endOffset--;
    reply.header("cache-control", "private, no-store");
    return { chapterTitle: chapter.title, versionNumber: version.version_number,
      isCurrentVersion: chapter.current_document_version_id === version.id,
      text: node.text.slice(startOffset, endOffset), truncated: endOffset < node.text.length,
      startOffset, endOffset, totalLength: node.text.length,
      nextOffset: endOffset < node.text.length ? endOffset : null };
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

  app.post("/books/:bookId/bible", { config: { durableIdempotency: true }, onSend: privateMutationResponse }, async (req, reply) => {
    requireMutationActor(req);
    const body = parse(bibleSchema, req.body);
    const { sb, bookId } = await scopedBook(app, req, true);
    const { requestId, ...intent } = body;
    // Only static request normalization precedes the RPC. Durable replay must
    // precede current image/source validation and dynamic version pinning.
    const { data, error } = await sb.rpc("mutate_book_bible_item", {
      p_book_id: bookId, p_request_id: requestId, p_action: "create", p_item_id: null, p_expected_updated_at: null, p_body: intent, p_expected_incarnation_id: null,
    });
    if (error) mutationError(error);
    const result = mutationResult(data, { bookId, requestId, action: "create" });
    reply.header("cache-control", "private, no-store");
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.put("/books/:bookId/bible/:itemId", { onSend: privateMutationResponse }, async (req, reply) => {
    requireMutationActor(req);
    const body = parse(updateBibleSchema, req.body);
    const itemId = parse(id, (req.params as { itemId: string }).itemId);
    const { sb, bookId } = await scopedBook(app, req, true);
    const { requestId, expectedUpdatedAt, expectedIncarnationId, ...intent } = body;
    const { data, error } = await sb.rpc("mutate_book_bible_item", {
      p_book_id: bookId, p_request_id: requestId, p_action: "update", p_item_id: itemId, p_expected_updated_at: expectedUpdatedAt, p_body: intent,
      p_expected_incarnation_id: expectedIncarnationId,
    });
    if (error) mutationError(error);
    reply.header("cache-control", "private, no-store");
    return mutationResult(data, { bookId, requestId, action: "update", itemId, expectedIncarnationId });
  });

  app.delete("/books/:bookId/bible/:itemId", { onSend: privateMutationResponse }, async (req, reply) => {
    requireMutationActor(req);
    const body = parse(deleteBibleSchema, req.body);
    const itemId = parse(id, (req.params as { itemId: string }).itemId);
    const { sb, bookId } = await scopedBook(app, req, true);
    const { data, error } = await sb.rpc("mutate_book_bible_item", {
      p_book_id: bookId, p_request_id: body.requestId, p_action: "delete", p_item_id: itemId, p_expected_updated_at: body.expectedUpdatedAt, p_body: null,
      p_expected_incarnation_id: body.expectedIncarnationId,
    });
    if (error) mutationError(error);
    reply.header("cache-control", "private, no-store");
    return mutationResult(data, { bookId, requestId: body.requestId, action: "delete", itemId });
  });

  app.get("/books/:bookId/bible/requests/:requestId", { onSend: privateMutationResponse }, async (req, reply) => {
    requireMutationActor(req);
    const requestId = parse(id, (req.params as { requestId: string }).requestId);
    if (Object.keys(req.query as object).length) throw new AppError(422, "Check the Book Bible recovery request.");
    const { sb, bookId } = await scopedBook(app, req, true);
    const { data, error } = await sb.rpc("recover_book_bible_mutation", { p_book_id: bookId, p_request_id: requestId });
    if (error) mutationError(error);
    reply.header("cache-control", "private, no-store");
    return mutationResult(data, { bookId, requestId, recovery: true });
  });

  app.post("/books/:bookId/bible/requests/:requestId/close", { config: { durableIdempotency: true }, onSend: privateMutationResponse }, async (req, reply) => {
    requireMutationActor(req);
    parse(z.object({}).strict(), req.body);
    const requestId = parse(id, (req.params as { requestId: string }).requestId);
    if (Object.keys(req.query as object).length) throw new AppError(422, "Check the Book Bible closure request.");
    const { sb, bookId } = await scopedBook(app, req, true);
    const { data, error } = await sb.rpc("close_book_bible_mutation", { p_book_id: bookId, p_request_id: requestId });
    if (error) mutationError(error);
    reply.header("cache-control", "private, no-store");
    return mutationResult(data, { bookId, requestId, recovery: true, closure: true });
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
