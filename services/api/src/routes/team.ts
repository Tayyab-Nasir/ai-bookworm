import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceAdmin, requireWorkspaceMember } from "../lib/authorize.js";
import { logActivity } from "../lib/activity.js";

const ROLES = ["owner", "admin", "editor", "writer", "illustrator", "designer", "reviewer", "viewer"] as const;

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(ROLES).exclude(["owner"]).default("viewer"),
});

const roleSchema = z.object({
  role: z.enum(ROLES),
});

export function teamRoutes(app: FastifyInstance) {
  // Members + their profile display names (flat rows, client joins on user_id).
  app.get("/workspaces/:id/members", async (req) => {
    const { id } = req.params as { id: string };
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(sb, id, req.userId);
    const { data: members, error } = await sb.from("workspace_members").select("*").eq("workspace_id", id);
    if (error) throw new AppError(500, error.message);
    const ids = (members ?? []).map((m: { user_id: string }) => m.user_id);
    const { data: profiles } = ids.length
      ? await sb.from("profiles").select("id,display_name,avatar_url").in("id", ids)
      : { data: [] };
    return { members, profiles };
  });

  // Invite by email: creates the workspace_members row (status 'invited') via
  // the service client. Invitation row needs an auth.users id, so we look the
  // email up in profiles; unknown emails are accepted as a stub invite keyed
  // off the invited_by marker... ponytail: no invites table — unknown emails
  // 404 for now; add an invitations table + email send when SMTP lands.
  app.post("/workspaces/:id/invitations", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid invitation", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceAdmin(sb, id, req.userId);

    // Email delivery is a TODO stub — wire to the transactional email provider
    // (ponytail: SMTP/SendGrid not configured yet; the invite row is the
    // source of truth and the accept flow flips status to 'active').
    const svc = app.supabaseFactory();
    // ponytail: listUsers scans auth.users — fine at workspace scale; switch to
    // a getUserByEmail RPC when the auth store is large.
    const { data: users } = await svc.auth.admin.listUsers();
    const invitee = users?.users?.find((u: { email?: string }) => u.email?.toLowerCase() === parsed.data.email.toLowerCase()) ?? null;
    if (!invitee) throw new AppError(404, "no user with that email"); // stub until invites table

    const { data: existing } = await svc.from("workspace_members").select("user_id,status").eq("workspace_id", id).eq("user_id", invitee.id).maybeSingle();
    if (existing) throw new AppError(409, "user is already a member");

    const { data, error } = await svc
      .from("workspace_members")
      .insert({ workspace_id: id, user_id: invitee.id, role: parsed.data.role, status: "invited", invited_by: req.userId })
      .select()
      .single();
    if (error) throw new AppError(422, error.message);
    await logActivity(svc, { workspaceId: id, actorId: req.userId, eventType: "member_invited", entityType: "workspace_member", entityId: invitee.id, payload: { email: parsed.data.email, role: parsed.data.role } });
    return reply.status(201).send(data);
  });

  // Role change: owner/admin only. The last owner cannot be demoted.
  app.patch("/workspaces/:id/members/:userId", async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid role", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceAdmin(sb, id, req.userId);

    const svc = app.supabaseFactory();
    const { data: target } = await svc
      .from("workspace_members")
      .select("role,status")
      .eq("workspace_id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!target) throw new AppError(404, "member not found");

    if (target.role === "owner" && parsed.data.role !== "owner") {
      const { data: owners } = await svc.from("workspace_members").select("user_id").eq("workspace_id", id).eq("role", "owner").eq("status", "active");
      if ((owners ?? []).length <= 1) throw new AppError(409, "cannot demote the last owner");
    }

    const { data, error } = await svc
      .from("workspace_members")
      .update({ role: parsed.data.role })
      .eq("workspace_id", id)
      .eq("user_id", userId)
      .select()
      .single();
    if (error) throw new AppError(422, error.message);
    await logActivity(svc, { workspaceId: id, actorId: req.userId, eventType: "member_role_changed", entityType: "workspace_member", entityId: userId, payload: { from: target.role, to: parsed.data.role } });
    return data;
  });
}
