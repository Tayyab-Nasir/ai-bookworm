import type { SupabaseClient } from "./supabase.js";

// Best-effort audit trail (PRD 13: upload/move/rename/replace/approve/delete...).
// Never throws: audit failure must not roll back the mutation it records.
export async function logActivity(
  sb: SupabaseClient,
  e: { workspaceId: string; actorId: string; eventType: string; entityType?: string; entityId?: string; payload?: Record<string, unknown> },
) {
  await sb.from("activity_events").insert({
    workspace_id: e.workspaceId,
    actor_id: e.actorId,
    event_type: e.eventType,
    entity_type: e.entityType ?? null,
    entity_id: e.entityId ?? null,
    payload_json: e.payload ?? {},
  });
}
