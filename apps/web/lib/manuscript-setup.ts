import { ApiClientError, type CreateBookRequest, type createClient } from "@bookworm/api-client";

export type SetupStage = "creating" | "uploading" | "scanning" | "importing" | "drafting";
export type SetupMode = "blank" | "import" | "ai";
export type SetupCheckpoint = {
  version: 1; userId: string; workspaceId: string; bookId: string; savedAt: number;
  completed: boolean; importing: boolean;
  bookCreated?: boolean;
  setupMode?: SetupMode;
  source?: { assetId: string; checksumSha256: string; sizeBytes: number };
  starter?: { chapterId: string; jobId?: string };
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const setupKey = (userId: string, workspaceId: string) => `bookworm:setup:${userId}:${workspaceId}`;

// Store only recovery identifiers/integrity data, never manuscript bytes or URLs.
export function readSetupCheckpoint(raw: string | null, userId: string, workspaceId: string, now = Date.now()): SetupCheckpoint | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || value.userId !== userId || value.workspaceId !== workspaceId
      || !uuid.test(value.bookId) || typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt)
      || now - value.savedAt > 86400_000 || value.savedAt > now || typeof value.completed !== "boolean" || typeof value.importing !== "boolean") return null;
    const setupMode = value.setupMode;
    if (setupMode !== undefined && setupMode !== "blank" && setupMode !== "import" && setupMode !== "ai") return null;
    if (setupMode && (setupMode === "import") !== value.importing) return null;
    if (value.bookCreated !== undefined && typeof value.bookCreated !== "boolean") return null;
    const source = value.source;
    if (value.bookCreated === false && (value.completed || source || value.starter)) return null;
    if (source && (!uuid.test(source.assetId) || !/^[a-f0-9]{64}$/.test(source.checksumSha256)
      || !Number.isInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > 20 * 1024 * 1024)) return null;
    const starter = value.starter;
    if (starter && (setupMode !== "ai" || !uuid.test(starter.chapterId) || (starter.jobId !== undefined && !uuid.test(starter.jobId)))) return null;
    return { version: 1, userId, workspaceId, bookId: value.bookId, savedAt: value.savedAt, completed: value.completed, importing: value.importing,
      ...(setupMode ? { setupMode } : {}),
      ...(value.bookCreated !== undefined ? { bookCreated: value.bookCreated } : {}),
      ...(source ? { source: { assetId: source.assetId, checksumSha256: source.checksumSha256, sizeBytes: source.sizeBytes } } : {}),
      ...(starter ? { starter: { chapterId: starter.chapterId, ...(starter.jobId ? { jobId: starter.jobId } : {}) } } : {}) };
  } catch { return null; }
}

type SetupApi = Pick<ReturnType<typeof createClient>, "createBook" | "createAssetUploadUrl" | "confirmAssetUpload"
  | "listAssetVersions" | "importManuscript" | "getAssetUsage">;

export async function recoverManuscriptReport(api: Pick<ReturnType<typeof createClient>, "getManuscriptImport">, checkpoint: SetupCheckpoint) {
  if (!checkpoint.importing || !checkpoint.source) return null;
  const result = await api.getManuscriptImport(checkpoint.bookId, checkpoint.source.assetId);
  return result.import?.report ?? null;
}

export async function runManuscriptSetup(input: {
  api: SetupApi; userId: string; details: CreateBookRequest; importing: boolean;
  file: File | null; checkpoint: SetupCheckpoint | null;
  save: (checkpoint: SetupCheckpoint) => void; stage: (stage: SetupStage) => void;
  setupMode?: SetupMode; finishWhenBookCreated?: boolean;
  newBookId?: () => string;
  upload?: typeof fetch;
  queueImport?: ReturnType<typeof createClient>["queueManuscriptImport"];
}) {
  let checkpoint = input.checkpoint;
  const setupMode = input.setupMode ?? (input.importing ? "import" : "blank");
  const checkpointMode = checkpoint?.setupMode ?? (checkpoint?.importing ? "import" : "blank");
  if (checkpoint && (checkpoint.userId !== input.userId || checkpoint.workspaceId !== input.details.workspaceId || checkpoint.importing !== input.importing || checkpointMode !== setupMode)) {
    throw new Error("The active account or workspace changed. Reload before continuing.");
  }
  if (checkpoint?.completed) return { bookId: checkpoint.bookId, report: null };
  if (input.importing && !checkpoint?.source && !input.file) throw new Error("Choose your manuscript file to continue this book.");
  if (input.importing && !checkpoint?.source && input.file
    && (!/\.(txt|docx|epub|pdf)$/i.test(input.file.name) || input.file.size < 1 || input.file.size > 20 * 1024 * 1024)) {
    throw new Error("Choose a non-empty TXT, DOCX, EPUB or PDF file up to 20 MB.");
  }
  const save = () => { checkpoint = { ...checkpoint!, savedAt: Date.now() }; input.save(checkpoint); };
  if (!checkpoint) {
    const bookId = (input.newBookId ?? (() => crypto.randomUUID()))();
    if (!uuid.test(bookId)) throw new Error("Could not create a valid book request ID.");
    checkpoint = { version: 1, userId: input.userId, workspaceId: input.details.workspaceId,
      bookId, savedAt: Date.now(), completed: false, importing: input.importing, setupMode, bookCreated: false };
  }
  if (checkpoint.bookCreated === false) {
    input.stage("creating");
    save(); // Verify the retry identity persists before every create dispatch.
    const book = await input.api.createBook({ ...input.details, requestId: checkpoint.bookId });
    if (book.id !== checkpoint.bookId) throw new Error("Book creation returned a different ID. Check your library before continuing.");
    checkpoint.bookCreated = true;
    save();
  }
  if (!input.importing) {
    if (input.finishWhenBookCreated ?? true) { checkpoint.completed = true; save(); }
    return { bookId: checkpoint.bookId, report: null };
  }
  if (!checkpoint.source) {
    input.stage("uploading");
    const file = input.file!;
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const checksumSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const { uploadUrl, assetId } = await input.api.createAssetUploadUrl({ workspaceId: input.details.workspaceId,
      filename: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size, type: "manuscript" });
    const response = await (input.upload ?? fetch)(uploadUrl, { method: "PUT", body: bytes });
    if (!response.ok) throw new Error(`Source upload failed (${response.status}). Retry with the same book.`);
    checkpoint.source = { assetId, checksumSha256, sizeBytes: file.size };
    save(); // Keep the original pointer even if screening's response is lost.
  }
  const source = checkpoint.source;
  input.stage("scanning");
  try {
    await input.api.confirmAssetUpload(source.assetId, { checksumSha256: source.checksumSha256, sizeBytes: source.sizeBytes });
  } catch (error) {
    if (!(error instanceof ApiClientError) || error.status !== 409) throw error;
    const { versions } = await input.api.listAssetVersions(source.assetId);
    if (versions.some((v) => v.version_number > 1)) throw new Error("The source asset has newer versions. Review it in Assets before importing; this setup will not silently use replacement content.");
    if (!versions.some((v) => v.version_number === 1 && v.checksum === source.checksumSha256 && v.scan_status === "clean")) throw error;
  }
  input.stage("importing");
  if (input.queueImport) {
    const { job } = await input.queueImport(checkpoint.bookId, source.assetId);
    save(); // The receipt, not a queued/running job, proves completed import.
    return { bookId: checkpoint.bookId, report: null, job };
  }
  let report = null;
  try { report = (await input.api.importManuscript(checkpoint.bookId, source.assetId)).report; }
  catch (error) {
    if (!(error instanceof ApiClientError) || error.status !== 409) throw error;
    // Legacy text-only imports have a source link rather than a result receipt.
    const { links } = await input.api.getAssetUsage(source.assetId);
    if (!links.some((link) => link.entity_type === "book" && link.entity_id === checkpoint!.bookId && link.usage_role === "manuscript_source")) throw error;
  }
  checkpoint.completed = true; save();
  return { bookId: checkpoint.bookId, report };
}
