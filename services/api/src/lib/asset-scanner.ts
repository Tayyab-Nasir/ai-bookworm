import { TextDecoder } from "node:util";

export const MAX_USER_ASSET_BYTES = 100 * 1024 * 1024;

const MIME_BY_EXTENSION = new Map<string, readonly string[]>([
  ["txt", ["text/plain"]],
  ["md", ["text/markdown", "text/plain"]],
  ["markdown", ["text/markdown", "text/plain"]],
  ["pdf", ["application/pdf"]],
  ["docx", ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]],
  ["epub", ["application/epub+zip"]],
  ["png", ["image/png"]],
  ["jpg", ["image/jpeg"]],
  ["jpeg", ["image/jpeg"]],
  ["webp", ["image/webp"]],
  ["gif", ["image/gif"]],
]);

export const USER_ASSET_MIME_TYPES = [
  "application/octet-stream",
  ...new Set([...MIME_BY_EXTENSION.values()].flat()),
] as const;

export type DetectedAssetMimeType = Exclude<(typeof USER_ASSET_MIME_TYPES)[number], "application/octet-stream">;

export interface AssetScanInput {
  assetId: string;
  workspaceId: string;
  version: number;
  filename: string;
  bytes: Buffer;
  checksumSha256: string;
  detectedMimeType: DetectedAssetMimeType;
}

export interface AssetScanVerdict {
  verdict: "clean" | "infected";
  /** Bounded scanner/engine revision, never a secret or raw provider response. */
  signature: string;
}

export interface AssetMalwareScanner {
  /** Stable, non-secret scanner identity recorded in the audit trail. */
  name: string;
  scan(input: AssetScanInput): Promise<AssetScanVerdict>;
}

export class AssetInspectionError extends Error {
  constructor(public readonly code: "unsupported_content" | "content_type_mismatch", message: string) {
    super(message);
    this.name = "AssetInspectionError";
  }
}

export const unavailableAssetScanner: AssetMalwareScanner = {
  name: "unconfigured",
  async scan() {
    throw new Error("asset malware scanner is unavailable");
  },
};

const MAX_SCANNER_RESPONSE_BYTES = 32 * 1024;

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("scanner returned a non-JSON response");
  }
  if (Number(response.headers.get("content-length") ?? 0) > MAX_SCANNER_RESPONSE_BYTES) {
    throw new Error("scanner response is too large");
  }
  if (!response.body) throw new Error("scanner response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SCANNER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("scanner response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("scanner response is invalid");
  return parsed as Record<string, unknown>;
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/u.test(value)) {
    throw new Error("scanner response is invalid");
  }
  return value.trim();
}

/** Private HTTP adapter. Configuration is evaluated lazily so non-upload API
 * routes remain available when the scanner is intentionally unconfigured. */
export function createHttpAssetScanner(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): AssetMalwareScanner {
  return {
    name: "bookworm-private-clamav",
    async scan(input) {
      const rawUrl = env.SCANNING_SERVICE_URL?.trim();
      const token = env.SCANNING_SERVICE_TOKEN ?? "";
      if (!rawUrl || token.length < 32 || token.length > 512 || token !== token.trim() || /[\r\n]/u.test(token)) {
        throw new Error("scanner configuration is unavailable");
      }
      const base = new URL(rawUrl);
      if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        throw new Error("scanner URL is invalid");
      }
      const rawTimeout = Number(env.SCANNING_SERVICE_TIMEOUT_MS ?? 30_000);
      if (!Number.isSafeInteger(rawTimeout) || rawTimeout < 1_000 || rawTimeout > 120_000) {
        throw new Error("scanner timeout is invalid");
      }
      const endpoint = new URL("/v1/scan", base.origin);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/octet-stream",
          "x-content-sha256": input.checksumSha256,
          "x-content-mime": input.detectedMimeType,
        },
        body: input.bytes,
        redirect: "error",
        signal: AbortSignal.timeout(rawTimeout),
      });
      if (!response.ok) throw new Error("scanner did not return a verdict");
      const body = await readBoundedJson(response);
      const verdict = body.verdict;
      if ((verdict !== "clean" && verdict !== "infected")
        || body.clean !== (verdict === "clean")
        || body.infected !== (verdict === "infected")
        || body.sha256 !== input.checksumSha256
        || body.mimeType !== input.detectedMimeType
        || body.sizeBytes !== input.bytes.length) {
        throw new Error("scanner verdict does not match the submitted content");
      }
      const engine = body.engine;
      if (!engine || typeof engine !== "object" || Array.isArray(engine)) throw new Error("scanner engine metadata is invalid");
      const engineRecord = engine as Record<string, unknown>;
      const engineSignature = [
        boundedString(engineRecord.name, 40),
        boundedString(engineRecord.version, 64),
        boundedString(engineRecord.databaseVersion, 64),
      ].join("/");
      const signature = verdict === "infected" ? boundedString(body.signature, 200) : engineSignature;
      return { verdict, signature };
    },
  };
}

function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const index = base.lastIndexOf(".");
  return index < 0 ? "" : base.slice(index + 1).toLowerCase();
}

function startsWith(bytes: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.length) return false;
    const controls = [...text].filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 && character !== "\n" && character !== "\r" && character !== "\t";
    }).length;
    return controls / text.length < 0.01;
  } catch {
    return false;
  }
}

function sniffZipContainer(bytes: Buffer): DetectedAssetMimeType | null {
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return null;
  // Container names are repeated in ZIP central-directory records. We do not
  // extract or execute archive contents at this trust boundary.
  const haystack = bytes.toString("latin1");
  if (haystack.includes("word/document.xml") && haystack.includes("[Content_Types].xml")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (haystack.includes("META-INF/container.xml") && haystack.includes("application/epub+zip")) {
    return "application/epub+zip";
  }
  return null;
}

export function validateAssetUploadDeclaration(filename: string, declaredMimeType: string): void {
  const allowed = MIME_BY_EXTENSION.get(extensionOf(filename));
  if (!allowed || !USER_ASSET_MIME_TYPES.includes(declaredMimeType as (typeof USER_ASSET_MIME_TYPES)[number])) {
    throw new AssetInspectionError("unsupported_content", "This file type is not supported.");
  }
  if (declaredMimeType !== "application/octet-stream" && !allowed.includes(declaredMimeType)) {
    throw new AssetInspectionError("content_type_mismatch", "The filename and declared content type do not match.");
  }
}

export function sniffAssetContent(
  bytes: Buffer,
  filename: string,
  declaredMimeType: string,
): DetectedAssetMimeType {
  validateAssetUploadDeclaration(filename, declaredMimeType);
  let detected: DetectedAssetMimeType | null = null;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) detected = "application/pdf";
  else if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) detected = "image/png";
  else if (startsWith(bytes, [0xff, 0xd8, 0xff])) detected = "image/jpeg";
  else if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") detected = "image/webp";
  else if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") detected = "image/gif";
  else detected = sniffZipContainer(bytes);
  if (!detected && isUtf8Text(bytes)) detected = extensionOf(filename) === "txt" ? "text/plain" : "text/markdown";

  const allowed = MIME_BY_EXTENSION.get(extensionOf(filename)) ?? [];
  if (!detected || !allowed.includes(detected)) {
    throw new AssetInspectionError("content_type_mismatch", "The stored bytes do not match the allowed file type.");
  }
  if (declaredMimeType !== "application/octet-stream" && !allowed.includes(declaredMimeType)) {
    throw new AssetInspectionError("content_type_mismatch", "The stored bytes do not match the declared content type.");
  }
  return detected;
}
