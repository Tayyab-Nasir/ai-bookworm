import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceMember } from "../lib/authorize.js";
import { currentEntitlements, monthUsage } from "../lib/entitlements.js";
import { jobSummary } from "../lib/job-summary.js";
import { loadRetailerSalesSummary } from "./sales.js";

const querySchema = z.object({ workspaceId: z.string().uuid() }).strict();
const activeJobStatuses = ["queued", "running"];
const meters = [
  "ai_credits", "image_credits", "audio_credits", "translation_credits",
  "storage_gb", "seats", "rendering", "publishing",
] as const;

const queues = [
  { kind: "import", table: "manuscript_import_jobs", label: "Manuscript imports", columns: "id,book_id,status,created_at,completed_at" },
  { kind: "ai", table: "ai_jobs", label: "AI generation", columns: "id,workspace_id,book_id,agent_type,status,created_at,completed_at" },
  { kind: "publishing", table: "publishing_jobs", label: "Publishing", columns: "id,book_id,status,created_at,completed_at,action:request_json->>action" },
  { kind: "audiobook_export", table: "audiobook_google_play_export_jobs", label: "Audiobook exports", columns: "id,workspace_id,book_id,status,created_at,completed_at" },
] as const;
const unavailable = () => new AppError(503, "Dashboard activity is temporarily unavailable. Reload before relying on job counts.");
const countSchema = z.number().int().nonnegative().safe();
const jobSchema = z.object({ id: z.string().uuid(), book_id: z.string().uuid().nullable(), workspace_id: z.string().uuid().optional(),
  agent_type: z.string().optional(), action: z.string().nullable().optional(), status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  created_at: z.string().datetime({ offset: true }), completed_at: z.string().datetime({ offset: true }).nullable() });
function exactCount(result: { error: unknown; count: number | null }) {
  if (result.error || !countSchema.safeParse(result.count).success) throw unavailable();
  return result.count!;
}

export function dashboardRoutes(app: FastifyInstance) {
  app.get("/dashboard", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(422, "Choose a valid workspace.");

    const user = app.supabaseFactory(req.userToken);
    const role = await requireWorkspaceMember(user, parsed.data.workspaceId, req.userId);
    const [{ data: workspace, error: workspaceError }, { data: books, error: booksError, count: booksTotal }] = await Promise.all([
      user.from("workspaces").select("id,name,organization_id").eq("id", parsed.data.workspaceId).maybeSingle(),
      user.from("books").select("id,workspace_id,title,subtitle,author_name,language,genre,status,current_version_id,created_by,created_at,updated_at", { count: "exact" })
        .eq("workspace_id", parsed.data.workspaceId).order("updated_at", { ascending: false }),
    ]);
    if (workspaceError || !workspace) throw new AppError(404, "Workspace not found.");
    if (booksError || !Array.isArray(books) || booksTotal !== books.length || books.some(book => book.workspace_id !== workspace.id)) throw new AppError(503, "The complete dashboard library could not be verified. Reload before relying on job counts.");

    const bookRows = books;
    const bookIds = bookRows.map((book) => book.id);
    const titleById = new Map(bookRows.map(book => [book.id, book.title]));
    const empty = Promise.resolve({ data: [], error: null, count: 0 });
    const [assetCount, imageCount, queueResults, readyPackages, activity] = await Promise.all([
      user.from("assets").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id).is("deleted_at", null),
      user.from("assets").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id)
        .in("type", ["illustration", "front_cover"]).is("deleted_at", null),
      Promise.all(queues.map(async queue => {
        // AI includes workspace-only artwork. Other execution jobs require a visible book.
        const scope = (query: ReturnType<ReturnType<typeof user.from>["select"]>) => queue.kind === "ai" ? query.eq("workspace_id", workspace.id)
          : queue.kind === "audiobook_export" ? query.eq("workspace_id", workspace.id).in("book_id", bookIds) : query.in("book_id", bookIds);
        if (queue.kind !== "ai" && !bookIds.length) return { ...queue, rows: [], pending: 0, failed: 0 };
        const [recent, pending, failed] = await Promise.all([
          scope(user.from(queue.table).select(queue.columns)).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(12),
          scope(user.from(queue.table).select("id", { count: "exact", head: true })).in("status", activeJobStatuses),
          scope(user.from(queue.table).select("id", { count: "exact", head: true })).eq("status", "failed"),
        ]);
        const rows = z.array(jobSchema).max(12).safeParse(recent.data);
        if (recent.error || !rows.success || rows.data.some(job => job.book_id === null ? queue.kind !== "ai" : !titleById.has(job.book_id))
          || rows.data.some(job => job.workspace_id !== undefined && job.workspace_id !== workspace.id)) throw unavailable();
        return { ...queue, rows: rows.data, pending: exactCount(pending), failed: exactCount(failed) };
      })),
      bookIds.length ? user.from("publishing_jobs").select("id", { count: "exact", head: true }).in("book_id", bookIds)
        .eq("status", "succeeded").contains("request_json", { action: "export_package" }) : empty,
      user.from("activity_events").select("id,workspace_id,actor_id,event_type,entity_type,entity_id,created_at")
        .eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(10),
    ]);
    if (activity.error) throw unavailable();
    const assets = exactCount(assetCount), visualAssets = exactCount(imageCount), packages = exactCount(readyPackages);
    const pendingJobs = queueResults.reduce((sum, queue) => sum + queue.pending, 0), failedJobs = queueResults.reduce((sum, queue) => sum + queue.failed, 0);
    if (!countSchema.safeParse(pendingJobs).success || !countSchema.safeParse(failedJobs).success) throw unavailable();

    const service = app.supabaseFactory();
    const [entitlements, usageEntries, ledger, sales] = await Promise.all([
      currentEntitlements(service, workspace.organization_id),
      Promise.all(meters.map(async (meter) => [meter, await monthUsage(service, workspace.organization_id, meter)] as const)),
      service.from("credit_ledger").select("balance_after").eq("user_id", req.userId)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle(),
      loadRetailerSalesSummary(user, workspace.id),
    ]);
    if (ledger.error) throw new AppError(503, "Dashboard credit balance is temporarily unavailable.");

    const recentJobs = queueResults.flatMap(queue => queue.rows.map(job => ({
      id: job.id, kind: queue.kind, ...jobSummary(queue.kind, job), status: job.status,
      bookId: job.book_id, bookTitle: job.book_id ? titleById.get(job.book_id) ?? null : null,
      createdAt: job.created_at, completedAt: job.completed_at,
    }))).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.kind.localeCompare(b.kind) || b.id.localeCompare(a.id)).slice(0, 12);

    reply.header("cache-control", "private, no-store");
    return {
      viewerId: req.userId,
      workspace: { id: workspace.id, name: workspace.name, organizationId: workspace.organization_id, role },
      books: bookRows,
      summary: {
        activeBooks: bookRows.filter((book) => book.status !== "archived").length,
        inProductionBooks: bookRows.filter((book) => book.status === "draft" || book.status === "in_review").length,
        publishedBooks: bookRows.filter((book) => book.status === "published").length,
        assets, visualAssets, pendingJobs, failedJobs, readyPackages: packages,
      },
      usage: {
        entitlements, usage: Object.fromEntries(usageEntries),
        creditBalance: Number((ledger.data as { balance_after?: number } | null)?.balance_after ?? 0),
      },
      recentJobs,
      pipeline: queueResults.map(({ kind, label, pending, failed }) => ({ kind, label, pending, failed })),
      activity: (activity.data ?? []).map((event) => ({ ...event, payload_json: {} })),
      sales,
    };
  });
}
