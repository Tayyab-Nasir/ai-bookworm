import type { Approval, Asset } from "@bookworm/types";

const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const cleanScanStates = new Set(["clean", "trusted_generated"]);

type ArtworkState = Pick<Asset,
  "mime_type" | "checksum" | "status" | "deleted_at" | "requires_approval" | "current_version_number" | "current_scan_status">;
type RequestableArtworkState = ArtworkState & Pick<Asset, "id">;
type ArtworkApprovalState = Pick<Approval,
  "entity_type" | "entity_id" | "entity_version_number" | "status" | "superseded_at">;
function isConfirmedArtwork(asset: ArtworkState) {
  return !asset.deleted_at
    && imageMimeTypes.has(asset.mime_type)
    && /^[a-f0-9]{64}$/iu.test(asset.checksum)
    && Number.isSafeInteger(asset.current_version_number) && Number(asset.current_version_number) > 0
    && cleanScanStates.has(String(asset.current_scan_status));
}

export function isArtworkPlaceable(asset: ArtworkState) {
  return isConfirmedArtwork(asset)
    && !["archived", "rejected"].includes(asset.status)
    && (asset.requires_approval !== true || asset.status === "approved");
}

export function isArtworkRequestable(asset: ArtworkState) {
  return isConfirmedArtwork(asset)
    && asset.requires_approval === true
    && asset.status === "draft";
}

export function getRequestableArtwork<T extends RequestableArtworkState>(
  assets: readonly T[],
  approvals: readonly ArtworkApprovalState[],
): T[] {
  const pendingVersions = new Set(approvals
    .filter((approval) => approval.entity_type === "asset"
      && approval.status === "pending"
      && approval.superseded_at == null
      && typeof approval.entity_version_number === "number")
    .map((approval) => `${approval.entity_id}:${approval.entity_version_number}`));

  return assets
    .filter(isArtworkRequestable)
    .filter((asset) => !pendingVersions.has(`${asset.id}:${asset.current_version_number}`));
}

export function getOrCreateApprovalRequestKey(
  keys: Map<string, string>,
  identity: string,
  create: () => string,
) {
  const existing = keys.get(identity);
  if (existing) return existing;
  const created = create();
  keys.set(identity, created);
  return created;
}
