import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceApprover, requireWorkspaceMember } from "../lib/authorize.js";
import { segmentSpeechText } from "../lib/speech-generation.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { assembleChapterAudio, loadChapterAudio } from "../lib/audio-download.js";
import { googlePlayIdentifierSchemaSafe } from "../lib/google-play-audio-export.js";

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
const signoffSchema = z.object({ reportId: z.string().uuid(), listenedToExactAudio: z.literal(true) }).strict();
const googlePlayExportSchema = z.object({
  identifier: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u)
    .refine(googlePlayIdentifierSchemaSafe, "Use a valid ISBN-13 or a safe publisher/Google book identifier."),
  coverAssetId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

function publicExportJob(job: Record<string, unknown>, downloadUrl: string | null = null) {
  return {
    id: job.id, editionId: job.edition_id, status: job.status,
    progressChapters: job.progress_chapters, progressTotal: job.progress_total,
    errorCode: job.error_code ?? null, createdAt: job.created_at, completedAt: job.completed_at ?? null,
    downloadUrl, downloadExpiresIn: downloadUrl ? 300 : null,
    archiveSizeBytes: job.output_size_bytes ?? null,
    totalDurationSeconds: job.total_duration_seconds ?? null,
    synthesizedVoiceDisclosureRequired: true,
  };
}

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
  app.post("/editions/:editionId/audiobook-google-play-export", async (req, reply) => {
    const { editionId } = req.params as { editionId: string };
    const parsed = googlePlayExportSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Enter a valid book identifier and choose a cover image.", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb.rpc("queue_audiobook_google_play_export", {
      p_edition_id: editionId, p_identifier: parsed.data.identifier,
      p_cover_asset_id: parsed.data.coverAssetId, p_idempotency_key: parsed.data.idempotencyKey,
    });
    if (error) {
      if (error.code === "42501") throw new AppError(403, "An audiobook workspace approver must create this export.");
      if (error.code === "P0002") throw new AppError(404, "Audiobook edition not found.");
      if (["22023", "23514"].includes(error.code)) throw new AppError(422, "Every current chapter needs signed quality review and a valid private cover before export.");
      if (error.code === "54000") throw new AppError(429, "This workspace already has two active audiobook exports. Wait for one to finish or cancel it.");
      if (error.code === "23505") throw new AppError(409, "This export request key is already in use.");
      throw new AppError(503, "Could not queue the audiobook export.");
    }
    const job = Array.isArray(data) ? data[0] : data;
    if (!job) throw new AppError(503, "Export queue returned no job.");
    reply.header("cache-control", "private, no-store");
    return reply.status("queued" === job.status ? 202 : 200).send({ job: publicExportJob(job) });
  });
  app.get("/editions/:editionId/audiobook-google-play-exports", async (req, reply) => {
    const { editionId } = req.params as { editionId: string };
    if (!z.string().uuid().safeParse(editionId).success) throw new AppError(404, "Audiobook edition not found.");
    const userClient = app.supabaseFactory(req.userToken);
    const { data: jobs, error } = await userClient.from("audiobook_google_play_export_jobs").select("*")
      .eq("edition_id", editionId).order("created_at", { ascending: false }).limit(20);
    if (error) throw new AppError(503, "Could not load audiobook export history.");
    const service = (jobs ?? []).some((job) => job.status === "succeeded") ? app.supabaseFactory() : null;
    const result = await Promise.all((jobs ?? []).map(async (job) => {
      let downloadUrl: string | null = null;
      if (service && job.status === "succeeded" && typeof job.output_storage_path === "string") {
        const signed = await service.storage.from(BUCKET).createSignedUrl(job.output_storage_path, 300, { download: `${job.identifier}.zip` });
        if (signed.error || !signed.data?.signedUrl) throw new AppError(503, "Could not prepare a private export download.");
        downloadUrl = signed.data.signedUrl;
      }
      return publicExportJob(job, downloadUrl);
    }));
    reply.header("cache-control", "private, no-store");
    return { jobs: result };
  });
  app.get("/audiobook-google-play-exports/:jobId", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!z.string().uuid().safeParse(jobId).success) throw new AppError(404, "Audiobook export not found.");
    const userClient = app.supabaseFactory(req.userToken);
    const { data: job, error } = await userClient.from("audiobook_google_play_export_jobs").select("*").eq("id", jobId).maybeSingle();
    if (error) throw new AppError(503, "Could not refresh audiobook export progress.");
    if (!job) throw new AppError(404, "Audiobook export not found.");
    let downloadUrl: string | null = null;
    if (job.status === "succeeded" && typeof job.output_storage_path === "string") {
      const service = app.supabaseFactory();
      const signed = await service.storage.from(BUCKET).createSignedUrl(job.output_storage_path, 300, { download: `${job.identifier}.zip` });
      if (signed.error || !signed.data?.signedUrl) throw new AppError(503, "Could not prepare the private export download.");
      downloadUrl = signed.data.signedUrl;
    }
    reply.header("cache-control", "private, no-store");
    return { job: publicExportJob(job, downloadUrl) };
  });
  app.post("/audiobook-google-play-exports/:jobId/cancel", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!z.string().uuid().safeParse(jobId).success) throw new AppError(404, "Audiobook export not found.");
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb.rpc("cancel_audiobook_google_play_export", { p_job_id: jobId });
    if (error) {
      if (error.code === "P0002") throw new AppError(404, "Audiobook export not found.");
      throw new AppError(503, "Could not cancel the audiobook export.");
    }
    const job = Array.isArray(data) ? data[0] : data;
    if (!job) throw new AppError(404, "Audiobook export not found.");
    reply.header("cache-control", "private, no-store");
    return { job: publicExportJob(job) };
  });
  app.get("/audiobook-jobs/:projectId/audio-download", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const key = `${req.userId}:${projectId}`;
    if (assembling.has(key) || assembling.size >= 2) throw new AppError(429, "Audio assembly is busy. Try again shortly.");
    assembling.add(key);
    try {
      const caller = app.supabaseFactory(req.userToken);
      const loaded = await loadChapterAudio(caller, projectId);
      const result = await assembleChapterAudio(loaded.segments, options.fetcher);
      reply.header("x-bookworm-audio-sha256", result.audioSha256);
      if (result.quality) {
        reply.header("x-bookworm-audio-qc", JSON.stringify(result.quality));
        try {
          const service = app.supabaseFactory();
          const report = {
            project_id: loaded.projectId,
            document_version_id: loaded.documentVersionId,
            audio_sha256: result.audioSha256,
            source_manifest_sha256: loaded.sourceManifestSha256,
            quality_report: result.quality,
            created_by: req.userId,
          };
          const inserted = await service.from("audiobook_qc_reports").insert(report)
            .select("id,document_version_id,source_manifest_sha256").maybeSingle();
          let reportId = inserted.data?.id as string | undefined;
          if (inserted.error?.code === "23505") {
            const existing = await service.from("audiobook_qc_reports").select("id,document_version_id,source_manifest_sha256")
              .eq("project_id", loaded.projectId).eq("audio_sha256", result.audioSha256).maybeSingle();
            if (existing.error || !existing.data || existing.data.document_version_id !== loaded.documentVersionId
              || existing.data.source_manifest_sha256 !== loaded.sourceManifestSha256) {
              throw new Error("QC report replay identity mismatch");
            }
            reportId = existing.data.id as string;
          } else if (inserted.error || !reportId) {
            throw new Error("QC report insert failed");
          }
          reply.header("x-bookworm-audio-qc-report-id", reportId);
        } catch {
          req.log.warn({ projectId }, "Audiobook QC report history could not be persisted");
          reply.header("x-bookworm-audio-qc-history", "unavailable");
        }
      }
      return reply.header("cache-control", "private, no-store").header("content-disposition", 'attachment; filename="chapter.mp3"').type("audio/mpeg").send(result.bytes);
    } finally { assembling.delete(key); }
  });
  app.get("/audiobook-jobs/:projectId/qc-reports", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const sb = app.supabaseFactory(req.userToken);
    const { data: project, error: projectError } = await sb.from("audiobook_projects")
      .select("id,workspace_id,chapter_id,document_version_id").eq("id", projectId).maybeSingle();
    if (projectError) throw new AppError(503, "Could not load audiobook QC history.");
    if (!project) throw new AppError(404, "Audiobook job not found.");
    await requireWorkspaceMember(sb, project.workspace_id, req.userId);
    const [{ data: reports, error: reportsError }, { data: chapter, error: chapterError }] = await Promise.all([
      sb.from("audiobook_qc_reports").select("id,document_version_id,audio_sha256,source_manifest_sha256,quality_report,created_by,created_at")
        .eq("project_id", projectId).order("created_at", { ascending: false }).limit(20),
      sb.from("chapters").select("current_document_version_id").eq("id", project.chapter_id).maybeSingle(),
    ]);
    if (reportsError || chapterError) throw new AppError(503, "Could not load audiobook QC history.");
    const reportIds = (reports ?? []).map((report) => report.id);
    const { data: signoffs, error: signoffsError } = reportIds.length
      ? await sb.from("audiobook_qc_signoffs").select("report_id,reviewer_id,signed_at").in("report_id", reportIds)
      : { data: [], error: null };
    if (signoffsError) throw new AppError(503, "Could not load audiobook QC sign-offs.");
    const byReport = new Map<string, Array<{ reviewerId: string; signedAt: string }>>();
    for (const signoff of signoffs ?? []) {
      const list = byReport.get(signoff.report_id) ?? [];
      list.push({ reviewerId: signoff.reviewer_id, signedAt: signoff.signed_at });
      byReport.set(signoff.report_id, list);
    }
    reply.header("cache-control", "private, no-store");
    return { reports: (reports ?? []).map((report) => ({
      id: report.id,
      documentVersionId: report.document_version_id,
      audioSha256: report.audio_sha256,
      sourceManifestSha256: report.source_manifest_sha256,
      qualityReport: report.quality_report,
      createdBy: report.created_by,
      createdAt: report.created_at,
      isCurrentSource: report.document_version_id === chapter?.current_document_version_id,
      signoffs: byReport.get(report.id) ?? [],
      signedByMe: (byReport.get(report.id) ?? []).some((signoff) => signoff.reviewerId === req.userId),
    })) };
  });
  app.post("/audiobook-jobs/:projectId/qc-signoffs", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const parsed = signoffSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Confirm that you listened to this exact audiobook file.", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const { data: project, error: projectError } = await sb.from("audiobook_projects")
      .select("id,workspace_id,chapter_id,status").eq("id", projectId).maybeSingle();
    if (projectError) throw new AppError(503, "Could not verify the audiobook source.");
    if (!project || project.status !== "succeeded") throw new AppError(404, "Completed audiobook not found.");
    await requireWorkspaceApprover(sb, project.workspace_id, req.userId);
    const [{ data: report, error: reportError }, { data: chapter, error: chapterError }] = await Promise.all([
      sb.from("audiobook_qc_reports").select("id,document_version_id")
        .eq("id", parsed.data.reportId).eq("project_id", projectId).maybeSingle(),
      sb.from("chapters").select("current_document_version_id").eq("id", project.chapter_id).maybeSingle(),
    ]);
    if (reportError || chapterError) throw new AppError(503, "Could not verify this audio quality report.");
    if (!report) throw new AppError(404, "Audio quality report not found.");
    if (!chapter || report.document_version_id !== chapter.current_document_version_id) {
      throw new AppError(409, "This report belongs to an older manuscript version. Assemble the current narration before signing it off.");
    }
    const input = { report_id: report.id, reviewer_id: req.userId, listened_to_exact_audio: true };
    const inserted = await sb.from("audiobook_qc_signoffs").insert(input).select("signed_at").maybeSingle();
    let signedAt = inserted.data?.signed_at as string | undefined;
    if (inserted.error?.code === "23505") {
      const existing = await sb.from("audiobook_qc_signoffs").select("signed_at")
        .eq("report_id", report.id).eq("reviewer_id", req.userId).maybeSingle();
      if (existing.error || !existing.data) throw new AppError(503, "Could not confirm the saved sign-off.");
      signedAt = existing.data.signed_at as string;
    } else if (inserted.error || !signedAt) {
      throw new AppError(403, "Only a workspace reviewer with approval access can record this sign-off.");
    }
    reply.header("cache-control", "private, no-store");
    return reply.status(201).send({ reportId: report.id, signedAt, listenedToExactAudio: true });
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
