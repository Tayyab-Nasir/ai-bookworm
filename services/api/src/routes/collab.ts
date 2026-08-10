import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceApprover, requireWorkspaceEditor, requireWorkspaceMember } from "../lib/authorize.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { logActivity } from "../lib/activity.js";

const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

const createCommentSchema = z.object({
  workspaceId: z.string().uuid(),
  entityType: z.string().min(1),
  entityId: z.string().uuid(),
  body: z.string().min(1).max(10000),
});

const createTaskSchema = z.object({
  workspaceId: z.string().uuid(),
  title: z.string().min(1).max(256),
  description: z.string().max(10000).optional(),
  entityType: z.string().min(1).optional(),
  entityId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().nullish(),
  priority: z.enum(PRIORITIES).optional(),
  dueAt: z.string().datetime().nullish(),
});

const patchTaskSchema = z
  .object({
    title: z.string().min(1).max(256).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueAt: z.string().datetime().nullable().optional(),
    assigneeId: z.string().uuid().nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "nothing to update" });

const createApprovalSchema = z.object({
  workspaceId: z.string().uuid(),
  entityType: z.string().min(1),
  entityId: z.string().uuid(),
  reviewerId: z.string().uuid().nullish(),
  comment: z.string().max(2000).optional(),
});

// @name / @Display Name mentions. Server-side authority: names are resolved
// against active workspace members' profiles, client rendering is cosmetic.
export function parseMentionNames(body: string): string[] {
  const re = /@([A-Za-z0-9_]+(?: [A-Za-z0-9_]+)*)/g;
  let m: RegExpExecArray | null;
  const candidates = new Set<string>();
  while ((m = re.exec(body))) {
    const words = m[1].split(" ");
    // Greedy regex over-captures ("@Alice and Bob" -> "alice and bob"); emit
    // every word prefix so exact profile matches win downstream.
    for (let i = 1; i <= words.length; i++) candidates.add(words.slice(0, i).join(" ").toLowerCase());
  }
  return [...candidates];
}

// Longest matching display name per overlapping candidate set.
async function resolveMentions(sb: SupabaseClient, workspaceId: string, commentId: string, candidates: string[]) {
  if (candidates.length === 0) return [];
  const { data: members } = await sb.from("workspace_members").select("user_id").eq("workspace_id", workspaceId).eq("status", "active");
  const ids = (members ?? []).map((m: { user_id: string }) => m.user_id);
  if (ids.length === 0) return [];
  const { data: profiles } = await sb.from("profiles").select("id,display_name").in("id", ids);
  const hits = (profiles ?? []).filter((p: { id: string; display_name: string }) => candidates.includes((p.display_name ?? "").toLowerCase()));
  for (const p of hits) {
    await sb.from("comment_mentions").insert({ comment_id: commentId, user_id: p.id });
    await logActivity(sb, { workspaceId, actorId: p.id, eventType: "mention", entityType: "comment", entityId: commentId });
  }
  return hits.map((p: { id: string }) => p.id);
}

export function collabRoutes(app: FastifyInstance) {
  // ---- Comments -----------------------------------------------------------
  app.get("/comments", async (req) => {
    const q = req.query as { workspaceId?: string; entityType?: string; entityId?: string };
    if (!q.workspaceId || !q.entityType || !q.entityId) throw new AppError(422, "workspaceId, entityType and entityId are required");
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(sb, q.workspaceId, req.userId);
    const { data, error } = await sb
      .from("comments")
      .select("*")
      .eq("workspace_id", q.workspaceId)
      .eq("entity_type", q.entityType)
      .eq("entity_id", q.entityId)
      .order("created_at", { ascending: true });
    if (error) throw new AppError(500, error.message);
    return { comments: data };
  });

  app.post("/comments", async (req, reply) => {
    const parsed = createCommentSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid comment", { issues: parsed.error.issues });
    const { workspaceId, entityType, entityId, body } = parsed.data;
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(sb, workspaceId, req.userId); // reviewer+viewer may comment

    const { data: comment, error } = await sb
      .from("comments")
      .insert({ workspace_id: workspaceId, entity_type: entityType, entity_id: entityId, author_id: req.userId, body })
      .select()
      .single();
    if (error) throw new AppError(422, error.message);

    // Mentions + audit go through the service client: RLS only grants members
    // SELECT on comment_mentions/activity_events.
    const svc = app.supabaseFactory();
    const mentioned = await resolveMentions(svc, workspaceId, comment.id, parseMentionNames(body));
    await logActivity(svc, { workspaceId, actorId: req.userId, eventType: "comment_created", entityType: "comment", entityId: comment.id });
    return reply.status(201).send({ ...comment, mentioned });
  });

  app.post("/comments/:id/resolve", async (req) => {
    const { id } = req.params as { id: string };
    const sb = app.supabaseFactory(req.userToken);
    const { data: comment } = await sb.from("comments").select("id,workspace_id,resolved_at").eq("id", id).maybeSingle();
    if (!comment) throw new AppError(404, "comment not found");
    await requireWorkspaceMember(sb, comment.workspace_id, req.userId);
    const resolvedAt = comment.resolved_at ? null : new Date().toISOString(); // toggle
    const { data, error } = await sb.from("comments").update({ resolved_at: resolvedAt }).eq("id", id).select().single();
    if (error) throw new AppError(422, error.message);
    await logActivity(app.supabaseFactory(), {
      workspaceId: comment.workspace_id,
      actorId: req.userId,
      eventType: resolvedAt ? "comment_resolved" : "comment_reopened",
      entityType: "comment",
      entityId: id,
    });
    return data;
  });

  // ---- Tasks --------------------------------------------------------------
  app.get("/tasks", async (req) => {
    const q = req.query as { workspaceId?: string; status?: string; assigneeId?: string };
    if (!q.workspaceId) throw new AppError(422, "workspaceId is required");
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(sb, q.workspaceId, req.userId);
    let query = sb.from("tasks").select("*").eq("workspace_id", q.workspaceId).order("created_at", { ascending: false });
    if (q.status) query = query.eq("status", q.status);
    if (q.assigneeId) query = query.eq("assignee_id", q.assigneeId);
    const { data, error } = await query;
    if (error) throw new AppError(500, error.message);
    return { tasks: data };
  });

  app.post("/tasks", async (req, reply) => {
    const parsed = createTaskSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid task", { issues: parsed.error.issues });
    const { workspaceId, title, description, entityType, entityId, assigneeId, priority, dueAt } = parsed.data;
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(sb, workspaceId, req.userId);
    const { data, error } = await sb
      .from("tasks")
      .insert({
        workspace_id: workspaceId,
        title,
        description: description ?? null,
        entity_type: entityType ?? null,
        entity_id: entityId ?? null,
        assignee_id: assigneeId ?? null,
        priority: priority ?? "medium",
        due_at: dueAt ?? null,
        created_by: req.userId,
      })
      .select()
      .single();
    if (error) throw new AppError(422, error.message);
    await logActivity(app.supabaseFactory(), { workspaceId, actorId: req.userId, eventType: "task_created", entityType: "task", entityId: data.id, payload: { title } });
    return reply.status(201).send(data);
  });

  // Status/priority/due/assignee/title updates. Status is a free enum move
  // (todo..cancelled both ways) — ponytail: no transition graph, Kanban drag
  // needs arbitrary column moves; add one if workflow rules ever matter.
  app.patch("/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = patchTaskSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid task update", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const { data: task } = await sb.from("tasks").select("id,workspace_id,status").eq("id", id).maybeSingle();
    if (!task) throw new AppError(404, "task not found");
    await requireWorkspaceEditor(sb, task.workspace_id, req.userId);

    const update: Record<string, unknown> = {};
    if (parsed.data.title !== undefined) update.title = parsed.data.title;
    if (parsed.data.status !== undefined) update.status = parsed.data.status;
    if (parsed.data.priority !== undefined) update.priority = parsed.data.priority;
    if (parsed.data.dueAt !== undefined) update.due_at = parsed.data.dueAt;
    if (parsed.data.assigneeId !== undefined) update.assignee_id = parsed.data.assigneeId;
    const { data, error } = await sb.from("tasks").update(update).eq("id", id).select().single();
    if (error) throw new AppError(422, error.message);
    await logActivity(app.supabaseFactory(), { workspaceId: task.workspace_id, actorId: req.userId, eventType: "task_updated", entityType: "task", entityId: id, payload: update });
    return data;
  });

  // ---- Approvals ----------------------------------------------------------
  app.get("/approvals", async (req) => {
    const q = req.query as { workspaceId?: string; status?: string };
    if (!q.workspaceId) throw new AppError(422, "workspaceId is required");
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(sb, q.workspaceId, req.userId);
    let query = sb.from("approvals").select("*").eq("workspace_id", q.workspaceId).order("created_at", { ascending: false });
    if (q.status) query = query.eq("status", q.status);
    const { data, error } = await query;
    if (error) throw new AppError(500, error.message);
    return { approvals: data };
  });

  app.post("/approvals", async (req, reply) => {
    const parsed = createApprovalSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid approval request", { issues: parsed.error.issues });
    const { workspaceId, entityType, entityId, reviewerId, comment } = parsed.data;
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(sb, workspaceId, req.userId);
    const { data, error } = await sb
      .from("approvals")
      .insert({ workspace_id: workspaceId, entity_type: entityType, entity_id: entityId, requested_by: req.userId, reviewer_id: reviewerId ?? null, comment: comment ?? null })
      .select()
      .single();
    if (error) throw new AppError(422, error.message);
    await logActivity(app.supabaseFactory(), { workspaceId, actorId: req.userId, eventType: "approval_requested", entityType: "approval", entityId: data.id });
    return reply.status(201).send(data);
  });

  // pending -> approved|rejected only; 409 on any second resolution.
  for (const action of ["approve", "reject"] as const) {
    app.post(`/approvals/:id/${action}`, async (req) => {
      const { id } = req.params as { id: string };
      const sb = app.supabaseFactory(req.userToken);
      const { data: approval } = await sb.from("approvals").select("id,workspace_id,status,reviewer_id").eq("id", id).maybeSingle();
      if (!approval) throw new AppError(404, "approval not found");
      await requireWorkspaceApprover(sb, approval.workspace_id, req.userId);
      if (approval.status !== "pending") throw new AppError(409, `approval already ${approval.status}`);
      if (approval.reviewer_id && approval.reviewer_id !== req.userId) throw new AppError(403, "assigned to another reviewer");

      const status = action === "approve" ? "approved" : "rejected";
      // Conditional update guards the race: two concurrent resolves both read
      // 'pending', only one write matches the status filter.
      const { data, error } = await sb.from("approvals").update({ status }).eq("id", id).eq("status", "pending").select().single();
      if (error || !data) throw new AppError(409, "approval already resolved");
      await logActivity(app.supabaseFactory(), {
        workspaceId: approval.workspace_id,
        actorId: req.userId,
        eventType: `approval_${status}`,
        entityType: "approval",
        entityId: id,
      });
      return data;
    });
  }

  // ---- Activity timeline --------------------------------------------------
  app.get("/activity", async (req) => {
    const q = req.query as { workspaceId?: string; limit?: string };
    if (!q.workspaceId) throw new AppError(422, "workspaceId is required");
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(sb, q.workspaceId, req.userId);
    const { data, error } = await sb
      .from("activity_events")
      .select("*")
      .eq("workspace_id", q.workspaceId)
      .order("created_at", { ascending: false })
      .limit(Math.min(Number(q.limit ?? 50) || 50, 200));
    if (error) throw new AppError(500, error.message);
    return { events: data };
  });
}
