import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../errors.js";
import { requireWorkspaceAdmin, requireWorkspaceMember } from "../lib/authorize.js";
import { logActivity } from "../lib/activity.js";

const ROLES = ["owner", "admin", "editor", "writer", "illustrator", "designer", "reviewer", "viewer"] as const;

const inviteSchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(ROLES).exclude(["owner"]).default("viewer"),
}).strict();

const roleSchema = z.object({
  role: z.enum(ROLES),
}).strict();

const acceptInvitationSchema = z.object({ token: z.string().min(32).max(256) }).strict();
const INVITATION_FIELDS = "id,workspace_id,email,role,status,expires_at,invited_by,accepted_by,accepted_at,revoked_by,revoked_at,created_at,updated_at";

function hashInvitationToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function publicInvitation(row: Record<string, unknown>) {
  const { token_hash: _secret, ...safe } = row;
  return safe;
}

function acceptanceUrl(token: string) {
  const configured = process.env.APP_URL ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
  if (!configured) throw new AppError(503, "APP_URL is required for invitation links");
  let url: URL;
  try { url = new URL("/team/accept", configured); }
  catch { throw new AppError(503, "APP_URL is invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new AppError(503, "APP_URL is invalid");
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

function invitationError(error: { code?: string; message?: string }) {
  if (error.code === "P0002") return new AppError(404, "invitation not found");
  if (error.code === "23505") return new AppError(409, "invitation or membership is no longer pending");
  if (error.code === "22023") return new AppError(422, "invitation is invalid or expired");
  if (error.code === "42501") return new AppError(403, "invitation does not belong to the signed-in account");
  return new AppError(500, "invitation could not be processed");
}

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

  app.get("/workspaces/:id/invitations", async (req) => {
    const { id } = req.params as { id: string };
    await requireWorkspaceAdmin(app.supabaseFactory(req.userToken), id, req.userId);
    const { data, error } = await app.supabaseFactory().from("workspace_invitations")
      .select(INVITATION_FIELDS).eq("workspace_id", id).order("created_at", { ascending: false });
    if (error) throw new AppError(500, "invitations could not be loaded");
    return { invitations: (data ?? []).map((row) => publicInvitation(row)) };
  });

  // Creates or rotates a pending invitation. Only the token hash is stored;
  // the raw token is returned once in a URL fragment so it is not sent in HTTP
  // requests or server logs. Email delivery can later send this same URL.
  app.post("/workspaces/:id/invitations", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid invitation", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceAdmin(sb, id, req.userId);

    const svc = app.supabaseFactory();
    const email = parsed.data.email.trim().toLowerCase();
    const token = randomBytes(32).toString("base64url");
    const url = acceptanceUrl(token);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await svc.from("workspace_invitations").select("id")
      .eq("workspace_id", id).eq("email", email).eq("status", "pending").maybeSingle();
    const values = { email, role: parsed.data.role, token_hash: hashInvitationToken(token), expires_at: expiresAt, invited_by: req.userId, updated_at: new Date().toISOString() };
    const query = existing
      ? svc.from("workspace_invitations").update(values).eq("id", existing.id)
      : svc.from("workspace_invitations").insert({ workspace_id: id, ...values });
    const { data, error } = await query.select(INVITATION_FIELDS).single();
    if (error || !data) throw new AppError(500, "invitation could not be saved");
    await logActivity(svc, { workspaceId: id, actorId: req.userId, eventType: existing ? "invitation_rotated" : "member_invited", entityType: "workspace_invitation", entityId: data.id, payload: { role: parsed.data.role } });
    return reply.status(existing ? 200 : 201).send({ invitation: publicInvitation(data), acceptanceUrl: url });
  });

  app.delete("/workspaces/:id/invitations/:invitationId", async (req) => {
    const { id, invitationId } = req.params as { id: string; invitationId: string };
    await requireWorkspaceAdmin(app.supabaseFactory(req.userToken), id, req.userId);
    const svc = app.supabaseFactory();
    const { data, error } = await svc.from("workspace_invitations")
      .update({ status: "revoked", revoked_by: req.userId, revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", invitationId).eq("workspace_id", id).eq("status", "pending").select("id").maybeSingle();
    if (error) throw new AppError(500, "invitation could not be revoked");
    if (!data) throw new AppError(404, "pending invitation not found");
    await logActivity(svc, { workspaceId: id, actorId: req.userId, eventType: "invitation_revoked", entityType: "workspace_invitation", entityId: invitationId });
    return { invitationId, revoked: true };
  });

  app.post("/workspaces/invitations/accept", async (req) => {
    const parsed = acceptInvitationSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid invitation token");
    const { data, error } = await app.supabaseFactory(req.userToken).rpc("accept_workspace_invitation", {
      p_token_hash: hashInvitationToken(parsed.data.token),
    });
    if (error) throw invitationError(error);
    if (!data) throw new AppError(500, "invitation acceptance returned no result");
    return data;
  });

  // Role change: owner/admin only. The last owner cannot be demoted.
  app.patch("/workspaces/:id/members/:userId", async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid role", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceAdmin(sb, id, req.userId);

    const { data, error } = await sb.rpc("change_workspace_member_role", {
      p_workspace_id: id, p_user_id: userId, p_role: parsed.data.role,
    }).single();
    if (error?.code === "P0002") throw new AppError(404, "member not found");
    if (error?.code === "42501") throw new AppError(403, "only an owner can grant or change owner access");
    if (error?.code === "23505") throw new AppError(409, "cannot demote the last active owner");
    if (error || !data) throw new AppError(422, "member role could not be changed");
    return data;
  });
}
