import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceMember, requireWorkspaceEditor } from "../lib/authorize.js";
import { randomUUID } from "node:crypto";
import { BookModelSchema } from "@bookworm/book-model";
import { checkAssetReferences, loadBook, nodesSchema, rpcError } from "../lib/authoring.js";
import { createHttpAssetScanner, type AssetMalwareScanner } from "../lib/asset-scanner.js";
import { readImportReceipt } from "../lib/manuscript-images.js";
import { executeManuscriptImport } from "../lib/manuscript-import.js";
import { importJobSchema } from "../lib/document-worker.js";

const createSchema = z.object({
  workspaceId: z.string().uuid(),
  requestId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(500),
  subtitle: z.string().max(500).optional(),
  authorName: z.string().trim().min(1).max(300),
  language: z.string().min(2).max(40).default("en"),
  genre: z.string().max(200).optional(),
});

export function bookRoutes(app: FastifyInstance, options: { assetScanner?: AssetMalwareScanner } = {}) {
  const jobColumns = "id,book_id,source_asset_id,status,attempts,error_code,created_at,available_at,completed_at";
  const jobParams = (value: unknown) => {
    const parsed = z.object({ bookId: z.string().uuid(), jobId: z.string().uuid().optional() }).safeParse(value);
    if (!parsed.success) throw new AppError(422, "Valid book and import job IDs required");
    return parsed.data;
  };
  app.get("/books/:bookId/import-jobs", async (req, reply) => {
    const { bookId } = jobParams(req.params);
    const sb = app.supabaseFactory(req.userToken);
    await loadBook(sb, bookId, req.userId);
    const { data, error } = await sb.from("manuscript_import_jobs").select(jobColumns).eq("book_id", bookId)
      .order("created_at", { ascending: false }).limit(50);
    if (error) throw new AppError(503, "Import jobs are temporarily unavailable");
    reply.header("cache-control", "private, no-store");
    return { jobs: z.array(importJobSchema).parse(data ?? []) };
  });
  app.post("/books/:bookId/import-jobs", async (req, reply) => {
    const { bookId } = jobParams(req.params);
    const body = z.object({ assetId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) throw new AppError(422, "Valid source asset ID required");
    const { assetId } = body.data;
    await loadBook(app.supabaseFactory(req.userToken), bookId, req.userId, true);
    const { data, error } = await app.supabaseFactory().rpc("enqueue_manuscript_import", {
      p_actor_id: req.userId, p_book_id: bookId, p_source_asset_id: assetId,
    });
    if (error) rpcError(error);
    reply.header("cache-control", "private, no-store");
    return reply.code(202).send({ job: importJobSchema.parse(data) });
  });
  app.post("/books/:bookId/import-jobs/:jobId/retry", async (req, reply) => {
    const { bookId, jobId } = jobParams(req.params);
    if (!jobId) throw new AppError(422, "Import job ID required");
    const sb = app.supabaseFactory(req.userToken);
    await loadBook(sb, bookId, req.userId, true);
    const existing = await sb.from("manuscript_import_jobs").select("id").eq("id", jobId).eq("book_id", bookId).maybeSingle();
    if (existing.error) throw new AppError(503, "Import jobs are temporarily unavailable");
    if (!existing.data) throw new AppError(404, "Import job not found in this book");
    const { data, error } = await app.supabaseFactory().rpc("retry_manuscript_import", { p_job_id: jobId, p_actor_id: req.userId });
    if (error) rpcError(error);
    reply.header("cache-control", "private, no-store");
    return reply.code(202).send({ job: importJobSchema.parse(data) });
  });

  app.get("/books/:bookId", async (req) => {
    const { bookId } = req.params as { bookId: string };
    return loadBook(app.supabaseFactory(req.userToken), bookId, req.userId);
  });

  app.patch("/books/:bookId", async (req) => {
    const { bookId } = req.params as { bookId: string };
    const body = createSchema.omit({ workspaceId: true, requestId: true }).partial().extend({ subtitle: z.string().max(500).nullable().optional(), genre: z.string().max(200).nullable().optional(), expectedUpdatedAt: z.string().datetime({ offset: true }) }).safeParse(req.body);
    if (!body.success) throw new AppError(422, "Invalid book details", { issues: body.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    await loadBook(sb, bookId, req.userId, true);
    const { expectedUpdatedAt, ...fields } = body.data;
    const update: Record<string, unknown> = { updated_at: new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString() };
    for (const [key,value] of Object.entries(fields)) if (value !== undefined) update[key === "authorName" ? "author_name" : key] = value;
    if (Object.keys(update).length === 1) throw new AppError(422, "No book changes supplied");
    const { data: book, error } = await sb.from("books").update(update).eq("id", bookId).eq("updated_at", expectedUpdatedAt).select("*").maybeSingle();
    if (error) throw new AppError(500, "Could not update book details");
    if (!book) throw new AppError(409, "Book details changed. Reload before saving.");
    return { book };
  });

  app.post("/books/:bookId/chapters", async (req, reply) => {
    const { bookId } = req.params as { bookId: string };
    const body = z.object({ title: z.string().trim().min(1).max(500), nodes: nodesSchema.optional(), idempotencyKey: z.string().trim().min(8).max(200).optional() }).safeParse(req.body);
    if (!body.success) throw new AppError(422, "invalid chapter", { issues: body.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const { book } = await loadBook(sb, bookId, req.userId, true);
    const nodes = body.data.nodes ?? [{ id: randomUUID(), type: "paragraph" as const, text: "" }];
    await checkAssetReferences(sb, nodes, book.workspace_id);
    const { data, error } = body.data.idempotencyKey
      ? await sb.rpc("create_book_chapter_once", { p_book_id: bookId, p_title: body.data.title, p_nodes: body.data.nodes ?? null, p_request_key: body.data.idempotencyKey })
      : await sb.rpc("create_book_chapters", { p_book_id: bookId, p_chapters: [{ title: body.data.title, nodes }], p_source_asset_id: null });
    if (error) rpcError(error);
    return reply.status(201).send({ chapter: data?.[0] });
  });

  app.put("/books/:bookId/chapters/order", async (req) => {
    const { bookId } = req.params as { bookId: string };
    const body = z.object({ orderedIds: z.array(z.string().uuid()).max(500), expectedIds: z.array(z.string().uuid()).max(500) }).safeParse(req.body);
    if (!body.success) throw new AppError(422, "invalid chapter order");
    if (new Set(body.data.orderedIds).size !== body.data.orderedIds.length) throw new AppError(422, "Duplicate chapter IDs");
    const sb = app.supabaseFactory(req.userToken);
    await loadBook(sb, bookId, req.userId, true);
    const { data, error } = await sb.rpc("reorder_book_chapters", { p_book_id: bookId, p_ordered_ids: body.data.orderedIds, p_expected_ids: body.data.expectedIds });
    if (error) rpcError(error);
    return { chapters: data ?? [] };
  });

  app.get("/books/:bookId/imports/:assetId", async (req, reply) => {
    const params = z.object({ bookId: z.string().uuid(), assetId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) throw new AppError(422, "Valid book and source asset IDs required");
    const sb = app.supabaseFactory(req.userToken);
    await loadBook(sb, params.data.bookId, req.userId);
    reply.header("cache-control", "private, no-store");
    return { import: await readImportReceipt(sb, params.data.bookId, params.data.assetId) };
  });

  app.post("/books/:bookId/import", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const { bookId } = req.params as { bookId: string };
    const body = z.object({ assetId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) throw new AppError(422, "assetId required");
    const sb = app.supabaseFactory(req.userToken);
    return executeManuscriptImport({ sb, service: app.supabaseFactory(),
      scanner: options.assetScanner ?? createHttpAssetScanner(), bookId, actorId: req.userId, assetId: body.data.assetId });
  });

  app.get("/books", async (req) => {
    const { workspaceId } = req.query as { workspaceId?: string };
    if (!workspaceId) throw new AppError(400, "workspaceId query param required");
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(sb, workspaceId, req.userId);
    const { data, error } = await sb.from("books").select("*").eq("workspace_id", workspaceId);
    if (error) throw new AppError(500, error.message);
    return { books: data };
  });

  app.post("/books", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid request", { issues: parsed.error.issues });
    const b = parsed.data;
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(sb, b.workspaceId, req.userId);
    const { data, error } = await sb.from("books").insert({
      ...(b.requestId ? { id: b.requestId } : {}),
      workspace_id: b.workspaceId,
      title: b.title,
      subtitle: b.subtitle ?? null,
      author_name: b.authorName,
      language: b.language,
      genre: b.genre ?? null,
      created_by: req.userId,
    }).select().single();
    if (error?.code === "23505" && b.requestId) {
      const existing = await sb.from("books").select("*").eq("id", b.requestId).eq("workspace_id", b.workspaceId).maybeSingle();
      if (existing.error) throw new AppError(503, "Book creation recovery is temporarily unavailable");
      const book = existing.data;
      if (book?.created_by === req.userId && book.title === b.title && book.subtitle === (b.subtitle ?? null)
        && book.author_name === b.authorName && book.language === b.language && book.genre === (b.genre ?? null)) {
        return reply.status(200).send(book);
      }
      throw new AppError(409, "This book request was already used with different details. Reload your library before continuing.");
    }
    if (error) throw new AppError(422, error.message);
    return reply.status(201).send(data);
  });

  app.get("/books/:bookId/chapters", async (req) => {
    const { bookId } = req.params as { bookId: string };
    const sb = app.supabaseFactory(req.userToken);
    const { data: book } = await sb.from("books").select("workspace_id").eq("id", bookId).maybeSingle();
    if (!book) throw new AppError(404, "book not found");
    await requireWorkspaceMember(sb, book.workspace_id, req.userId);
    const { data, error } = await sb.from("chapters").select("*").eq("book_id", bookId).order("order_index");
    if (error) throw new AppError(500, error.message);
    return { chapters: data };
  });
}
