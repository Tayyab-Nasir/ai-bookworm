// Only opaque IDs live in tab storage. The receipt, not this marker, owns the outcome.
export type CommunityJoinMarker = { version: 1; communityId: string; operationId: string };
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const key = (actor: string) => `bookworm:community-join:v1:${actor}`;
const unavailable = () => new Error("Community join recovery is unavailable in this tab. Enable session storage and refresh before joining.");

export function communityJoinStorage(): RecoveryStorage {
  try { return window.sessionStorage; } catch { throw unavailable(); }
}

export function readCommunityJoin(storage: RecoveryStorage, actor: string): CommunityJoinMarker | null {
  try {
    if (!uuid.test(actor)) throw unavailable();
    const raw = storage.getItem(key(actor));
    if (raw === null) return null;
    if (raw.length > 512) throw unavailable();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "communityId,operationId,version" || record.version !== 1
      || typeof record.communityId !== "string" || !uuid.test(record.communityId)
      || typeof record.operationId !== "string" || !uuid.test(record.operationId)) throw unavailable();
    return { version: 1, communityId: record.communityId, operationId: record.operationId };
  } catch { throw unavailable(); }
}

export function rememberCommunityJoin(storage: RecoveryStorage, actor: string, marker: CommunityJoinMarker): void {
  try {
    const existing = readCommunityJoin(storage, actor);
    if (existing && (existing.communityId !== marker.communityId || existing.operationId !== marker.operationId)) throw unavailable();
    if (marker.version !== 1 || !uuid.test(marker.communityId) || !uuid.test(marker.operationId)) throw unavailable();
    storage.setItem(key(actor), JSON.stringify(marker));
    const saved = readCommunityJoin(storage, actor);
    if (!saved || saved.communityId !== marker.communityId || saved.operationId !== marker.operationId) throw unavailable();
  } catch { throw unavailable(); }
}

/** Never clear a newer request when an older response arrives late. */
export function forgetCommunityJoin(storage: RecoveryStorage, actor: string, marker: CommunityJoinMarker): boolean {
  try {
    const current = readCommunityJoin(storage, actor);
    if (!current || current.communityId !== marker.communityId || current.operationId !== marker.operationId) return false;
    storage.removeItem(key(actor));
    if (storage.getItem(key(actor)) !== null) throw unavailable();
    return true;
  } catch { throw unavailable(); }
}
