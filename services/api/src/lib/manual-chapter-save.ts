import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { appendVersion, latestVersion, loadChapter, parseNodes } from "./authoring.js";
import type { SupabaseClient } from "./supabase.js";

export function checkChapterActor(req: FastifyRequest, required = false) {
  const actor = req.headers["x-bookworm-actor"];
  if (!required && actor === undefined) return;
  if (!z.string().uuid().safeParse(actor).success) throw new AppError(422, "The original account identity is required for this saved request.");
  if (actor !== req.userId) throw new AppError(409, "Your account changed. Reload before recovering this manuscript request.");
}

const params = z.object({ chapterId: z.string().uuid(), operationId: z.string().uuid() });
const expectedVersionSchema = z.number().int().min(0).max(2_147_483_645);
const bodyVersion = z.object({ expectedVersion: expectedVersionSchema }).strict();
const queryVersion = z.object({ expectedVersion: z.string().regex(/^(0|[1-9][0-9]{0,9})$/u).transform(Number).pipe(expectedVersionSchema) }).strict();
const closeKey = (userId: string, operationId: string) => `manual-save-close:${userId}:${operationId}`;

async function status(sb: SupabaseClient, chapterId: string, operationId: string, userId: string, expectedVersion: number, bookId: string) {
  // Read the latest committed version BEFORE receipts: if it advanced and both
  // receipts remain absent afterward, the original CAS can no longer commit.
  const current = await latestVersion(sb, chapterId);
  const currentVersion = current?.version_number ?? 0;
  if (currentVersion < expectedVersion) throw new AppError(409, "Saved chapter history does not match this recovery request.");
  const find = async (key: string) => {
    const { data, error } = await sb.from("document_versions").select("id,version_number,content_json")
      .eq("chapter_id", chapterId).eq("operation_id", key).eq("created_by", userId).maybeSingle();
    if (error) throw new AppError(503, "Could not verify the original manuscript save. No new save was sent.");
    if (data && data.version_number !== expectedVersion + 1) throw new AppError(409, "The saved request belongs to a different chapter revision.");
    return data;
  };
  const original = await find(operationId), closed = await find(closeKey(userId, operationId));
  if (original && closed) throw new AppError(409, "Conflicting manuscript recovery receipts require review.");
  const receipt = original ?? closed;
  return { operationId, bookId, chapterId, expectedVersion,
    currentVersion: Math.max(currentVersion, receipt?.version_number ?? 0),
    status: original ? "saved" as const : closed ? "closed" as const : currentVersion > expectedVersion ? "superseded" as const : "not_found" as const,
    receipt: receipt ? { versionId: receipt.id, document: { chapterId, version: receipt.version_number, nodes: parseNodes(receipt.content_json) } } : null };
}

export function manualChapterSaveRoutes(app: FastifyInstance) {
  for (const method of ["GET", "POST"] as const) app.route({ method,
    url: `/chapters/:chapterId/manual-saves/:operationId${method === "POST" ? "/close" : ""}`,
    async handler(req, reply) {
      reply.header("Cache-Control", "private, no-store"); checkChapterActor(req, true);
      const path = params.safeParse(req.params), body = method === "GET" ? queryVersion.safeParse(req.query) : bodyVersion.safeParse(req.body);
      if (!path.success || !body.success) throw new AppError(422, "Valid chapter, original request and expected revision are required.");
      const { chapterId, operationId } = path.data, { expectedVersion } = body.data;
      const sb = app.supabaseFactory(req.userToken);
      const { book } = await loadChapter(sb, chapterId, req.userId, method === "POST");
      const result = await status(sb, chapterId, operationId, req.userId, expectedVersion, book.id);
      if (method === "GET" || result.status !== "not_found") return result;
      const current = await latestVersion(sb, chapterId);
      // Never overwrite a racing save. The existing SQL function takes the
      // chapter row lock and checks expectedVersion before appending this fence.
      if ((current?.version_number ?? 0) !== expectedVersion) return status(sb, chapterId, operationId, req.userId, expectedVersion, book.id);
      await appendVersion(sb, chapterId, expectedVersion, parseNodes(current?.content_json), closeKey(req.userId, operationId), "Closed an unconfirmed manual save; saved manuscript content unchanged");
      return status(sb, chapterId, operationId, req.userId, expectedVersion, book.id);
    },
  });
}
