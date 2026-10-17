import type { PublishingPackageJob, PublishingPackageRequest } from "@bookworm/api-client";
import { validateReaderDownload } from "./epub-reader";

export type PackagePointer = { schema: 1; userId: string; request: PublishingPackageRequest; closing?: true };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const channels = ["kdp", "apple", "barnesnoble", "lulu", "googleplay"];
const fields = ["bookId", "editionId", "channel", "renderJobId", "preflightJobId", "idempotencyKey"];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function packageRecoveryKey(userId: string, bookId: string) {
  if (!uuid.test(userId) || !uuid.test(bookId)) throw new Error("Verify your account and saved book before creating an export.");
  return `bookworm:package:v1:${userId}:${bookId}`;
}

export function readPackagePointer(storage: Pick<Storage, "getItem">, userId: string, bookId: string): PackagePointer | null {
  const raw = storage.getItem(packageRecoveryKey(userId, bookId));
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (raw.length > 1000 || !record(value) || !["request,schema,userId", "closing,request,schema,userId"].includes(Object.keys(value).sort().join())
      || ("closing" in value && value.closing !== true)
      || value.schema !== 1 || value.userId !== userId || !record(value.request)) throw new Error();
    const request = value.request;
    if (Object.keys(request).length !== fields.length || Object.keys(request).some(key => !fields.includes(key))
      || request.bookId !== bookId || !channels.includes(String(request.channel))
      || fields.filter(key => key !== "channel").some(key => typeof request[key] !== "string" || !uuid.test(request[key] as string))) throw new Error();
    return value as PackagePointer;
  } catch { throw new Error("The saved export request is invalid. It is retained; no new export will replace it."); }
}

export function persistPackagePointer(storage: Pick<Storage, "getItem" | "setItem">, pointer: PackagePointer) {
  const key = packageRecoveryKey(pointer.userId, pointer.request.bookId);
  const old = readPackagePointer(storage, pointer.userId, pointer.request.bookId);
  const raw = JSON.stringify(pointer);
  readPackagePointer({ getItem: () => raw }, pointer.userId, pointer.request.bookId);
  if (old && (old.userId !== pointer.userId || JSON.stringify(old.request) !== JSON.stringify(pointer.request) || (old.closing && !pointer.closing))) {
    throw new Error("Recover the original saved export before starting another request.");
  }
  try {
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new Error();
    readPackagePointer(storage, pointer.userId, pointer.request.bookId);
  } catch { throw new Error("Browser session recovery is unavailable. No export was sent. Enable session storage and retry."); }
}

export function clearPackagePointer(storage: Pick<Storage, "getItem" | "removeItem">, pointer: PackagePointer) {
  const old = readPackagePointer(storage, pointer.userId, pointer.request.bookId);
  if (old && JSON.stringify(old) !== JSON.stringify(pointer)) throw new Error("A newer export request must not be cleared.");
  const key = packageRecoveryKey(pointer.userId, pointer.request.bookId);
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("Export confirmed, but recovery could not be cleared. Recover this same request again.");
}

export function validatePackageResult(value: unknown, pointer: PackagePointer): PublishingPackageJob {
  const request = pointer.request;
  if (!record(value) || typeof value.id !== "string" || !uuid.test(value.id) || value.requestId !== request.idempotencyKey
    || value.bookId !== request.bookId || value.editionId !== request.editionId || value.channel !== request.channel
    || value.sourceRenderJobId !== request.renderJobId || value.sourcePreflightJobId !== request.preflightJobId
    || !["queued", "running", "succeeded", "failed", "cancelled"].includes(String(value.status)) || value.submissionMode !== "manual"
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || (value.package !== null && (value.status !== "succeeded" || !record(value.package) || !record(value.package.asset) || !record(value.package.download)
      || typeof value.package.asset.id !== "string" || !uuid.test(value.package.asset.id)
      || typeof value.package.asset.checksum !== "string" || !/^[a-f0-9]{64}$/i.test(value.package.asset.checksum)
      || !Number.isSafeInteger(value.package.asset.size_bytes) || Number(value.package.asset.size_bytes) <= 0))) {
    throw new Error("The export result does not match the saved request. Its original identity is retained; recover it again.");
  }
  if (record(value.package)) validateReaderDownload(value.package.download);
  return value as unknown as PublishingPackageJob;
}
