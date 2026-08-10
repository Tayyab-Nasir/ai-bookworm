import type { SupabaseClient } from "./supabase.js";
import { AppError } from "../errors.js";

const EDIT_ROLES = new Set(["owner", "admin", "editor", "writer", "illustrator", "designer"]);

async function roleIn(supabase: SupabaseClient, workspaceId: string, userId: string) {
  const { data } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return data?.role as string | undefined;
}

export async function requireWorkspaceMember(supabase: SupabaseClient, workspaceId: string, userId: string) {
  const role = await roleIn(supabase, workspaceId, userId);
  if (!role) throw new AppError(403, "not a workspace member");
  return role;
}

export async function requireWorkspaceEditor(supabase: SupabaseClient, workspaceId: string, userId: string) {
  const role = await requireWorkspaceMember(supabase, workspaceId, userId);
  if (!EDIT_ROLES.has(role)) throw new AppError(403, "role cannot edit");
  return role;
}

export async function requireWorkspaceAdmin(supabase: SupabaseClient, workspaceId: string, userId: string) {
  const role = await requireWorkspaceMember(supabase, workspaceId, userId);
  if (role !== "owner" && role !== "admin") throw new AppError(403, "role cannot manage members");
  return role;
}

// Reviewers may comment and approve/reject; writers et al. are already editors.
const APPROVE_ROLES = new Set([...EDIT_ROLES, "reviewer"]);

export async function requireWorkspaceApprover(supabase: SupabaseClient, workspaceId: string, userId: string) {
  const role = await requireWorkspaceMember(supabase, workspaceId, userId);
  if (!APPROVE_ROLES.has(role)) throw new AppError(403, "role cannot approve");
  return role;
}
