import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { loadBook } from "../lib/authoring.js";

const ids = z.object({ editionId: z.string().uuid(), requestId: z.string().uuid() }).strict();
const query = z.object({ bookId: z.string().uuid() }).strict();
const statuses = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);

/** Read-only recovery for the actor's exact render request, even after source edits. */
export function renderRequestRoutes(app: FastifyInstance) {
  app.get("/editions/:editionId/render-requests/:requestId", async (req, reply) => {
    const params = ids.safeParse(req.params), parsed = query.safeParse(req.query);
    if (!params.success || !parsed.success) throw new AppError(422, "Check the saved render request.");
    const { editionId, requestId } = params.data, { bookId } = parsed.data;
    const user = app.supabaseFactory(req.userToken);
    const { book } = await loadBook(user, bookId, req.userId);
    if (book.id !== bookId) throw new AppError(503, "Render request status is unavailable.");
    const { data: edition, error: editionError } = await user.from("editions").select("id,book_id")
      .eq("id", editionId).eq("book_id", bookId).maybeSingle();
    if (editionError) throw new AppError(503, "Render request status is unavailable.");
    if (!edition || edition.id !== editionId || edition.book_id !== bookId) throw new AppError(404, "Edition not found for this book.");
    const { data: job, error } = await user.from("publishing_jobs")
      .select("id,book_id,edition_id,created_by,channel,status,idempotency_key,request_json")
      .eq("book_id", bookId).eq("edition_id", editionId).eq("created_by", req.userId)
      .eq("idempotency_key", requestId).maybeSingle();
    if (error) throw new AppError(503, "Render request status is unavailable.");
    reply.header("cache-control", "private, no-store");
    if (!job) return { bookId, editionId, requestId, job: null };
    if (job.book_id !== bookId || job.edition_id !== editionId || job.created_by !== req.userId
      || job.idempotency_key !== requestId || job.channel !== "render" || job.request_json?.action !== "render"
      || !z.string().uuid().safeParse(job.id).success || !statuses.has(job.status)) {
      throw new AppError(503, "Render request status could not be verified.");
    }
    return { bookId, editionId, requestId, job: { id: job.id, status: job.status } };
  });
}
