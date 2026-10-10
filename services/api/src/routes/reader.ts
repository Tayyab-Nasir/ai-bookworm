import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { loadBook } from "../lib/authoring.js";
import { previewSupabaseFetch, requestEpubPreview, savedEpubBytes, savedEpubSource, withinReaderDeadline, withPreviewAdmission } from "../lib/rendered-epub.js";
import type { SupabaseClient } from "../lib/supabase.js";

const paramsSchema = z.object({ editionId: z.string().uuid(), jobId: z.string().uuid().optional(), resourceIndex: z.coerce.number().int().min(0).max(9999).optional() }).strict();
const sectionQuery = z.object({ spine: z.coerce.number().int().min(0).max(2499).default(0), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const resourceQuery = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

async function readerBook(sb: SupabaseClient, editionId: string, userId: string) {
  const { data: edition, error } = await sb.from("editions").select("id,book_id,type").eq("id", editionId).maybeSingle();
  if (error) throw new AppError(503, "Saved edition could not be loaded.");
  if (!edition) throw new AppError(404, "Edition not found.");
  if (edition.id !== editionId || !z.string().uuid().safeParse(edition.book_id).success) throw new AppError(503, "Saved edition could not be verified.");
  const { book } = await loadBook(sb, edition.book_id, userId);
  if (book.id !== edition.book_id || !z.string().uuid().safeParse(book.workspace_id).success) throw new AppError(503, "Saved book could not be verified.");
  if (edition.type !== "ebook") throw new AppError(422, "The saved EPUB reader is available only for ebook editions.");
  return { book, edition };
}

export function readerRoutes(app: FastifyInstance, options: { fetcher?: typeof fetch } = {}) {
  app.get("/editions/:editionId/renders", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const params = z.object({ editionId: z.string().uuid() }).strict().safeParse(req.params);
    if (!params.success || Object.keys(req.query as object).length) throw new AppError(422, "Check the saved render history request.");
    const signal = AbortSignal.timeout(30_000);
    try {
      return await withinReaderDeadline(signal, async () => {
        const sb = app.supabaseFactory(req.userToken, previewSupabaseFetch(signal));
        const { book, edition } = await readerBook(sb, params.data.editionId, req.userId);
        const { data: jobs, error } = await sb.from("publishing_jobs").select("id,book_id,edition_id,channel,status,request_json,response_json,created_at")
          .eq("book_id", book.id).eq("edition_id", edition.id).eq("channel", "render").eq("status", "succeeded")
          .order("created_at", { ascending: false }).limit(50);
        if (error || !Array.isArray(jobs) || jobs.length > 50) throw new AppError(503, "Saved render history could not be loaded.");
        const renders = [];
        for (const job of jobs) {
          if (!z.string().uuid().safeParse(job.id).success || !z.string().datetime({ offset: true }).safeParse(job.created_at).success) continue;
          try { const source = await savedEpubSource(sb, book.workspace_id, book.id, edition.id, job); renders.push({ jobId: job.id, createdAt: job.created_at, source }); }
          catch (error) { if (!(error instanceof AppError) || ![404, 422].includes(error.status)) throw error; }
          if (renders.length === 25) break;
        }
        return { renders };
      });
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError(503, "Saved render history could not be loaded."); }
  });

  const read = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "private, no-store");
    const params = paramsSchema.safeParse(req.params);
    const query = (params.success && params.data.resourceIndex !== undefined ? resourceQuery : sectionQuery).safeParse(req.query);
    if (!params.success || !params.data.jobId || !query.success) throw new AppError(422, "Check the saved EPUB reader request.");
    const selected = params.data.resourceIndex !== undefined ? { resourceIndex: params.data.resourceIndex }
      : { spineIndex: (query.data as z.infer<typeof sectionQuery>).spine };
    const signal = AbortSignal.timeout(30_000);
    try {
      return await withinReaderDeadline(signal, async () => {
        const sb = app.supabaseFactory(req.userToken, previewSupabaseFetch(signal));
        const { book, edition } = await readerBook(sb, params.data.editionId, req.userId);
        return withPreviewAdmission(signal, async (tasks) => {
          const reader = app.supabaseFactory(req.userToken, previewSupabaseFetch(signal, fetch, tasks));
          const { data: job, error } = await reader.from("publishing_jobs").select("id,book_id,edition_id,channel,status,request_json,response_json")
            .eq("id", params.data.jobId!).eq("book_id", book.id).eq("edition_id", edition.id).maybeSingle();
          if (error) throw new AppError(503, "Saved render could not be loaded.");
          if (!job || job.id !== params.data.jobId) throw new AppError(404, "Saved render not found for this edition.");
          const source = await savedEpubSource(reader, book.workspace_id, book.id, edition.id, job);
          if (query.data.sha256 !== source.sha256) throw new AppError(409, "This saved EPUB source changed. Reload its render history before reading.");
          const bytes = await savedEpubBytes(reader, book.workspace_id, source, signal, tasks);
          return requestEpubPreview(options.fetcher ?? fetch, bytes, source, selected, signal, tasks);
        });
      });
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError(503, "The saved EPUB reader is temporarily unavailable. No new render was created."); }
  };
  app.get("/editions/:editionId/renders/:jobId/reader", read);
  app.get("/editions/:editionId/renders/:jobId/reader/resources/:resourceIndex", read);
}
