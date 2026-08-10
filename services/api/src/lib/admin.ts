import type { FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "./supabase.js";

// ponytail: admin = user id in ADMIN_USER_IDS env (comma-separated). Ceiling:
// env-only, no role table. Upgrade path: profiles.is_admin / admin RBAC.
export function isAdmin(userId: string): boolean {
  const admins = (process.env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return admins.includes(userId);
}

export function requireAdmin(req: FastifyRequest): void {
  if (!isAdmin(req.userId)) throw new AppError(403, "admin required");
}

// Admin audit trail into audit_logs (PRD 8 Security/Ops). Best-effort:
// never throws, must not roll back the admin action it records.
// after_json must never contain manuscript text, tokens, secrets or signed
// URLs (MASTER-BUILD-SPEC 17) — callers pass ids/status only.
export async function logAdminAudit(
  sb: SupabaseClient,
  e: { actorId: string; action: string; entityType: string; entityId: string; after?: Record<string, unknown> },
): Promise<void> {
  try {
    await sb.from("audit_logs").insert({
      actor_id: e.actorId,
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId,
      after_json: e.after ?? {},
    });
  } catch {
    /* best-effort */
  }
}
