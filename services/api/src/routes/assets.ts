import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceEditor } from "../lib/authorize.js";

const BUCKET = "book-assets";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB, matches parser cap

const uploadUrlSchema = z.object({
  workspaceId: z.string().uuid(),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});

const confirmSchema = z.object({
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});

// Storage path per spec section 6: workspaces/{workspace_id}/assets/{asset_id}/v{version}/{safe_filename}
function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_");
  return safe.slice(0, 128) || "file";
}

export function assetRoutes(app: FastifyInstance) {
  app.post("/assets/upload-url", async (req) => {
    const parsed = uploadUrlSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid upload request", { issues: parsed.error.issues });
    const { workspaceId, filename, mimeType, sizeBytes } = parsed.data;
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(sb, workspaceId, req.userId);

    const { data: asset, error } = await sb
      .from("assets")
      .insert({
        workspace_id: workspaceId,
        type: "source_document",
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
    return { assetId, status: "draft", confirmed: true };
  });
}
