import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { loadBook } from "../lib/authoring.js";
import { boundedSupabaseFetch } from "../lib/supabase.js";

const ids = z.object({ editionId: z.string().uuid(), requestId: z.string().uuid() }).strict();
const query = z.object({ bookId: z.string().uuid() }).strict();
const statuses = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
const closeResult = z.object({ bookId: z.string().uuid(), editionId: z.string().uuid(), requestId: z.string().uuid(),
  job: z.object({ id: z.string().uuid(), status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]) }).strict(),
  closedBeforeAcceptance: z.boolean() }).strict();

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

  app.post("/editions/:editionId/render-requests/:requestId/close", async (req, reply) => {
    const params = ids.safeParse(req.params), body = query.safeParse(req.body);
    if (!params.success || !body.success) throw new AppError(422, "Check the saved render request.");
    const { editionId, requestId } = params.data, { bookId } = body.data;
    // The user's JWT is essential: the RPC verifies and locks that actor's
    // active membership before racing the original request's insert.
    const user = app.supabaseFactory(req.userToken, boundedSupabaseFetch(AbortSignal.timeout(15_000)));
    let resultRpc: Awaited<ReturnType<typeof user.rpc>>;
    try {
      resultRpc = await user.rpc("close_render_request", { p_book_id: bookId, p_edition_id: editionId, p_request_id: requestId });
    } catch {
      throw new AppError(503, "Render request closure could not be confirmed. Check it again.");
    }
    const { data, error } = resultRpc;
    if (error) {
      if (error.code === "42501") throw new AppError(403, "Editing access is required to close a render request.");
      if (error.code === "P0002") throw new AppError(404, "Book or edition is unavailable.");
      if (error.code === "22023") throw new AppError(422, "Check the saved render request.");
      if (error.code === "23505") throw new AppError(409, "Render request identity could not be verified.");
      if (error.code === "54000") throw new AppError(429, "Render request closure limit reached. Try again later.");
      throw new AppError(503, "Render request closure could not be confirmed. Check it again.");
    }
    const result = closeResult.safeParse(data);
    if (!result.success || result.data.bookId !== bookId || result.data.editionId !== editionId || result.data.requestId !== requestId
      || (result.data.closedBeforeAcceptance && result.data.job.status !== "cancelled")) {
      throw new AppError(503, "Render request closure could not be verified. Check it again.");
    }
    reply.header("cache-control", "private, no-store");
    return result.data;
  });
}
