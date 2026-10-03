import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "./supabase.js";

type ImageReference = { assetId?: string | null; assetVersionNumber?: number };

export const artworkSnapshotSchema = z.object({
  schemaVersion: z.literal(1), coverAssetId: z.string().uuid().nullable(),
  illustrationAssetIds: z.array(z.string().uuid()).max(100),
  assets: z.array(z.object({
    assetId: z.string().uuid(), versionNumber: z.number().int().min(1).max(2147483647),
    storagePath: z.string().min(1).max(1024), checksum: z.string().regex(/^[a-f0-9]{64}$/u),
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    sizeBytes: z.number().int().min(1).max(25 * 1024 * 1024),
    requiresApproval: z.boolean(), approvalId: z.string().uuid().nullable(),
  }).strict().refine(asset => asset.requiresApproval === (asset.approvalId !== null))).max(100),
}).strict().refine(snapshot => {
  const ids = new Set(snapshot.assets.map(asset => asset.assetId));
  const used = new Set([...snapshot.illustrationAssetIds, ...(snapshot.coverAssetId ? [snapshot.coverAssetId] : [])]);
  return ids.size === snapshot.assets.length && new Set(snapshot.illustrationAssetIds).size === snapshot.illustrationAssetIds.length
    && ids.size === used.size && [...used].every(id => ids.has(id))
    && snapshot.assets.reduce((total, asset) => total + asset.sizeBytes, 0) <= 100 * 1024 * 1024;
});
export type ArtworkSnapshot = z.infer<typeof artworkSnapshotSchema>;

/** Bind proofs to verified bytes AND the exact version/review identity. */
export function renderImagesFingerprint(images: {
  coverBase64: string | null; assetImagesBase64: Record<string, string>; artworkSnapshot: ArtworkSnapshot;
}) {
  // Parsing reconstructs object keys in schema order: PostgreSQL jsonb does not
  // preserve insertion order. Asset/reference arrays are also canonicalized.
  const snapshot = artworkSnapshotSchema.parse(images.artworkSnapshot);
  snapshot.illustrationAssetIds.sort(); snapshot.assets.sort((a, b) => a.assetId.localeCompare(b.assetId));
  const hash = createHash("sha256").update(JSON.stringify(snapshot)).update(JSON.stringify(images.coverBase64));
  for (const id of Object.keys(images.assetImagesBase64).sort()) {
    hash.update(JSON.stringify(id)).update(JSON.stringify(images.assetImagesBase64[id]));
  }
  return hash.digest("hex");
}

export async function assertRenderImagesCurrent(sb: SupabaseClient, workspaceId: string,
  illustrationIds: string[], coverId: string | null, references: readonly ImageReference[], expected: string) {
  const images = await loadRenderImages(sb, workspaceId, illustrationIds, coverId, references);
  if (renderImagesFingerprint(images) !== expected) {
    throw new AppError(422, "Book artwork changed during this request. Render and run preflight again before exporting.");
  }
}

/** Load only confirmed current bytes, never substitute a new revision for a placed one. */
export async function loadRenderImages(
  sb: SupabaseClient, workspaceId: string, illustrationIds: string[], coverId: string | null,
  references: readonly ImageReference[] = [],
) {
  const ids = [...new Set([...illustrationIds, ...(coverId ? [coverId] : [])])];
  if (ids.length > 100) throw new AppError(422, "A render can include at most 100 images.");
  const artworkSnapshot: ArtworkSnapshot = { schemaVersion: 1, coverAssetId: coverId,
    illustrationAssetIds: [...new Set(illustrationIds)].sort(), assets: [] };
  if (!ids.length) return { coverBase64: null, assetImagesBase64: {} as Record<string, string>, artworkSnapshot };
  const pins = new Map<string, number>();
  const unpinned = new Set<string>();
  for (const reference of references) {
    if (!reference.assetId || !ids.includes(reference.assetId)) continue;
    const version = reference.assetVersionNumber;
    if (version === undefined) { unpinned.add(reference.assetId); continue; }
    if (!Number.isSafeInteger(version) || version < 1 || (pins.has(reference.assetId) && pins.get(reference.assetId) !== version)) {
      throw new AppError(422, "Illustration placements have conflicting or invalid versions. Review them before rendering.");
    }
    pins.set(reference.assetId, version);
  }
  const { data, error } = await sb.from("assets")
    .select("id,workspace_id,storage_path,mime_type,size_bytes,checksum,status,requires_approval,deleted_at")
    .eq("workspace_id", workspaceId).is("deleted_at", null).in("id", ids);
  if (error) throw new AppError(503, "Render image metadata could not be verified.");
  if (!data || data.length !== ids.length) throw new AppError(422, "A book image is missing or belongs to another workspace.");

  let totalBytes = 0;
  const encoded = new Map<string, string>();
  for (const asset of data.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (asset.deleted_at || ["archived", "rejected"].includes(asset.status)) throw new AppError(422, "A render image is archived, rejected or unavailable.");
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(asset.mime_type)
      || typeof asset.checksum !== "string" || !/^[a-f0-9]{64}$/iu.test(asset.checksum)) {
      throw new AppError(422, "All render images must be confirmed image assets.");
    }
    const expectedSize = Number(asset.size_bytes);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 25 * 1024 * 1024) throw new AppError(422, "A render image exceeds the 25 MB limit.");
    totalBytes += expectedSize;
    if (totalBytes > 100 * 1024 * 1024) throw new AppError(422, "Render images exceed the 100 MB total limit.");

    const { data: version, error: versionError } = await sb.from("asset_versions")
      .select("version_number,storage_path,checksum,mime_type,size_bytes,scan_status")
      .eq("asset_id", asset.id).eq("storage_path", asset.storage_path).maybeSingle();
    if (versionError) throw new AppError(503, "Render image version could not be verified.");
    if (!version || !Number.isSafeInteger(version.version_number) || version.version_number < 1
      || version.storage_path !== asset.storage_path || typeof version.checksum !== "string"
      || version.checksum.toLowerCase() !== asset.checksum.toLowerCase()
      || version.mime_type !== asset.mime_type || Number(version.size_bytes) !== expectedSize
      || !["clean", "trusted_generated"].includes(String(version.scan_status))) {
      throw new AppError(422, "A render image is not a clean, confirmed current version.");
    }
    if (pins.has(asset.id) && pins.get(asset.id) !== version.version_number) {
      throw new AppError(422, "A placed illustration version has changed. Review and replace its manuscript placement before rendering.");
    }
    let approvalId: string | null = null;
    if (asset.requires_approval === true) {
      if (illustrationIds.includes(asset.id) && (!pins.has(asset.id) || unpinned.has(asset.id))) {
        throw new AppError(422, "Review-required illustrations must have an explicit approved version on every manuscript placement.");
      }
      if (asset.status !== "approved") throw new AppError(422, "Artwork must be approved for its exact current version before rendering.");
      const { data: approval, error: approvalError } = await sb.from("approvals").select("id")
        .eq("workspace_id", workspaceId).eq("entity_type", "asset").eq("entity_id", asset.id)
        .eq("entity_version_number", version.version_number).eq("status", "approved").is("superseded_at", null).maybeSingle();
      if (approvalError) throw new AppError(503, "Artwork approval could not be verified.");
      if (!approval) throw new AppError(422, "Artwork must be approved for its exact current version before rendering.");
      approvalId = approval.id;
    }
    const { data: stored, error: downloadError } = await sb.storage.from("book-assets").download(asset.storage_path);
    if (downloadError || !stored) throw new AppError(503, "A render image could not be loaded from private storage.");
    if (stored.size !== expectedSize) throw new AppError(422, "A render image no longer matches its confirmed version.");
    const bytes = Buffer.from(await stored.arrayBuffer());
    if (bytes.length !== expectedSize || createHash("sha256").update(bytes).digest("hex") !== asset.checksum.toLowerCase()) {
      throw new AppError(422, "A render image no longer matches its confirmed version.");
    }
    encoded.set(asset.id, bytes.toString("base64"));
    artworkSnapshot.assets.push({ assetId: asset.id, versionNumber: version.version_number, storagePath: asset.storage_path,
      checksum: asset.checksum.toLowerCase(), mimeType: asset.mime_type, sizeBytes: expectedSize,
      requiresApproval: asset.requires_approval === true, approvalId });
  }
  return { coverBase64: coverId ? encoded.get(coverId) ?? null : null,
    assetImagesBase64: Object.fromEntries(illustrationIds.map(id => [id, encoded.get(id)!])), artworkSnapshot };
}
