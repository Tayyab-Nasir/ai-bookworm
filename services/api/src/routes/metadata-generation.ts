import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { loadBook, parseNodes } from "../lib/authoring.js";
import { requireEntitlement } from "../lib/entitlements.js";
import type { SupabaseClient } from "../lib/supabase.js";

const uuid = z.string().uuid();
const generationRequest = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  chapterIds: z.array(uuid).min(1).max(5).optional(),
  audience: z.string().trim().min(1).max(500).optional(),
  tone: z.string().trim().min(1).max(200).optional(),
  maxTokens: z.number().int().min(4_096).max(16_000).default(12_000),
}).strict().superRefine((value, ctx) => {
  if (value.chapterIds && new Set(value.chapterIds).size !== value.chapterIds.length) {
    ctx.addIssue({ code: "custom", path: ["chapterIds"], message: "Do not repeat chapter IDs." });
  }
});

const candidateSourceRef = z.object({
  chapterId: uuid,
  documentVersionId: uuid.optional(),
  nodeId: z.string().trim().min(1).max(200),
  textHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();

const metadataCandidate = z.object({
  suggestionKind: z.literal("metadata_candidate"),
  description: z.string().trim().min(40).max(4_000),
  keywords: z.array(z.string().trim().min(1).max(100)).min(1).max(30),
  categories: z.array(z.string().trim().min(1).max(180)).min(1).max(20),
  audience: z.string().trim().min(1).max(500),
  rationale: z.string().trim().min(1).max(2_000),
  confidence: z.number().min(0).max(1).nullable(),
  sourceRefs: z.array(candidateSourceRef).min(1).max(30),
  status: z.literal("pending"),
}).strict().superRefine((value, ctx) => {
  for (const field of ["keywords", "categories"] as const) {
    const normalized = value[field].map((item) => item.toLocaleLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} must not contain duplicates.` });
    }
  }
});

const diagnostic = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(2_000),
  location: z.record(z.string(), z.unknown()),
}).strict();
const aiResponse = z.object({
  status: z.enum(["succeeded", "failed"]),
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  suggestions: z.array(z.unknown()).max(1),
  diagnostics: z.array(diagnostic).max(500).default([]),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().max(2_147_483_647).default(0),
    outputTokens: z.number().int().nonnegative().max(2_147_483_647).default(0),
    estimatedCostUsd: z.number().nonnegative().default(0),
    latencyMs: z.number().int().nonnegative().max(2_147_483_647).optional(),
  }).strict(),
  error: z.string().max(2_000).optional(),
}).passthrough();

type EvidenceRef = { chapterId: string; documentVersionId: string; nodeId: string; textHash: string };

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function boundedBible(rows: Record<string, unknown>[]) {
  const result: Record<string, unknown>[] = [];
  let remaining = 20_000;
  for (const row of rows) {
    const attributesText = JSON.stringify(row.attributes_json ?? {});
    const item = {
      id: row.id,
      type: row.type,
      name: truncateUtf8(String(row.name ?? ""), 320),
      description: truncateUtf8(String(row.description ?? ""), 2_000),
      attributes: Buffer.byteLength(attributesText) <= 4_000
        ? row.attributes_json ?? {}
        : { excerpt: truncateUtf8(attributesText, 4_000), truncated: true },
      sourceRefs: Array.isArray(row.source_refs_json) ? row.source_refs_json.slice(0, 10) : [],
    };
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (bytes > remaining) break;
    result.push(item);
    remaining -= bytes;
  }
  return result;
}

function candidateFromJob(job: Record<string, unknown>) {
  const output = job.output_ref as { candidate?: unknown } | null;
  const parsed = metadataCandidate.safeParse(output?.candidate);
  return parsed.success ? parsed.data : null;
}

async function markFailed(sb: SupabaseClient, jobId: string, code: string, message: string) {
  await sb.from("ai_jobs").update({
    status: "failed",
    error_code: code,
    error_message: message.slice(0, 2_000),
    completed_at: new Date().toISOString(),
  }).eq("id", jobId).in("status", ["queued", "running"]);
}

function validateCandidateSources(candidate: z.infer<typeof metadataCandidate>, evidence: EvidenceRef[]) {
  const chapters = new Map<string, EvidenceRef[]>();
  for (const ref of evidence) chapters.set(ref.chapterId, [...(chapters.get(ref.chapterId) ?? []), ref]);
  for (const source of candidate.sourceRefs) {
    const chapter = chapters.get(source.chapterId);
    if (!chapter) throw new AppError(503, "The AI provider cited content outside this request. Nothing was saved or charged.");
    const matching = chapter.filter((ref) => (!source.documentVersionId || ref.documentVersionId === source.documentVersionId)
      && (!source.nodeId || ref.nodeId === source.nodeId));
    if (!matching.length || (source.textHash && !matching.some((ref) => ref.textHash === source.textHash))) {
      throw new AppError(503, "The AI provider returned a stale or unverifiable citation. Nothing was saved or charged.");
    }
  }
}

export function metadataGenerationRoutes(app: FastifyInstance, options: { fetcher?: typeof fetch } = {}) {
  const fetcher = options.fetcher ?? fetch;

  app.get("/books/:bookId/metadata/drafts", async (req, reply) => {
    const bookId = uuid.safeParse((req.params as { bookId: string }).bookId);
    if (!bookId.success) throw new AppError(422, "Invalid book ID.");
    const user = app.supabaseFactory(req.userToken);
    await loadBook(user, bookId.data, req.userId);
    const { data, error } = await user.from("ai_jobs")
      .select("id,created_at,completed_at,output_ref")
      .eq("book_id", bookId.data).eq("agent_type", "metadata").eq("status", "succeeded")
      .order("created_at", { ascending: false }).limit(20);
    if (error) throw new AppError(500, "Could not load saved metadata drafts.");
    reply.header("cache-control", "private, no-store");
    return { drafts: (data ?? []).flatMap((job) => {
      const candidate = candidateFromJob(job);
      return candidate ? [{ id: job.id, createdAt: job.created_at, candidate }] : [];
    }) };
  });

  app.post("/books/:bookId/metadata/generate", async (req, reply) => {
    const parsed = generationRequest.safeParse(req.body);
    const parsedBookId = uuid.safeParse((req.params as { bookId: string }).bookId);
    if (!parsed.success || !parsedBookId.success) {
      throw new AppError(422, "Check the metadata generation request.", {
        issues: parsed.success ? [{ path: ["bookId"], message: "Invalid book ID." }] : parsed.error.issues,
      });
    }
    const body = parsed.data;
    const bookId = parsedBookId.data;
    const user = app.supabaseFactory(req.userToken);
    const { book } = await loadBook(user, bookId, req.userId, true);
    const service = app.supabaseFactory();

    const { data: replay, error: replayError } = await service.from("ai_jobs").select("*")
      .eq("idempotency_key", body.idempotencyKey)
      .eq("workspace_id", book.workspace_id)
      .eq("created_by", req.userId)
      .maybeSingle();
    if (replayError) throw new AppError(500, "Could not verify the metadata request key.");
    if (replay) {
      if (replay.book_id !== bookId || replay.agent_type !== "metadata") {
        throw new AppError(409, "That AI request key is already in use.");
      }
      if (replay.status === "failed") {
        throw new AppError(409, "This metadata generation request previously failed. Retry with a new request key.", {
          jobId: replay.id, status: replay.status, errorCode: replay.error_code ?? null,
        });
      }
      if (replay.status !== "succeeded" || !candidateFromJob(replay)) {
        throw new AppError(409, "This metadata generation request is still processing. Retry with the same request key.", {
          jobId: replay.id, status: replay.status,
        });
      }
      return reply.status(200).send({ job: replay, candidate: candidateFromJob(replay) });
    }

    const { data: workspace, error: workspaceError } = await service.from("workspaces")
      .select("organization_id").eq("id", book.workspace_id).maybeSingle();
    if (workspaceError || !workspace) throw new AppError(500, "Could not resolve AI usage for this workspace.");
    await requireEntitlement(service, workspace.organization_id, "ai_credits", 1);

    let chapterQuery = user.from("chapters").select("id,title,order_index,current_document_version_id")
      .eq("book_id", bookId).order("order_index").limit(5);
    if (body.chapterIds) chapterQuery = chapterQuery.in("id", body.chapterIds);
    const { data: chapters, error: chapterError } = await chapterQuery;
    if (chapterError) throw new AppError(500, "Could not load manuscript evidence.");
    if (body.chapterIds && chapters?.length !== body.chapterIds.length) {
      throw new AppError(422, "Every requested chapter must belong to this book.");
    }
    if (!chapters?.length) throw new AppError(422, "Add manuscript content before generating metadata.");

    const evidence: EvidenceRef[] = [];
    const chapterInput: Record<string, unknown> = {};
    const manuscriptBytes = Math.min(30_000, Math.floor(body.maxTokens * 1.8));
    const chapterBytes = Math.max(1, Math.floor(manuscriptBytes / chapters.length));
    for (const chapter of chapters) {
      if (!chapter.current_document_version_id) continue;
      const { data: version, error: versionError } = await user.from("document_versions").select("*")
        .eq("id", chapter.current_document_version_id).eq("chapter_id", chapter.id).maybeSingle();
      if (versionError) throw new AppError(500, "Could not load the current manuscript version.");
      if (!version) continue;
      const nodes = [];
      let remainingBytes = chapterBytes;
      for (const node of parseNodes(version.content_json)) {
        if (evidence.length >= 200) break;
        const rawText = typeof node.text === "string" ? node.text.trim() : "";
        if (!rawText || remainingBytes <= 0) continue;
        const text = truncateUtf8(rawText, Math.min(8_000, remainingBytes));
        if (!text) continue;
        remainingBytes -= Buffer.byteLength(text);
        const textHash = createHash("sha256").update(text).digest("hex");
        nodes.push({ ...node, text, textHash, truncated: text.length < rawText.length });
        evidence.push({ chapterId: chapter.id, documentVersionId: version.id, nodeId: node.id, textHash });
      }
      if (nodes.length) chapterInput[chapter.id] = {
        id: chapter.id,
        title: chapter.title,
        order: chapter.order_index,
        version: version.version_number,
        documentVersionId: version.id,
        nodes,
      };
    }
    if (!evidence.length) throw new AppError(422, "Add manuscript text before generating metadata.");

    const [{ data: bible, error: bibleError }, { data: style, error: styleError }] = await Promise.all([
      user.from("book_bible_items").select("id,type,name,description,attributes_json,source_refs_json")
        .eq("book_id", bookId).order("created_at").limit(50),
      user.from("style_guides").select("rules_json,tone,spelling_variant").eq("book_id", bookId).maybeSingle(),
    ]);
    if (bibleError || styleError) throw new AppError(500, "Could not assemble the approved metadata context.");

    const jobId = randomUUID();
    const contextRefs = evidence.map(({ chapterId, documentVersionId, nodeId, textHash }) => ({ chapterId, documentVersionId, nodeId, textHash }));
    const { data: job, error: insertError } = await service.from("ai_jobs").insert({
      id: jobId,
      workspace_id: book.workspace_id,
      book_id: bookId,
      agent_type: "metadata",
      status: "running",
      input_ref: {
        chapterVersions: [...new Map(evidence.map((ref) => [ref.chapterId, { chapterId: ref.chapterId, documentVersionId: ref.documentVersionId }])).values()],
        contextSources: contextRefs,
        requestedAudience: body.audience ?? null,
        requestedTone: body.tone ?? null,
        maxTokens: body.maxTokens,
      },
      idempotency_key: body.idempotencyKey,
      created_by: req.userId,
      started_at: new Date().toISOString(),
    }).select("*").single();
    if (insertError?.code === "23505") {
      const { data: existing } = await service.from("ai_jobs").select("*")
        .eq("idempotency_key", body.idempotencyKey)
        .eq("workspace_id", book.workspace_id)
        .eq("created_by", req.userId)
        .maybeSingle();
      if (!existing || existing.book_id !== bookId || existing.agent_type !== "metadata") {
        throw new AppError(409, "That AI request key is already in use.");
      }
      if (existing.status === "failed") {
        throw new AppError(409, "This metadata generation request previously failed. Retry with a new request key.", {
          jobId: existing.id, status: existing.status, errorCode: existing.error_code ?? null,
        });
      }
      if (existing.status !== "succeeded" || !candidateFromJob(existing)) {
        throw new AppError(409, "This metadata generation request is still processing. Retry with the same request key.", {
          jobId: existing.id, status: existing.status,
        });
      }
      return reply.status(200).send({ job: existing, candidate: candidateFromJob(existing) });
    }
    if (insertError || !job) throw new AppError(500, "Could not create the metadata AI job.");

    const serviceUrl = process.env.AI_SERVICE_URL ?? `http://127.0.0.1:${process.env.AI_SERVICE_PORT ?? "8000"}`;
    let raw: unknown;
    try {
      const response = await fetcher(`${serviceUrl.replace(/\/$/u, "")}/v1/ai/jobs`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(90_000),
        headers: {
          "content-type": "application/json",
          ...(process.env.AI_SERVICE_TOKEN ? { "x-service-token": process.env.AI_SERVICE_TOKEN } : {}),
        },
        body: JSON.stringify({
          jobId,
          workspaceId: book.workspace_id,
          bookId,
          agentType: "metadata",
          idempotencyKey: `api:${jobId}`,
          contextPolicy: {
            includeBookBible: true,
            includeStyleGuide: true,
            includeRelatedContext: false,
            semanticTopK: 5,
            maxTokens: body.maxTokens,
          },
          input: {
            chapterIds: Object.keys(chapterInput),
            chapters: chapterInput,
            book: { title: book.title, subtitle: book.subtitle ?? null, author: book.author_name, language: book.language },
            styleGuide: style ? { rules: style.rules_json, tone: style.tone, spellingVariant: style.spelling_variant } : {},
            bookBible: boundedBible((bible ?? []) as Record<string, unknown>[]),
            relatedContext: [],
            userInstruction: [
              "Create a reviewable retailer-neutral book description, discovery keywords, and categories from the cited manuscript evidence.",
              body.audience ? `Requested audience: ${body.audience}` : "",
              body.tone ? `Requested tone: ${body.tone}` : "",
            ].filter(Boolean).join("\n"),
          },
        }),
      });
      const text = await response.text();
      if (!response.ok || Buffer.byteLength(text) > 2_000_000) throw new Error("AI service rejected metadata generation");
      raw = JSON.parse(text);
    } catch {
      await markFailed(service, jobId, "ai_service_unavailable", "AI service unavailable");
      throw new AppError(503, "The AI service is unavailable. No metadata was saved or charged.");
    }

    const result = aiResponse.safeParse(raw);
    if (!result.success || result.data.status === "failed" || result.data.suggestions.length !== 1) {
      await markFailed(service, jobId, "ai_provider_failed", result.success ? result.data.error ?? "AI provider returned no metadata candidate" : "Invalid AI service response");
      throw new AppError(503, "The AI provider could not produce a valid metadata draft. Nothing was saved or charged.");
    }
    const candidate = metadataCandidate.safeParse(result.data.suggestions[0]);
    if (!candidate.success) {
      await markFailed(service, jobId, "invalid_ai_output", "Invalid metadata candidate");
      throw new AppError(503, "The AI provider returned an invalid metadata draft. Nothing was saved or charged.");
    }
    try {
      validateCandidateSources(candidate.data, evidence);
    } catch (error) {
      await markFailed(service, jobId, "invalid_ai_citation", error instanceof Error ? error.message : "Invalid AI citation");
      throw error;
    }

    const { data: completed, error: completionError } = await service.rpc("complete_metadata_ai_job", {
      p_job_id: jobId,
      p_provider: result.data.provider,
      p_model: result.data.model,
      p_usage: result.data.usage,
      p_diagnostics: result.data.diagnostics,
      p_candidate: candidate.data,
      p_credit_quantity: result.data.provider === "mock" ? 0 : 1,
    });
    if (completionError || !completed) {
      const { data: recovered } = await service.from("ai_jobs").select("*").eq("id", jobId).maybeSingle();
      if (recovered?.status === "succeeded" && candidateFromJob(recovered)) {
        return reply.status(200).send({ job: recovered, candidate: candidateFromJob(recovered) });
      }
      await markFailed(service, jobId, "ai_persistence_failed", "Metadata AI completion could not be persisted");
      if (completionError?.code === "PGRST202" || completionError?.code === "42883") {
        throw new AppError(503, "The metadata AI workflow migration is not installed. Nothing was charged.");
      }
      throw new AppError(500, "Could not persist the metadata draft. No success was recorded.");
    }
    const completedJob = (Array.isArray(completed) ? completed[0] : completed) as Record<string, unknown>;
    return reply.status(201).send({ job: completedJob, candidate: candidate.data });
  });
}
