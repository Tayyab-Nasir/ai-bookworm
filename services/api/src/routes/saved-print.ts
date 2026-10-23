import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { loadBook } from "../lib/authoring.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { previewSupabaseFetch, withinReaderDeadline, withPreviewAdmission } from "../lib/rendered-epub.js";
import { printUnavailable, savedPrintRender, verifySavedPrintBytes } from "../lib/rendered-print.js";
import { readSavedPdfForProof, requestSavedPdfPage } from "../lib/pdf-proof.js";

const paramsSchema = z.object({ editionId: z.string().uuid(), jobId: z.string().uuid().optional() }).strict();
const downloadQuery = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const jobColumns = "id,book_id,edition_id,channel,status,request_json,response_json,created_at";

async function printBook(sb: SupabaseClient, editionId: string, userId: string) {
  const { data: edition, error } = await sb.from("editions").select("id,book_id,type").eq("id", editionId).maybeSingle();
  if (error) throw printUnavailable();
  if (!edition) throw new AppError(404, "Edition not found.");
  if (edition.id !== editionId || !z.string().uuid().safeParse(edition.book_id).success) throw printUnavailable();
  const { book } = await loadBook(sb, edition.book_id, userId);
  if (book.id !== edition.book_id || !z.string().uuid().safeParse(book.workspace_id).success) throw printUnavailable();
  if (edition.type !== "print") throw new AppError(422, "Saved print exports are available only for print editions.");
  return { book, edition };
}

export function savedPrintRoutes(app: FastifyInstance, options: { fetcher?: typeof fetch } = {}) {
  app.get("/editions/:editionId/print-renders", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const params = z.object({ editionId: z.string().uuid() }).strict().safeParse(req.params);
    if (!params.success || Object.keys(req.query as object).length) throw new AppError(422, "Check the saved print history request.");
    const signal = AbortSignal.timeout(30_000);
    try {
      return await withinReaderDeadline(signal, async () => {
        const sb = app.supabaseFactory(req.userToken, previewSupabaseFetch(signal));
        const { book, edition } = await printBook(sb, params.data.editionId, req.userId);
        const { data: jobs, error } = await sb.from("publishing_jobs").select(jobColumns)
          .eq("book_id", book.id).eq("edition_id", edition.id).eq("channel", "render").eq("status", "succeeded")
          .order("created_at", { ascending: false }).limit(50);
        if (error || !Array.isArray(jobs) || jobs.length > 50) throw printUnavailable();
        const renders = [];
        for (const job of jobs) {
          try { renders.push((await savedPrintRender(sb, book.workspace_id, book.id, edition.id, job)).render); }
          catch (error) { if (!(error instanceof AppError) || ![404, 422].includes(error.status)) throw error; }
          if (renders.length === 25) break;
        }
        return { renders };
      });
    } catch (error) { if (error instanceof AppError && error.status !== 503) throw error; throw printUnavailable(); }
  });

  app.get("/editions/:editionId/print-renders/:jobId/download", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const params = paramsSchema.safeParse(req.params); const query = downloadQuery.safeParse(req.query);
    if (!params.success || !params.data.jobId || !query.success) throw new AppError(422, "Check the exact saved print download request.");
    const signal = AbortSignal.timeout(30_000);
    try {
      return await withinReaderDeadline(signal, () => withPreviewAdmission(signal, async (tasks) => {
        const sb = app.supabaseFactory(req.userToken, previewSupabaseFetch(signal, fetch, tasks));
        const load = async () => {
          const { book, edition } = await printBook(sb, params.data.editionId, req.userId);
          const { data: job, error } = await sb.from("publishing_jobs").select(jobColumns)
            .eq("id", params.data.jobId!).eq("book_id", book.id).eq("edition_id", edition.id).maybeSingle();
          if (error) throw printUnavailable();
          if (!job || job.id !== params.data.jobId) throw new AppError(404, "Saved print export not found for this edition.");
          const confirmed = await savedPrintRender(sb, book.workspace_id, book.id, edition.id, job);
          if (confirmed.render.source.sha256 !== query.data.sha256 || confirmed.render.fingerprint !== query.data.fingerprint) {
            throw new AppError(409, "This saved print source changed. Refresh its history before downloading.");
          }
          return confirmed;
        };
        const confirmed = await load();
        await verifySavedPrintBytes(sb, confirmed, signal, tasks);
        // Recheck access and every version after byte verification; old proofs remain downloadable after manuscript edits.
        const current = await load();
        const artifacts = [];
        for (const { descriptor, asset } of current.artifacts) {
          signal.throwIfAborted();
          const { data, error } = await sb.storage.from("book-assets").createSignedUrl(descriptor.storagePath, 300);
          signal.throwIfAborted();
          if (error || !data?.signedUrl) throw printUnavailable();
          artifacts.push({ asset, role: descriptor.role, download: { url: data.signedUrl, expiresIn: 300 } });
        }
        return { jobId: params.data.jobId, status: "succeeded", artifacts };
      }));
    } catch (error) { if (error instanceof AppError && error.status !== 503) throw error; throw printUnavailable(); }
  });

  app.get("/editions/:editionId/print-renders/:jobId/pages/:pageNumber", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const params = z.object({ editionId: z.string().uuid(), jobId: z.string().uuid(),
      pageNumber: z.string().regex(/^[1-9]\d{0,4}$/u).transform(Number).pipe(z.number().int().max(20_000)),
    }).strict().safeParse(req.params);
    const query = downloadQuery.extend({ assetId: z.string().uuid(),
      width: z.enum(["720", "1080", "1440"]).default("1080") }).strict().safeParse(req.query);
    if (!params.success || !query.success) throw new AppError(422, "Check the exact saved PDF page request.");
    const signal = AbortSignal.timeout(30_000);
    try {
      return await withinReaderDeadline(signal, () => withPreviewAdmission(signal, async tasks => {
        const sb = app.supabaseFactory(req.userToken, previewSupabaseFetch(signal, fetch, tasks));
        const load = async () => {
          const { book, edition } = await printBook(sb, params.data.editionId, req.userId);
          const { data: job, error } = await sb.from("publishing_jobs").select(jobColumns)
            .eq("id", params.data.jobId).eq("book_id", book.id).eq("edition_id", edition.id).maybeSingle();
          if (error) throw printUnavailable();
          if (!job || job.id !== params.data.jobId) throw new AppError(404, "Saved print export not found for this edition.");
          const saved = await savedPrintRender(sb, book.workspace_id, book.id, edition.id, job);
          if (saved.render.source.sha256 !== query.data.sha256 || saved.render.fingerprint !== query.data.fingerprint) {
            throw new AppError(409, "This saved print source changed. Refresh its history before opening pages.");
          }
          return saved;
        };
        const before = await load();
        const selected = await readSavedPdfForProof(sb, before, query.data.assetId, signal, tasks);
        await load(); // Membership and immutable provenance must still hold before private decoding.
        const page = await requestSavedPdfPage(selected.content, selected.descriptor, params.data.pageNumber,
          Number(query.data.width) as 720 | 1080 | 1440, signal, tasks, options.fetcher);
        const current = await load(); // A revoked membership never receives the decoded image/text.
        return { ...page, source: { ...current.render.source,
          assetId: selected.descriptor.assetId, role: selected.descriptor.role,
          sha256: selected.descriptor.checksum, sizeBytes: selected.descriptor.sizeBytes },
          fingerprint: current.render.fingerprint };
      }));
    } catch (error) { if (error instanceof AppError && error.status !== 503) throw error; throw printUnavailable(); }
  });
}
