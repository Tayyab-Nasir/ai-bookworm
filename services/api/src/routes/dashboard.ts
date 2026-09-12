import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceMember } from "../lib/authorize.js";
import { currentEntitlements, monthUsage } from "../lib/entitlements.js";

const querySchema = z.object({ workspaceId: z.string().uuid() }).strict();
const activeJobStatuses = ["queued", "running"];
const meters = [
  "ai_credits", "image_credits", "audio_credits", "translation_credits",
  "storage_gb", "seats", "rendering", "publishing",
] as const;

const agentLabels: Record<string, string> = {
  writer: "AI writing", proofreader: "Proofreading", copyeditor: "Copy editing",
  consistency: "Consistency review", illustrator: "Illustration", cover_designer: "Book cover",
  narrator: "Audiobook narration", translator: "Translation",
};

function publishingLabel(row: Record<string, unknown>) {
  const action = (row.request_json as { action?: string } | null)?.action;
  const channel = String(row.channel ?? "export");
  if (action === "export_package") return `${channel} export package`;
  if (action === "preflight") return `${channel} preflight`;
  return "Edition render";
}

export function dashboardRoutes(app: FastifyInstance) {
  app.get("/dashboard", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(422, "Choose a valid workspace.");

    const user = app.supabaseFactory(req.userToken);
    const role = await requireWorkspaceMember(user, parsed.data.workspaceId, req.userId);
    const [{ data: workspace, error: workspaceError }, { data: books, error: booksError }] = await Promise.all([
      user.from("workspaces").select("id,name,organization_id").eq("id", parsed.data.workspaceId).maybeSingle(),
      user.from("books").select("id,workspace_id,title,subtitle,author_name,language,genre,status,current_version_id,created_by,created_at,updated_at")
        .eq("workspace_id", parsed.data.workspaceId).order("updated_at", { ascending: false }),
    ]);
    if (workspaceError || !workspace) throw new AppError(404, "Workspace not found.");
    if (booksError) throw new AppError(503, "Dashboard books are temporarily unavailable.");

    const bookRows = books ?? [];
    const bookIds = bookRows.map((book) => book.id);
    const empty = Promise.resolve({ data: [], error: null, count: 0 });
    const [assetCount, imageCount, aiJobs, publishingJobs, pendingAi, failedAi, pendingPublishing, failedPublishing, readyPackages, activity] = await Promise.all([
      user.from("assets").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id).is("deleted_at", null),
      user.from("assets").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id)
        .in("type", ["illustration", "front_cover"]).is("deleted_at", null),
      user.from("ai_jobs").select("id,book_id,agent_type,status,created_at,completed_at")
        .eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(12),
      bookIds.length ? user.from("publishing_jobs").select("id,book_id,channel,status,request_json,created_at,completed_at")
        .in("book_id", bookIds).order("created_at", { ascending: false }).limit(12) : empty,
      user.from("ai_jobs").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id).in("status", activeJobStatuses),
      user.from("ai_jobs").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id).eq("status", "failed"),
      bookIds.length ? user.from("publishing_jobs").select("id", { count: "exact", head: true }).in("book_id", bookIds).in("status", activeJobStatuses) : empty,
      bookIds.length ? user.from("publishing_jobs").select("id", { count: "exact", head: true }).in("book_id", bookIds).eq("status", "failed") : empty,
      bookIds.length ? user.from("publishing_jobs").select("id", { count: "exact", head: true }).in("book_id", bookIds)
        .eq("status", "succeeded").contains("request_json", { action: "export_package" }) : empty,
      user.from("activity_events").select("id,workspace_id,actor_id,event_type,entity_type,entity_id,created_at")
        .eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(10),
    ]);
    const aggregateResults = [assetCount, imageCount, aiJobs, publishingJobs, pendingAi, failedAi, pendingPublishing, failedPublishing, readyPackages, activity];
    if (aggregateResults.some((result) => result.error)) throw new AppError(503, "Dashboard activity is temporarily unavailable.");

    const service = app.supabaseFactory();
    const [entitlements, usageEntries, ledger] = await Promise.all([
      currentEntitlements(service, workspace.organization_id),
      Promise.all(meters.map(async (meter) => [meter, await monthUsage(service, workspace.organization_id, meter)] as const)),
      service.from("credit_ledger").select("balance_after").eq("user_id", req.userId)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (ledger.error) throw new AppError(503, "Dashboard credit balance is temporarily unavailable.");

    const titleById = new Map(bookRows.map((book) => [book.id, book.title]));
    const recentJobs = [
      ...(aiJobs.data ?? []).map((job) => ({
        id: job.id, kind: "ai" as const, label: agentLabels[job.agent_type] ?? "AI task", status: job.status,
        bookId: job.book_id ?? null, bookTitle: job.book_id ? titleById.get(job.book_id) ?? null : null,
        createdAt: job.created_at, completedAt: job.completed_at ?? null,
      })),
      ...(publishingJobs.data ?? []).map((job) => ({
        id: job.id, kind: "publishing" as const, label: publishingLabel(job), status: job.status,
        bookId: job.book_id, bookTitle: titleById.get(job.book_id) ?? null,
        createdAt: job.created_at, completedAt: job.completed_at ?? null,
      })),
    ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 12);

    reply.header("cache-control", "private, no-store");
    return {
      workspace: { id: workspace.id, name: workspace.name, organizationId: workspace.organization_id, role },
      books: bookRows,
      summary: {
        activeBooks: bookRows.filter((book) => book.status !== "archived").length,
        inProductionBooks: bookRows.filter((book) => book.status === "draft" || book.status === "in_review").length,
        publishedBooks: bookRows.filter((book) => book.status === "published").length,
        assets: assetCount.count ?? 0,
        visualAssets: imageCount.count ?? 0,
        pendingJobs: (pendingAi.count ?? 0) + (pendingPublishing.count ?? 0),
        failedJobs: (failedAi.count ?? 0) + (failedPublishing.count ?? 0),
        readyPackages: readyPackages.count ?? 0,
      },
      usage: {
        entitlements, usage: Object.fromEntries(usageEntries),
        creditBalance: Number((ledger.data as { balance_after?: number } | null)?.balance_after ?? 0),
      },
      recentJobs,
      activity: (activity.data ?? []).map((event) => ({ ...event, payload_json: {} })),
      sales: {
        status: "not_connected" as const, units: null, grossRevenueCents: null, currency: null,
        message: "No retailer sales source is connected. Package creation is not a sale, and AI Bookworm does not invent revenue.",
      },
    };
  });
}
