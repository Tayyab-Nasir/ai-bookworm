import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import { loadChapter, rpcError } from "./authoring.js";
import { checkChapterActor } from "./manual-chapter-save.js";

const revision = z.number().int().min(0).max(2_147_483_646);
const title = z.string().min(1).max(500).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const params = z.object({ chapterId: z.string().uuid(), operationId: z.string().uuid() }).strict();
const identity = z.object({ expectedRevision: revision, titleDigest: digest }).strict();
const query = identity.extend({ expectedRevision: z.string().regex(/^(0|[1-9][0-9]{0,9})$/u).transform(Number).pipe(revision) });
const save = z.object({ expectedRevision: revision, title }).strict();
const current = z.object({ title: z.string().max(500), revision, updatedAt: z.string().datetime({ offset: true }) }).strict();
const resultSchema = z.object({
  chapterId: z.string().uuid(), bookId: z.string().uuid(), operationId: z.string().uuid(), expectedRevision: revision, titleDigest: digest,
  status: z.enum(["saved", "closed", "conflict", "not_found"]),
  receipt: z.object({ title, revision }).strict().nullable(), current,
}).strict();
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export function chapterTitleRoutes(app: FastifyInstance) {
  app.get("/chapters/:chapterId/title", async (req, reply) => {
    reply.header("cache-control", "private, no-store"); checkChapterActor(req, true);
    const parsed = params.omit({ operationId: true }).safeParse(req.params);
    if (!parsed.success) throw new AppError(422, "Valid chapter ID required");
    const { chapter, role } = await loadChapter(app.supabaseFactory(req.userToken), parsed.data.chapterId, req.userId);
    const state = current.safeParse({ title: chapter.title, revision: chapter.title_revision, updatedAt: chapter.updated_at });
    if (!state.success) throw new AppError(503, "Chapter title editing is not available. The saved manuscript is unchanged.");
    return { chapterId: chapter.id, bookId: chapter.book_id, ...state.data, role };
  });

  for (const mode of ["save", "read", "close"] as const) {
    app.route({ method: mode === "save" ? "PUT" : mode === "read" ? "GET" : "POST",
      url: `/chapters/:chapterId/title-changes/:operationId${mode === "close" ? "/close" : ""}`,
      handler: async (req, reply) => {
        reply.header("cache-control", "private, no-store"); checkChapterActor(req, true);
        const target = params.safeParse(req.params);
        const body = mode === "save" ? save.safeParse(req.body) : mode === "read" ? query.safeParse(req.query) : identity.safeParse(req.body);
        if (!target.success || !body.success) throw new AppError(422, "Invalid chapter title request");
        const { chapterId, operationId } = target.data;
        const { expectedRevision } = body.data;
        const requestedTitle = "title" in body.data ? body.data.title : null;
        const titleDigest = requestedTitle !== null ? hash(requestedTitle) : (body.data as z.infer<typeof identity>).titleDigest;
        const sb = app.supabaseFactory(req.userToken);
        const { chapter } = await loadChapter(sb, chapterId, req.userId, mode !== "read");
        const { data, error } = await sb.rpc(mode === "save" ? "change_chapter_title" : mode === "close" ? "close_chapter_title_change" : "get_chapter_title_change", {
          p_chapter_id: chapterId, p_operation_id: operationId, p_expected_revision: expectedRevision,
          ...(mode === "save" ? { p_title: requestedTitle } : { p_title_digest: titleDigest }),
        });
        if (error) rpcError(error);
        const parsed = resultSchema.safeParse(data);
        if (!parsed.success) throw new AppError(503, "The title change result could not be confirmed. Keep its original request.");
        const result = parsed.data;
        if (result.chapterId !== chapterId || result.bookId !== chapter.book_id || result.operationId !== operationId
          || result.expectedRevision !== expectedRevision || result.titleDigest !== titleDigest
          || (result.status === "saved" ? !result.receipt || hash(result.receipt.title) !== titleDigest
            || result.receipt.revision < expectedRevision || result.receipt.revision > expectedRevision + 1
            || result.current.revision < result.receipt.revision
            || (result.current.revision === result.receipt.revision && result.current.title !== result.receipt.title)
            : result.receipt !== null)) throw new AppError(503, "The title change receipt is inconsistent. Check its status before trying again.");
        return result;
      },
    });
  }
}
