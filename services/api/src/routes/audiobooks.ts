import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { segmentSpeechText } from "../lib/speech-generation.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { assembleChapterAudio, loadChapterAudio } from "../lib/audio-download.js";

const BUCKET = "book-assets";
const createSchema = z.object({
  chapterId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(8).max(200),
  aiDisclosureAccepted: z.literal(true),
}).strict();
const configSchema = z.object({
  kind: z.literal("audiobook"),
  voice: z.enum(["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"]).default("marin"),
  instructions: z.string().trim().min(1).max(2_000).nullable().default(null),
  speed: z.number().min(0.25).max(4).default(1),
}).passthrough();

async function hydrateProject(sb: SupabaseClient, project: Record<string, unknown>) {
  const { data: segments, error } = await sb.from("audiobook_segments").select("*")
    .eq("project_id", project.id).order("segment_index");
  if (error) throw new AppError(500, "Could not load narration segments.");
  const jobIds = (segments ?? []).map((segment) => segment.ai_job_id);
  const assetIds = (segments ?? []).map((segment) => segment.asset_id).filter(Boolean);
  const [{ data: jobs, error: jobsError }, { data: assets, error: assetsError }] = await Promise.all([
    jobIds.length ? sb.from("ai_jobs").select("id,status,error_code").in("id", jobIds) : Promise.resolve({ data: [], error: null }),
    assetIds.length ? sb.from("assets").select("*").in("id", assetIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (jobsError || assetsError) throw new AppError(500, "Could not load narration results.");
  const jobMap = new Map((jobs ?? []).map((job) => [job.id, job]));
  const assetMap = new Map((assets ?? []).map((asset) => [asset.id, asset]));
  const output = [];
  for (const segment of segments ?? []) {
    const asset = segment.asset_id ? assetMap.get(segment.asset_id) ?? null : null;
    let download: { url: string; expiresIn: number } | null = null;
    if (asset) {
      const signed = await sb.storage.from(BUCKET).createSignedUrl(asset.storage_path, 300);
      if (!signed.error && signed.data?.signedUrl) download = { url: signed.data.signedUrl, expiresIn: 300 };
    }
    const job = jobMap.get(segment.ai_job_id);
    output.push({ index: segment.segment_index, status: job?.status ?? "unknown", failureCode: job?.error_code ?? null, asset, download });
  }
  return {
    id: project.id,
    editionId: project.edition_id,
    chapterId: project.chapter_id,
    documentVersionId: project.document_version_id,
    voice: project.voice,
    speed: Number(project.speed),
    status: project.status,
    segmentCount: project.segment_count,
    creditUnits: project.credit_units,
    createdAt: project.created_at,
    completedAt: project.completed_at,
    aiVoiceDisclosureRequired: true,
    segments: output,
  };
}

export function audiobookRoutes(app: FastifyInstance, options: { fetcher?: typeof fetch } = {}) {
  // Bounded per API process; the renderer also serializes native assembly.
  const assembling = new Set<string>();
  app.get("/audiobook-jobs/:projectId/audio-download", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const key = `${req.userId}:${projectId}`;
    if (assembling.has(key) || assembling.size >= 2) throw new AppError(429, "Audio assembly is busy. Try again shortly.");
    assembling.add(key);
    try {
      const segments = await loadChapterAudio(app.supabaseFactory(req.userToken), projectId);
      const bytes = await assembleChapterAudio(segments, options.fetcher);
      return reply.header("cache-control", "private, no-store").header("content-disposition", 'attachment; filename="chapter.mp3"').type("audio/mpeg").send(bytes);
    } finally { assembling.delete(key); }
  });
  app.get("/editions/:editionId/audiobook-jobs", async (req) => {
    const { editionId } = req.params as { editionId: string };
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb.from("audiobook_projects").select("*")
      .eq("edition_id", editionId).order("created_at", { ascending: false }).limit(100);
    if (error) throw new AppError(500, "Could not load audiobook history.");
    return { projects: await Promise.all((data ?? []).map((project) => hydrateProject(sb, project))) };
  });

  app.get("/audiobook-jobs/:projectId", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb.from("audiobook_projects").select("*").eq("id", projectId).maybeSingle();
    if (error) throw new AppError(500, "Could not load audiobook job.");
    if (!data) throw new AppError(404, "Audiobook job not found.");
    reply.header("cache-control", "private, no-store");
    return hydrateProject(sb, data);
  });

  app.post("/editions/:editionId/audiobook-jobs", async (req, reply) => {
    const { editionId } = req.params as { editionId: string };
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Confirm AI narration and choose a valid chapter.", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const [{ data: edition, error: editionError }, { data: chapter, error: chapterError }] = await Promise.all([
      sb.from("editions").select("id,book_id,type,edition_metadata_json").eq("id", editionId).maybeSingle(),
      sb.from("chapters").select("id,book_id,current_document_version_id").eq("id", parsed.data.chapterId).maybeSingle(),
    ]);
    if (editionError || chapterError) throw new AppError(500, "Could not load the saved narration source.");
    if (!edition || edition.type !== "audiobook" || !chapter || chapter.book_id !== edition.book_id || !chapter.current_document_version_id) {
      throw new AppError(404, "Audiobook edition or chapter not found.");
    }
    const config = configSchema.safeParse(edition.edition_metadata_json);
    if (!config.success) throw new AppError(422, "Save valid audiobook voice settings before generating.");
    const { data: document, error: documentError } = await sb.from("document_versions").select("id,plain_text")
      .eq("id", chapter.current_document_version_id).eq("chapter_id", chapter.id).maybeSingle();
    if (documentError) throw new AppError(500, "Could not load the saved chapter version.");
    if (!document) throw new AppError(404, "The saved chapter version was not found.");
    const segments = segmentSpeechText(document.plain_text).map(({ text: _text, ...segment }) => segment);
    const queued = await sb.rpc("queue_audiobook_project", {
      p_edition_id: editionId,
      p_chapter_id: chapter.id,
      p_voice: config.data.voice,
      p_instructions: config.data.instructions,
      p_speed: config.data.speed,
      p_idempotency_key: parsed.data.idempotencyKey,
      p_segments: segments,
    });
    if (queued.error) {
      if (queued.error.code === "23514") throw new AppError(422, "Your audio credits are used or reserved. No narration was started.", undefined, "audio_credit_capacity_exhausted");
      if (queued.error.code === "42501") throw new AppError(403, "Editing access is required to generate narration.");
      if (queued.error.code === "P0002") throw new AppError(404, "Audiobook edition or chapter not found.");
      if (queued.error.code === "23505") throw new AppError(409, "This narration request key is already in use.");
      if (queued.error.code === "22023") throw new AppError(422, "The saved narration request is invalid.");
      throw new AppError(500, "Could not queue audiobook narration.");
    }
    const project = Array.isArray(queued.data) ? queued.data[0] : queued.data;
    if (!project) throw new AppError(500, "Audiobook queue returned no job.");
    return reply.status(202).send(await hydrateProject(sb, project));
  });
}
