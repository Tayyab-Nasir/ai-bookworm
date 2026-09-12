import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applyOperation, DocumentOperationSchema, type BookModel } from "@bookworm/book-model";
import { AppError } from "../errors.js";
import { appendVersion, checkAssetReferences, latestVersion, loadChapter, nodesSchema, parseNodes } from "../lib/authoring.js";

const saveSchema = z.object({
  expectedVersion: z.number().int().nonnegative(), nodes: nodesSchema,
  operationId: z.string().min(1).max(200), changeSummary: z.string().max(500).default("Manuscript edited"),
});

export function chapterRoutes(app: FastifyInstance) {
  app.get("/chapters/:chapterId/document", async (req) => {
    const { chapterId } = req.params as { chapterId: string };
    const sb = app.supabaseFactory(req.userToken);
    const { chapter, role } = await loadChapter(sb, chapterId, req.userId);
    const current = await latestVersion(sb, chapterId);
    return { chapter, role, document: { chapterId, version: current?.version_number ?? 0, nodes: parseNodes(current?.content_json) } };
  });

  app.get("/chapters/:chapterId/versions", async (req) => {
    const { chapterId } = req.params as { chapterId: string };
    const sb = app.supabaseFactory(req.userToken);
    await loadChapter(sb, chapterId, req.userId);
    const { data, error } = await sb.from("document_versions")
      .select("id,chapter_id,version_number,plain_text,word_count,created_by,created_at,change_summary")
      .eq("chapter_id", chapterId).order("version_number", { ascending: false }).limit(100);
    if (error) throw new AppError(500, "Could not load version history");
    return { versions: data ?? [] };
  });

  app.put("/chapters/:chapterId/document", { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const { chapterId } = req.params as { chapterId: string };
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid document", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const { book } = await loadChapter(sb, chapterId, req.userId, true);
    await checkAssetReferences(sb, parsed.data.nodes, book.workspace_id);
    return appendVersion(sb, chapterId, parsed.data.expectedVersion, parsed.data.nodes, parsed.data.operationId, parsed.data.changeSummary);
  });

  app.post("/chapters/:chapterId/versions/:versionId/restore", async (req) => {
    const { chapterId, versionId } = req.params as { chapterId: string; versionId: string };
    const body = z.object({ expectedVersion: z.number().int().nonnegative(), operationId: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) throw new AppError(422, "expectedVersion and operationId required");
    const sb = app.supabaseFactory(req.userToken);
    const { book } = await loadChapter(sb, chapterId, req.userId, true);
    const { data: previous, error } = await sb.from("document_versions").select("*").eq("chapter_id", chapterId).eq("id", versionId).maybeSingle();
    if (error) throw new AppError(500, "Could not load previous version");
    if (!previous) throw new AppError(404, "version not found in this chapter");
    const nodes = parseNodes(previous.content_json);
    await checkAssetReferences(sb, nodes, book.workspace_id);
    return appendVersion(sb, chapterId, body.data.expectedVersion, nodes, body.data.operationId, `Restored version ${previous.version_number}`);
  });

  app.post("/chapters/:chapterId/operations", async (req) => {
    const { chapterId } = req.params as { chapterId: string };
    const parsed = DocumentOperationSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid operation", { issues: parsed.error.issues });
    const op = parsed.data;
    if (op.target.chapterId !== chapterId) throw new AppError(422, "operation target must match the URL chapter");
    const sb = app.supabaseFactory(req.userToken);
    const { chapter, book } = await loadChapter(sb, chapterId, req.userId, true);
    const current = await latestVersion(sb, chapterId);
    const currentVersion = current?.version_number ?? 0;
    if (op.expectedVersion !== currentVersion) throw new AppError(409, "stale expectedVersion", { currentVersion });
    const nodes = parseNodes(current?.content_json);
    const assetIds = [...new Set([...nodes.flatMap((n) => n.assetId ? [n.assetId] : []), ...(op.type === "attach_asset" ? [op.payload.assetId] : [])])];
    const model: BookModel = {
      schemaVersion: "1.0", bookId: book.id, metadata: { title: book.title, author: book.author_name, language: book.language },
      styleGuide: {}, bookBible: { entities: [] }, assets: assetIds.map((id) => ({ id, role: "illustration" })),
      chapters: [{ id: chapterId, order: chapter.order_index, title: chapter.title, nodes }],
    };
    let result;
    try { result = applyOperation(model, op, currentVersion); }
    catch (error) { throw new AppError(422, error instanceof Error ? error.message : "Invalid operation"); }
    const nextNodes = nodesSchema.parse(result.book.chapters[0].nodes);
    await checkAssetReferences(sb, nextNodes, book.workspace_id);
    return appendVersion(sb, chapterId, currentVersion, nextNodes, op.operationId, op.type);
  });
}
