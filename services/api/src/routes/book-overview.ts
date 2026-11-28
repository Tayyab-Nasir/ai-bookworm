import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { loadBook } from "../lib/authoring.js";
import { RETAILER_SUBMISSION_STATUSES } from "@bookworm/types";
import { jobSummary } from "../lib/job-summary.js";
import type { SupabaseClient } from "../lib/supabase.js";

const unavailable = () => new AppError(503, "The saved book overview is temporarily unavailable. No book changes were made.");
const number = z.number().int().nonnegative().safe();
const chapterSchema = z.object({ id: z.guid(), book_id: z.guid(), title: z.string().min(1).max(500), order_index: number,
  current_document_version_id: z.guid().nullable() });
const versionSchema = z.object({ id: z.guid(), chapter_id: z.guid(), version_number: number.min(1), word_count: number,
  created_at: z.string().datetime({ offset: true }) });
const editionSchema = z.object({ id: z.guid(), book_id: z.guid(), type: z.enum(["ebook", "print", "audiobook"]),
  status: z.string().min(1).max(40), updated_at: z.string().datetime({ offset: true }), edition_metadata_json: z.record(z.string(), z.unknown()) });
const jobSchema = z.object({ id: z.guid(), book_id: z.guid(), status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  created_at: z.string().datetime({ offset: true }), completed_at: z.string().datetime({ offset: true }).nullable(),
  agent_type: z.string().optional(), channel: z.string().optional(), action: z.string().nullable().optional() });
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw unavailable();
  return result.data;
}
function exactCount(result: { error: unknown; count: number | null }) {
  if (result.error || !number.safeParse(result.count).success) throw unavailable();
  return result.count!;
}

async function managedPublications(sb: SupabaseClient, bookId: string, workspaceId: string) {
  const { data, error } = await sb.from("managed_publishing_requests")
    .select("package_job_id,workspace_id,confirmed_at,job:publishing_jobs!inner(id,book_id,channel)")
    .eq("workspace_id", workspaceId).eq("job.book_id", bookId).not("confirmed_at", "is", null)
    .order("confirmed_at", { ascending: false }).order("package_job_id").limit(8);
  const parsed = z.array(z.object({
    package_job_id: z.guid(), workspace_id: z.literal(workspaceId), confirmed_at: z.string().datetime({ offset: true }),
    job: z.object({ id: z.guid(), book_id: z.literal(bookId), channel: z.enum(["kdp", "apple", "barnesnoble", "lulu", "googleplay"]) }),
  })).max(8).safeParse(data);
  if (error || !parsed.success || parsed.data.some(row => row.package_job_id !== row.job.id)) throw unavailable();
  return { status: "ready" as const, rows: parsed.data.map(row => ({
    jobId: row.package_job_id, channel: row.job.channel, confirmedAt: row.confirmed_at,
  })) };
}

async function retailerStatuses(sb: SupabaseClient, bookId: string) {
  const { data, error } = await sb.from("retailer_submissions")
    .select("publishing_job_id,status,updated_at,job:publishing_jobs!inner(id,book_id,channel,status,action:request_json->>action)")
    .eq("job.book_id", bookId).eq("job.status", "succeeded").eq("job.request_json->>action", "export_package")
    .order("updated_at", { ascending: false }).order("publishing_job_id").limit(8);
  const parsed = z.array(z.object({
    publishing_job_id: z.guid(), status: z.enum(RETAILER_SUBMISSION_STATUSES), updated_at: z.string().datetime({ offset: true }),
    job: z.object({ id: z.guid(), book_id: z.literal(bookId), status: z.literal("succeeded"), action: z.literal("export_package"),
      channel: z.enum(["kdp", "apple", "barnesnoble", "lulu", "googleplay"]) }),
  })).max(8).safeParse(data);
  if (error || !parsed.success || parsed.data.some(row => row.publishing_job_id !== row.job.id)
    || new Set(parsed.data.map(row => row.publishing_job_id)).size !== parsed.data.length) throw unavailable();
  return { status: "ready" as const, rows: parsed.data.map(row => ({
    jobId: row.publishing_job_id, channel: row.job.channel, status: row.status, updatedAt: row.updated_at,
  })) };
}

/** One user-scoped, read-only projection. No provider, Storage link or service-role access. */
export function bookOverviewRoutes(app: FastifyInstance) {
  app.get("/books/:bookId/overview", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const params = z.object({ bookId: z.guid() }).safeParse(req.params);
    const query = z.object({ retailerStatuses: z.literal("1").optional() }).safeParse(req.query);
    if (!params.success) throw new AppError(422, "Choose a valid book.");
    if (!query.success) throw new AppError(422, "Check the book overview options.");
    const { bookId } = params.data;
    const sb = app.supabaseFactory(req.userToken);
    const { book, role } = await loadBook(sb, bookId, req.userId);
    const bookFields = checked(z.object({ id: z.literal(bookId), workspace_id: z.guid(), title: z.string().min(1).max(500),
      subtitle: z.string().max(500).nullable(), author_name: z.string().min(1).max(300), language: z.string().min(1).max(40),
      genre: z.string().max(200).nullable(), status: z.string().min(1).max(40), updated_at: z.string().datetime({ offset: true }) }), book);
    const [space, chapters, bible, metadata, editions, imports, ai, publishing, audiobookExports, renders, packages, publications, submissions] = await Promise.all([
      sb.from("workspaces").select("id,name").eq("id", bookFields.workspace_id).maybeSingle(),
      sb.from("chapters").select("id,book_id,title,order_index,current_document_version_id").eq("book_id", bookId).order("order_index").limit(501),
      sb.from("book_bible_items").select("id", { count: "exact", head: true }).eq("book_id", bookId),
      sb.from("book_metadata").select("book_id,description,keywords,categories,isbn13").eq("book_id", bookId).maybeSingle(),
      sb.from("editions").select("id,book_id,type,status,updated_at,edition_metadata_json", { count: "exact" }).eq("book_id", bookId).order("updated_at", { ascending: false }).limit(12),
      sb.from("manuscript_import_jobs").select("id,book_id,status,created_at,completed_at").eq("book_id", bookId).order("created_at", { ascending: false }).limit(4),
      sb.from("ai_jobs").select("id,book_id,agent_type,status,created_at,completed_at").eq("book_id", bookId).eq("workspace_id", bookFields.workspace_id).order("created_at", { ascending: false }).limit(4),
      sb.from("publishing_jobs").select("id,book_id,channel,status,created_at,completed_at,action:request_json->>action").eq("book_id", bookId).order("created_at", { ascending: false }).limit(4),
      sb.from("audiobook_google_play_export_jobs").select("id,book_id,status,created_at,completed_at").eq("book_id", bookId).eq("workspace_id", bookFields.workspace_id).order("created_at", { ascending: false }).limit(4),
      sb.from("publishing_jobs").select("id", { count: "exact", head: true }).eq("book_id", bookId).eq("status", "succeeded").contains("request_json", { action: "render" }),
      sb.from("publishing_jobs").select("id", { count: "exact", head: true }).eq("book_id", bookId).eq("status", "succeeded").contains("request_json", { action: "export_package" }),
      process.env.MANAGED_PUBLISHING_ENABLED === "true" && (role === "owner" || role === "admin")
        ? managedPublications(sb, bookId, bookFields.workspace_id).catch(() => ({ status: "unavailable" as const }))
        : undefined,
      query.data.retailerStatuses
        ? retailerStatuses(sb, bookId).catch(() => ({ status: "unavailable" as const }))
        : undefined,
    ]);
    if ([space, chapters, metadata, editions, imports, ai, publishing, audiobookExports].some(r => r.error)) throw unavailable();
    const workspace = checked(z.object({ id: z.literal(bookFields.workspace_id), name: z.string().min(1).max(200) }), space.data);
    const chapterRows = checked(z.array(chapterSchema).max(500), chapters.data);
    if (chapterRows.some(c => c.book_id !== bookId) || new Set(chapterRows.map(c => c.id)).size !== chapterRows.length) throw unavailable();
    const pointers = chapterRows.flatMap(c => c.current_document_version_id ? [c.current_document_version_id] : []);
    if (new Set(pointers).size !== pointers.length) throw unavailable();
    const versions = pointers.length ? await sb.from("document_versions").select("id,chapter_id,version_number,word_count,created_at")
      .in("id", pointers).in("chapter_id", chapterRows.map(c => c.id)).limit(500) : { data: [], error: null };
    if (versions.error) throw unavailable();
    const versionRows = checked(z.array(versionSchema).max(500), versions.data);
    const byId = new Map(versionRows.map(v => [v.id, v]));
    if (byId.size !== pointers.length || versionRows.length !== pointers.length) throw unavailable();
    const savedChapters = chapterRows.map(c => {
      const v = c.current_document_version_id ? byId.get(c.current_document_version_id) : null;
      if (v && v.chapter_id !== c.id || c.current_document_version_id && !v) throw unavailable();
      return { id: c.id, title: c.title, orderIndex: c.order_index, versionNumber: v?.version_number ?? null,
        wordCount: v?.word_count ?? 0, updatedAt: v?.created_at ?? null };
    });
    const listing = metadata.data === null ? null : checked(z.object({ book_id: z.literal(bookId), description: z.string().nullable(),
      keywords: z.array(z.string()), categories: z.array(z.string()), isbn13: z.string().nullable() }), metadata.data);
    const editionRows = checked(z.array(editionSchema).max(12), editions.data);
    if (editionRows.some(e => e.book_id !== bookId)) throw unavailable();
    const jobs = ([ ["import", imports], ["ai", ai], ["publishing", publishing], ["audiobook_export", audiobookExports] ] as const).flatMap(([kind, result]) => {
      const rows = checked(z.array(jobSchema).max(4), result.data);
      if (rows.some(j => j.book_id !== bookId)) throw unavailable();
      return rows.map(j => {
        return { id: j.id, kind, ...jobSummary(kind, j), status: j.status, createdAt: j.created_at, completedAt: j.completed_at };
      });
    }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 12);
    const wordCount = savedChapters.reduce((n, c) => n + c.wordCount, 0);
    if (!Number.isSafeInteger(wordCount)) throw unavailable();
    return {
      viewerId: req.userId, observedAt: new Date().toISOString(),
      book: { id: bookId, workspaceId: workspace.id, title: bookFields.title, subtitle: bookFields.subtitle, authorName: bookFields.author_name,
        language: bookFields.language, genre: bookFields.genre, status: bookFields.status, updatedAt: bookFields.updated_at },
      workspace: { id: workspace.id, name: workspace.name, role },
      manuscript: { chapterCount: savedChapters.length, wordCount, chaptersWithoutSavedVersion: savedChapters.filter(c => c.versionNumber === null).length },
      chapters: savedChapters, bibleItems: exactCount(bible),
      listing: { description: Boolean(listing?.description?.trim()), keywords: listing?.keywords.length ?? 0,
        categories: listing?.categories.length ?? 0, isbn: Boolean(listing?.isbn13?.trim()) },
      editionsTotal: exactCount(editions), editions: editionRows.map(e => {
        const cover = e.edition_metadata_json.cover as { asset_id?: unknown } | null;
        return { id: e.id, kind: e.type, status: e.status, updatedAt: e.updated_at,
          coverArtworkChosen: z.guid().safeParse(cover?.asset_id).success };
      }),
      history: { renders: exactCount(renders), packages: exactCount(packages) }, jobs,
      ...(publications ? { managedPublications: publications } : {}),
      ...(submissions ? { retailerStatuses: submissions } : {}),
    };
  });
}
