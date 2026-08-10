import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceEditor, requireWorkspaceMember } from "../lib/authorize.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { logActivity } from "../lib/activity.js";

const BUCKET = "book-assets";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB, matches parser cap

const uploadUrlSchema = z.object({
  workspaceId: z.string().uuid(),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  folderId: z.string().uuid().nullish(),
  type: z.string().min(1).optional(),
});

const confirmSchema = z.object({
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});

const newVersionSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});

const confirmVersionSchema = z.object({
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i),
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    folderId: z.string().uuid().nullable().optional(),
    status: z.enum(["draft", "in_review", "approved", "rejected", "archived"]).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "nothing to update" });

// Storage path per spec section 6: workspaces/{workspace_id}/assets/{asset_id}/v{version}/{safe_filename}
function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_");
  return safe.slice(0, 128) || "file";
}

interface AssetRow {
  id: string;
  workspace_id: string;
  deleted_at: string | null;
}

async function loadAsset(sb: SupabaseClient, assetId: string): Promise<AssetRow> {
  const { data } = await sb.from("assets").select("id,workspace_id,deleted_at").eq("id", assetId).maybeSingle();
  if (!data) throw new AppError(404, "asset not found");
  return data as AssetRow;
}

export function assetRoutes(app: FastifyInstance) {
  app.post("/assets/upload-url", async (req) => {
    const parsed = uploadUrlSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid upload request", { issues: parsed.error.issues });
    const { workspaceId, filename, mimeType, sizeBytes, folderId, type } = parsed.data;
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(sb, workspaceId, req.userId);

    const { data: asset, error } = await sb
      .from("assets")
      .insert({
        workspace_id: workspaceId,
        folder_id: folderId ?? null,
        type: type ?? "source_document",
        name: filename,
        storage_path: "pending", // not-null placeholder, replaced below once id is known
        mime_type: mimeType,
        size_bytes: sizeBytes,
        checksum: "pending", // set by /confirm
        status: "draft",
        created_by: req.userId,
      })
      .select("id")
      .single();
    if (error || !asset) throw new AppError(500, error?.message ?? "asset insert failed");

    const path = `workspaces/${workspaceId}/assets/${asset.id}/v1/${safeFilename(filename)}`;
    const { error: updErr } = await sb.from("assets").update({ storage_path: path }).eq("id", asset.id);
    if (updErr) throw new AppError(500, updErr.message);
    await sb.from("asset_versions").insert({
      asset_id: asset.id,
      version_number: 1,
      storage_path: path,
      checksum: "pending",
      created_by: req.userId,
    });
    await logActivity(sb, { workspaceId, actorId: req.userId, eventType: "asset_created", entityType: "asset", entityId: asset.id, payload: { name: filename } });

    const { data: signed, error: signErr } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (signErr || !signed) throw new AppError(500, signErr?.message ?? "signed url failed");

    return { assetId: asset.id, uploadUrl: signed.signedUrl, path };
  });

  app.post("/assets/:assetId/confirm", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid confirm request", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);

    const { data: asset } = await sb.from("assets").select("workspace_id,size_bytes,checksum").eq("id", assetId).maybeSingle();
    if (!asset) throw new AppError(404, "asset not found");
    await requireWorkspaceEditor(sb, asset.workspace_id, req.userId);
    if (asset.checksum !== "pending") throw new AppError(409, "asset already confirmed");
    if (asset.size_bytes !== parsed.data.sizeBytes) {
      throw new AppError(422, "size mismatch with declared upload", { declared: asset.size_bytes });
    }

    const { error } = await sb
      .from("assets")
      .update({ checksum: parsed.data.checksumSha256.toLowerCase(), size_bytes: parsed.data.sizeBytes })
      .eq("id", assetId)
      .eq("checksum", "pending");
    if (error) throw new AppError(500, error.message);
    await sb.from("asset_versions").update({ checksum: parsed.data.checksumSha256.toLowerCase() }).eq("asset_id", assetId).eq("version_number", 1);
    return { assetId, status: "draft", confirmed: true };
  });

  // List live assets; filter by workspaceId (required), folderId/type/status.
  app.get("/assets", async (req) => {
    const q = req.query as { workspaceId?: string; folderId?: string; type?: string; status?: string };
    if (!q.workspaceId) throw new AppError(422, "workspaceId is required");
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(sb, q.workspaceId, req.userId);
    let query = sb.from("assets").select("*").eq("workspace_id", q.workspaceId).is("deleted_at", null);
    if (q.folderId) query = query.eq("folder_id", q.folderId);
    if (q.type) query = query.eq("type", q.type);
    if (q.status) query = query.eq("status", q.status);
    const { data, error } = await query;
    if (error) throw new AppError(500, error.message);
    return { assets: data };
  });

  // New immutable version: returns a signed upload URL for v{n+1}; the row
  // keeps checksum "pending" until /confirm-version. Versions are never
  // updated after confirm (PRD 13: immutable versions w/ checksum).
  app.post("/assets/:assetId/versions", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const parsed = newVersionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid version request", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceEditor(sb, asset.workspace_id, req.userId);
    if (asset.deleted_at) throw new AppError(409, "asset is deleted");

    const { data: latest } = await sb
      .from("asset_versions")
      .select("version_number")
      .eq("asset_id", assetId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const next = (latest?.version_number ?? 0) + 1;
    const path = `workspaces/${asset.workspace_id}/assets/${assetId}/v${next}/${safeFilename(parsed.data.filename)}`;

    const { error } = await sb.from("asset_versions").insert({
      asset_id: assetId,
      version_number: next,
      storage_path: path,
      checksum: "pending",
      created_by: req.userId,
    });
    if (error) throw new AppError(422, error.message);
    const { data: signed, error: signErr } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (signErr || !signed) throw new AppError(500, signErr?.message ?? "signed url failed");
    return { assetId, version: next, uploadUrl: signed.signedUrl, path };
  });

  // Confirm a pending version: sets its checksum and points the asset row at
  // it. Conditional update on checksum='pending' prevents double-confirm.
  app.post("/assets/:assetId/versions/:version/confirm", async (req) => {
    const { assetId, version } = req.params as { assetId: string; version: string };
    const parsed = confirmVersionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid confirm request", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceEditor(sb, asset.workspace_id, req.userId);

    const { data: v } = await sb
      .from("asset_versions")
      .select("version_number,storage_path,checksum")
      .eq("asset_id", assetId)
      .eq("version_number", Number(version))
      .maybeSingle();
    if (!v) throw new AppError(404, "version not found");
    if (v.checksum !== "pending") throw new AppError(409, "version already confirmed");

    const checksum = parsed.data.checksumSha256.toLowerCase();
    const { error } = await sb.from("asset_versions").update({ checksum }).eq("asset_id", assetId).eq("version_number", v.version_number).eq("checksum", "pending");
    if (error) throw new AppError(500, error.message);
    await sb.from("assets").update({ storage_path: v.storage_path, checksum }).eq("id", assetId);
    await logActivity(sb, { workspaceId: asset.workspace_id, actorId: req.userId, eventType: "asset_replaced", entityType: "asset", entityId: assetId, payload: { version: v.version_number } });
    return { assetId, version: v.version_number, confirmed: true };
  });

  app.get("/assets/:assetId/versions", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const sb = app.supabaseFactory(req.userToken);
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceMember(sb, asset.workspace_id, req.userId);
    const { data, error } = await sb.from("asset_versions").select("*").eq("asset_id", assetId).order("version_number", { ascending: false });
    if (error) throw new AppError(500, error.message);
    return { versions: data };
  });

  // Rename/move/status change on the asset row.
  app.patch("/assets/:assetId", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid asset update", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceEditor(sb, asset.workspace_id, req.userId);
    if (asset.deleted_at) throw new AppError(409, "asset is deleted");

    const update: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name;
    if (parsed.data.folderId !== undefined) update.folder_id = parsed.data.folderId;
    if (parsed.data.status !== undefined) update.status = parsed.data.status;
    const { data, error } = await sb.from("assets").update(update).eq("id", assetId).select().single();
    if (error) throw new AppError(422, error.message);
    await logActivity(sb, {
      workspaceId: asset.workspace_id,
      actorId: req.userId,
      eventType: parsed.data.status ? "asset_status_changed" : parsed.data.folderId !== undefined ? "asset_moved" : "asset_renamed",
      entityType: "asset",
      entityId: assetId,
      payload: update,
    });
    return data;
  });

  // Soft delete: status archived + deleted_at marker; row stays for audit.
  app.delete("/assets/:assetId", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const sb = app.supabaseFactory(req.userToken);
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceEditor(sb, asset.workspace_id, req.userId);
    if (asset.deleted_at) throw new AppError(409, "asset already deleted");
    const { error } = await sb.from("assets").update({ deleted_at: new Date().toISOString(), status: "archived" }).eq("id", assetId);
    if (error) throw new AppError(500, error.message);
    await logActivity(sb, { workspaceId: asset.workspace_id, actorId: req.userId, eventType: "asset_deleted", entityType: "asset", entityId: assetId });
    return { assetId, deleted: true };
  });

  app.post("/assets/:assetId/restore", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const sb = app.supabaseFactory(req.userToken);
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceEditor(sb, asset.workspace_id, req.userId);
    if (!asset.deleted_at) throw new AppError(409, "asset is not deleted");
    const { error } = await sb.from("assets").update({ deleted_at: null, status: "draft" }).eq("id", assetId);
    if (error) throw new AppError(500, error.message);
    await logActivity(sb, { workspaceId: asset.workspace_id, actorId: req.userId, eventType: "asset_restored", entityType: "asset", entityId: assetId });
    return { assetId, restored: true };
  });

  // Usage: where this asset is referenced (chapters, nodes, covers...).
  app.get("/assets/:assetId/usage", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const sb = app.supabaseFactory(req.userToken);
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceMember(sb, asset.workspace_id, req.userId);
    const { data, error } = await sb.from("asset_links").select("*").eq("asset_id", assetId);
    if (error) throw new AppError(500, error.message);
    return { links: data };
  });
}
