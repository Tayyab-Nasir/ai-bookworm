import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { loadBook } from "../lib/authoring.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { summarizeTranslationBilling } from "../lib/translation-billing.js";
import { availableTranslationModels, readTranslationCatalog } from "../lib/translation-catalog.js";

const languageSchema = z.string().trim().toLowerCase().regex(/^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/).max(35);
const createSchema = z.object({ targetLanguage: languageSchema, idempotencyKey: z.string().trim().min(8).max(200) }).strict();
const adoptSchema = z.object({ title: z.string().trim().min(1).max(500) }).strict();
const projectIdSchema = z.string().uuid();

function row(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
}

function quoteRequestProgress(value: unknown) {
  const parsed=z.object({id:z.string().uuid(),book_id:z.string().uuid(),status:z.enum(["queued","running","ready","failed"]),
    chapters_json:z.array(z.object({chapterId:z.string().uuid()})).min(1).max(500),counts_json:z.record(z.unknown()),
    proposal_id:z.string().uuid().nullable(),created_at:z.string(),target_language:z.string(),model_id:z.string()}).safeParse(value);
  if (!parsed.success) throw new AppError(503,"Could not confirm quote preparation. Refresh this request.");
  const request=parsed.data;
  return {id:request.id,bookId:request.book_id,status:request.status,chapterCount:request.chapters_json.length,
    countedChapters:Object.keys(request.counts_json).length,proposalId:request.proposal_id,
    createdAt:request.created_at,targetLanguage:request.target_language,modelId:request.model_id};
}

async function hydrateProject(sb: SupabaseClient, project: Record<string, unknown>, includeText = false, userId?: string) {
  const { data: chapters, error } = await sb.from("translation_chapters").select("*")
    .eq("project_id", project.id).order("chapter_order");
  if (error) throw new AppError(500, "Could not load translation chapters.");
  const chapterRows = chapters ?? [];
  const jobIds = chapterRows.map((item) => item.ai_job_id);
  const chapterIds = chapterRows.map((item) => item.chapter_id);
  const [{ data: jobs, error: jobsError }, { data: sources, error: sourcesError }] = await Promise.all([
    jobIds.length ? sb.from("ai_jobs").select("id,status,error_code,billing_mode").in("id", jobIds) : Promise.resolve({ data: [], error: null }),
    chapterIds.length ? sb.from("chapters").select("id,title,order_index").in("id", chapterIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (jobsError || sourcesError) throw new AppError(500, "Could not load translation progress.");
  const jobsById = new Map((jobs ?? []).map((item) => [item.id, item]));
  const sourceById = new Map((sources ?? []).map((item) => [item.id, item]));
  const quoted = jobIds.length > 0 && jobs?.length === jobIds.length && jobs.every((job) => job.billing_mode === "quoted");
  return {
    billingMode: quoted ? "quoted" : "operational",
    canViewBilling: quoted && project.created_by === userId,
    canCancelBeforeDispatch: quoted && project.created_by === userId && project.status !== "succeeded" && project.status !== "cancelled",
    id: project.id, bookId: project.book_id, sourceLanguage: project.source_language, targetLanguage: project.target_language,
    status: project.status, chapterCount: project.chapter_count, completedChapterCount: project.completed_chapter_count,
    creditUnits: project.credit_units, adoptedBookId: project.adopted_book_id ?? null, createdAt: project.created_at,
    completedAt: project.completed_at ?? null,
    chapters: chapterRows.map((item) => {
      const job = jobsById.get(item.ai_job_id); const source = sourceById.get(item.chapter_id);
      return {
        id: item.id, chapterId: item.chapter_id, documentVersionId: item.document_version_id, chapterOrder: item.chapter_order,
        chapterTitle: source?.title ?? "Saved chapter", status: job?.status ?? "unknown", failureCode: job?.error_code ?? null,
        wordCount: item.translated_word_count ?? null, ...(includeText && item.translated_text ? { translatedText: item.translated_text } : {}),
      };
    }),
  };
}

function queueError(error: { code?: string }) {
  if (error.code === "23514") throw new AppError(422, "Your translation credits are used or reserved. No translation was started.", undefined, "translation_credit_capacity_exhausted");
  if (error.code === "42501") throw new AppError(403, "Editing access is required to translate this book.");
  if (error.code === "P0002") throw new AppError(404, "Book not found.");
  if (error.code === "23505") throw new AppError(409, "This translation request key is already in use.");
  if (error.code === "22023") throw new AppError(422, "The translation request is invalid. Save text in every chapter, use a different target language, and split chapters over 32,000 characters.");
  if (error.code === "PGRST202" || error.code === "42883") throw new AppError(503, "The translation database migration is not installed.");
  throw new AppError(500, "Could not queue translation.");
}

export function translationRoutes(app: FastifyInstance) {
  app.get("/books/:bookId/translation-quotes",async (req,reply)=>{
    const {bookId}=req.params as {bookId:string};
    if (!projectIdSchema.safeParse(bookId).success) throw new AppError(422,"Valid book ID required.");
    await loadBook(app.supabaseFactory(req.userToken),bookId,req.userId);
    const saved=await app.supabaseFactory().from("translation_quote_requests").select("*")
      .eq("book_id",bookId).eq("user_id",req.userId).order("created_at",{ascending:false}).limit(20);
    if (saved.error) throw new AppError(503,"Could not recover quote requests.");
    reply.header("cache-control","private, no-store");return {requests:(saved.data??[]).map(quoteRequestProgress)};
  });
  app.post("/books/:bookId/translation-quotes", async (req, reply) => {
    const {bookId}=req.params as {bookId:string};
    const body=z.object({targetLanguage:languageSchema,modelId:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      idempotencyKey:z.string().min(8).max(200),allowProviderTokenCounting:z.literal(true)}).strict().safeParse(req.body);
    if (!projectIdSchema.safeParse(bookId).success || !body.success) throw new AppError(422,"Choose a model and language and consent to provider token counting.");
    await loadBook(app.supabaseFactory(req.userToken),bookId,req.userId,true);
    const catalog=readTranslationCatalog(process.env.TRANSLATION_PRICING_CATALOG_JSON,new Date().toISOString());
    if (!catalog.entries.some((entry)=>entry.id===body.data.modelId)) throw new AppError(422,"Choose an available translation model.");
    const queued=await app.supabaseFactory().rpc("request_translation_quote",{p_book_id:bookId,p_user_id:req.userId,
      p_target_language:body.data.targetLanguage,p_model_id:body.data.modelId,p_catalog_json:catalog,p_idempotency_key:body.data.idempotencyKey});
    if (queued.error) {
      if (queued.error.code==="42501") throw new AppError(403,"Editing access is required to request a quote.");
      if (queued.error.code==="54000") throw new AppError(429,"Quote request limit reached. Try again later.");
      if (queued.error.code==="23505") throw new AppError(409,"A quote is already preparing or this request key is in use. Recover the original request.");
      if (queued.error.code==="22023") throw new AppError(422,"Save text in every chapter, check chapter sizes and choose a different language.");
      throw new AppError(503,"Could not confirm quote preparation. Retry with the same request key.");
    }
    reply.header("cache-control","private, no-store");
    return reply.status(202).send(quoteRequestProgress(row(queued.data)));
  });
  app.get("/translation-quote-requests/:requestId", async (req,reply)=>{
    const {requestId}=req.params as {requestId:string};
    if (!projectIdSchema.safeParse(requestId).success) throw new AppError(422,"Valid quote request ID required.");
    const saved=await app.supabaseFactory().from("translation_quote_requests").select("*").eq("id",requestId).eq("user_id",req.userId).maybeSingle();
    if (saved.error) throw new AppError(503,"Could not load quote preparation.");
    if (!saved.data) throw new AppError(404,"Quote request not found.");
    await loadBook(app.supabaseFactory(req.userToken),saved.data.book_id,req.userId);
    reply.header("cache-control","private, no-store"); return quoteRequestProgress(saved.data);
  });
  app.post("/translation-quotes/:proposalId/accept", async (req, reply) => {
    const { proposalId } = req.params as { proposalId: string };
    const body = z.object({ expectedCredits: z.number().int().positive().max(2147483647) }).strict().safeParse(req.body);
    if (!projectIdSchema.safeParse(proposalId).success || !body.success) throw new AppError(422, "Confirm a valid translation quote and its credit total.");
    const service = app.supabaseFactory();
    const offer = await service.from("translation_quote_proposals").select("id,book_id")
      .eq("id", proposalId).eq("user_id", req.userId).maybeSingle();
    if (offer.error) throw new AppError(503,"Could not load your translation quote.");
    if (!offer.data) throw new AppError(404,"Translation quote not found.");
    const sb = app.supabaseFactory(req.userToken);
    await loadBook(sb,offer.data.book_id,req.userId,true);
    const accepted = await service.rpc("accept_translation_quote",{p_proposal_id:proposalId,p_user_id:req.userId,p_expected_credits:body.data.expectedCredits});
    if (accepted.error) {
      if (accepted.error.code === "42501") throw new AppError(403,"Editing access is required to accept this quote.");
      if (["23514","22023","23505","40001","40P01"].includes(accepted.error.code)) throw new AppError(409,"Quote could not be accepted. Check its expiry, credit total and available balance; no partial purchase was applied.");
      throw new AppError(503,"Could not confirm quote acceptance. Retry this same quote to recover its result.");
    }
    const project=row(accepted.data);
    if (!project) throw new AppError(503,"Could not confirm quote acceptance. Retry this same quote.");
    reply.header("cache-control","private, no-store");
    return reply.status(202).send(await hydrateProject(sb,project,false,req.userId));
  });
  app.get("/translations/models", async (_req, reply) => {
    const catalog = readTranslationCatalog(process.env.TRANSLATION_PRICING_CATALOG_JSON, new Date().toISOString());
    reply.header("cache-control", "private, no-store");
    return availableTranslationModels(catalog);
  });
  app.get("/translations/:projectId/billing", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    if (!projectIdSchema.safeParse(projectId).success) throw new AppError(422, "Valid translation project ID required.");
    const sb = app.supabaseFactory(req.userToken);
    const { data: project, error } = await sb.from("translation_projects").select("id,book_id,workspace_id,created_by").eq("id", projectId).maybeSingle();
    if (error) throw new AppError(503, "Could not load translation billing.");
    if (!project) throw new AppError(404, "Translation project not found.");
    await loadBook(sb, project.book_id, req.userId);
    if (project.created_by !== req.userId) throw new AppError(403, "Only the translation payer can view its billing.");
    const { data: chapters, error: chapterError } = await sb.from("translation_chapters").select("ai_job_id").eq("project_id", projectId);
    const ids = z.array(z.object({ ai_job_id: z.string().uuid() })).min(1).safeParse(chapters);
    if (chapterError || !ids.success) throw new AppError(503, "Translation billing is not available yet.");
    const jobIds = ids.data.map((c) => c.ai_job_id);
    // Service access only AFTER user-scoped book/membership and payer checks.
    const quotes = await app.supabaseFactory().from("funded_usage_quotes")
      .select("job_id,user_id,workspace_id,reserved_credits,status,settlement_json")
      .eq("user_id", req.userId).eq("workspace_id", project.workspace_id).in("job_id", jobIds);
    if (quotes.error) throw new AppError(503, "Could not load translation billing. Refresh before making another payment.");
    reply.header("cache-control", "private, no-store");
    return summarizeTranslationBilling(quotes.data, jobIds, req.userId, project.workspace_id);
  });
  app.post("/translations/:projectId/cancel", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    if (!projectIdSchema.safeParse(projectId).success) throw new AppError(422, "Valid translation project ID required.");
    if (!z.object({}).strict().safeParse(req.body ?? {}).success) throw new AppError(422, "Cancellation does not accept user IDs or refund amounts.");
    const sb = app.supabaseFactory(req.userToken);
    const { data: project, error } = await sb.from("translation_projects").select("id,book_id,created_by").eq("id", projectId).maybeSingle();
    if (error) throw new AppError(500, "Could not load translation project.");
    if (!project) throw new AppError(404, "Translation project not found.");
    await loadBook(sb, project.book_id, req.userId, true);
    if (project.created_by !== req.userId) throw new AppError(403, "Only the translation creator can cancel it.");
    const cancelled = await app.supabaseFactory().rpc("cancel_quoted_translation", { p_project_id: projectId, p_user_id: req.userId });
    if (cancelled.error) {
      if (cancelled.error.code === "42501") throw new AppError(403, "Translation cancellation access denied.");
      if (["23514", "55P03", "40001", "40P01"].includes(cancelled.error.code)) throw new AppError(409, "Translation may already be processing. Refresh its status; no cancellation refund was applied.");
      if (["PGRST202", "42883"].includes(cancelled.error.code)) throw new AppError(503, "Translation cancellation is not configured.");
      throw new AppError(500, "Could not confirm translation cancellation. Refresh before retrying.");
    }
    const result = z.object({ projectId: z.literal(projectId), status: z.literal("cancelled"), releasedCredits: z.string().regex(/^\d+$/), cancelledChapters: z.number().int().positive() }).safeParse(cancelled.data);
    if (!result.success) throw new AppError(500, "Cancellation returned an invalid receipt. Refresh its status.");
    reply.header("cache-control", "private, no-store"); return result.data;
  });
  app.get("/books/:bookId/translations", async (req, reply) => {
    const { bookId } = req.params as { bookId: string };
    if (!projectIdSchema.safeParse(bookId).success) throw new AppError(422, "Valid book ID required.");
    const sb = app.supabaseFactory(req.userToken); await loadBook(sb, bookId, req.userId);
    const { data, error } = await sb.from("translation_projects").select("*").eq("book_id", bookId).order("created_at", { ascending: false }).limit(50);
    if (error) throw new AppError(500, "Could not load translation history.");
    reply.header("cache-control", "private, no-store");
    return { projects: await Promise.all((data ?? []).map((project) => hydrateProject(sb, project, false, req.userId))) };
  });

  app.get("/translations/:projectId", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    if (!projectIdSchema.safeParse(projectId).success) throw new AppError(422, "Valid translation project ID required.");
    const query = z.object({ includeText: z.enum(["true", "false"]).optional() }).safeParse(req.query);
    if (!query.success) throw new AppError(422, "Invalid translation query.");
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb.from("translation_projects").select("*").eq("id", projectId).maybeSingle();
    if (error) throw new AppError(500, "Could not load translation project.");
    if (!data) throw new AppError(404, "Translation project not found.");
    reply.header("cache-control", "private, no-store");
    return hydrateProject(sb, data, query.data.includeText === "true", req.userId);
  });

  app.post("/books/:bookId/translations", async (req, reply) => {
    const { bookId } = req.params as { bookId: string };
    if (!projectIdSchema.safeParse(bookId).success) throw new AppError(422, "Valid book ID required.");
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Choose a valid target language and request key.", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken); await loadBook(sb, bookId, req.userId, true);
    const queued = await sb.rpc("queue_translation_project", { p_book_id: bookId, p_target_language: parsed.data.targetLanguage, p_idempotency_key: parsed.data.idempotencyKey });
    if (queued.error) queueError(queued.error);
    const project = row(queued.data);
    if (!project) throw new AppError(500, "Translation queue returned no project.");
    reply.header("cache-control", "private, no-store");
    return reply.status(202).send(await hydrateProject(sb, project, false, req.userId));
  });

  app.post("/translations/:projectId/adopt", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    if (!projectIdSchema.safeParse(projectId).success) throw new AppError(422, "Valid translation project ID required.");
    const parsed = adoptSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Provide a title for the translated draft.", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const result = await sb.rpc("adopt_translation_project", { p_project_id: projectId, p_title: parsed.data.title });
    if (result.error) {
      if (result.error.code === "42501") throw new AppError(403, "Editing access is required to create the translated draft.");
      if (result.error.code === "P0002") throw new AppError(404, "Translation project not found.");
      if (result.error.code === "22023") throw new AppError(422, "Translation is not ready to create as a draft.");
      if (result.error.code === "PGRST202" || result.error.code === "42883") throw new AppError(503, "The translation database migration is not installed.");
      throw new AppError(500, "Could not create the translated draft.");
    }
    const book = row(result.data); if (!book) throw new AppError(500, "Translated draft returned no book.");
    reply.header("cache-control", "private, no-store");
    return reply.status(201).send({ book });
  });
}
