import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { loadBook } from "../lib/authoring.js";

const unavailable = () => new AppError(503, "The saved book overview is temporarily unavailable. No book changes were made.");
const number = z.number().int().nonnegative().safe();
const chapterSchema = z.object({ id: z.string().uuid(), book_id: z.string().uuid(), title: z.string().min(1).max(500), order_index: number,
  current_document_version_id: z.string().uuid().nullable() });
const versionSchema = z.object({ id: z.string().uuid(), chapter_id: z.string().uuid(), version_number: number.min(1), word_count: number,
  created_at: z.string().datetime({ offset: true }) });
const editionSchema = z.object({ id: z.string().uuid(), book_id: z.string().uuid(), type: z.enum(["ebook", "print", "audiobook"]),
  status: z.string().min(1).max(40), updated_at: z.string().datetime({ offset: true }), edition_metadata_json: z.record(z.unknown()) });
const jobSchema = z.object({ id: z.string().uuid(), book_id: z.string().uuid(), status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  created_at: z.string().datetime({ offset: true }), completed_at: z.string().datetime({ offset: true }).nullable(),
  agent_type: z.string().optional(), channel: z.string().optional(), action: z.string().nullable().optional() });
const aiLabels: Record<string, [string, "editor" | "memory" | "publish" | "translate"]> = {
  writer: ["AI writing", "editor"], proofreader: ["Proofreading", "editor"], copyeditor: ["Copy editing", "editor"],
  consistency: ["Consistency review", "editor"], book_bible: ["Book Bible extraction", "memory"],
  metadata: ["Listing proposal", "memory"], illustrator: ["Illustration", "publish"], cover_designer: ["Book cover", "publish"],
  translator: ["Translation", "translate"], narrator: ["Audiobook narration", "publish"],
};
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw unavailable();
  return result.data;
}
function exactCount(result: { error: unknown; count: number | null }) {
  if (result.error || !number.safeParse(result.count).success) throw unavailable();
  return result.count!;
}

/** One user-scoped, read-only projection. No provider, Storage link or service-role access. */
export function bookOverviewRoutes(app: FastifyInstance) {
  app.get("/books/:bookId/overview", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const params = z.object({ bookId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) throw new AppError(422, "Choose a valid book.");
    const { bookId } = params.data;
    const sb = app.supabaseFactory(req.userToken);
    const { book, role } = await loadBook(sb, bookId, req.userId);
    const bookFields = checked(z.object({ id: z.literal(bookId), workspace_id: z.string().uuid(), title: z.string().min(1).max(500),
      subtitle: z.string().max(500).nullable(), author_name: z.string().min(1).max(300), language: z.string().min(1).max(40),
      genre: z.string().max(200).nullable(), status: z.string().min(1).max(40), updated_at: z.string().datetime({ offset: true }) }), book);
    const [space, chapters, bible, metadata, editions, imports, ai, publishing, renders, packages] = await Promise.all([
      sb.from("workspaces").select("id,name").eq("id", bookFields.workspace_id).maybeSingle(),
      sb.from("chapters").select("id,book_id,title,order_index,current_document_version_id").eq("book_id", bookId).order("order_index").limit(501),
      sb.from("book_bible_items").select("id", { count: "exact", head: true }).eq("book_id", bookId),
      sb.from("book_metadata").select("book_id,description,keywords,categories,isbn13").eq("book_id", bookId).maybeSingle(),
      sb.from("editions").select("id,book_id,type,status,updated_at,edition_metadata_json", { count: "exact" }).eq("book_id", bookId).order("updated_at", { ascending: false }).limit(12),
      sb.from("manuscript_import_jobs").select("id,book_id,status,created_at,completed_at").eq("book_id", bookId).order("created_at", { ascending: false }).limit(4),
      sb.from("ai_jobs").select("id,book_id,agent_type,status,created_at,completed_at").eq("book_id", bookId).eq("workspace_id", bookFields.workspace_id).order("created_at", { ascending: false }).limit(4),
      sb.from("publishing_jobs").select("id,book_id,channel,status,created_at,completed_at,action:request_json->>action").eq("book_id", bookId).order("created_at", { ascending: false }).limit(4),
      sb.from("publishing_jobs").select("id", { count: "exact", head: true }).eq("book_id", bookId).eq("status", "succeeded").contains("request_json", { action: "render" }),
      sb.from("publishing_jobs").select("id", { count: "exact", head: true }).eq("book_id", bookId).eq("status", "succeeded").contains("request_json", { action: "export_package" }),
    ]);
    if ([space, chapters, metadata, editions, imports, ai, publishing].some(r => r.error)) throw unavailable();
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
    const jobs = ([ ["import", imports], ["ai", ai], ["publishing", publishing] ] as const).flatMap(([kind, result]) => {
      const rows = checked(z.array(jobSchema).max(4), result.data);
      if (rows.some(j => j.book_id !== bookId)) throw unavailable();
      return rows.map(j => {
        const [label, destination] = kind === "import" ? ["Manuscript import", "editor"] as const
          : kind === "ai" ? aiLabels[j.agent_type ?? ""] ?? ["AI task", "editor"] as const
          : [({ render: "Edition render", validate: "Channel preflight", preflight: "Channel preflight", export_package: "Retailer package" } as Record<string, string>)[j.action ?? ""] ?? "Publishing task", "publish"] as const;
        return { id: j.id, kind, label, status: j.status, createdAt: j.created_at, completedAt: j.completed_at, destination };
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
          coverArtworkChosen: z.string().uuid().safeParse(cover?.asset_id).success };
      }),
      history: { renders: exactCount(renders), packages: exactCount(packages) }, jobs,
    };
  });
}
