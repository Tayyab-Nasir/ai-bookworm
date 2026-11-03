import { createHash } from "node:crypto";
import { AppError } from "../errors.js";
import { MAX_USER_ASSET_BYTES } from "./asset-scanner.js";

// The SDK materializes downloads as Blob. Limit both response bytes and local
// concurrency; a multi-process deployment still needs a shared memory budget.
let busy = false;

export const assetRestoreFetch = (signal: AbortSignal, upstream: typeof fetch = fetch): typeof fetch => async (input, init) => {
  const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const combined = AbortSignal.any([signal, AbortSignal.timeout(60_000), ...(callerSignal ? [callerSignal] : [])]);
  const response = await upstream(input, { ...init, signal: combined, redirect: "error" });
  const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
  const limit = pathname.startsWith("/storage/v1/object/") ? MAX_USER_ASSET_BYTES : 16 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error("private asset response exceeds limit");
  }
  if (!response.body) return response;
  let size = 0;
  const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("private asset response exceeds limit");
      controller.enqueue(chunk);
    },
  }), { signal: combined });
  return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
};

/** Verify exactly the recorded bytes; the caller must also fence DB state. */
export async function verifyAssetRestoreBytes(download: () => Promise<{ data: Blob | null; error: unknown }>, expectedSize: number, expectedSha256: string) {
  if (busy) throw new AppError(503, "File verification is busy. Try again shortly.");
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_USER_ASSET_BYTES || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new AppError(409, "The removed file cannot be verified.");
  }
  busy = true;
  try {
    const { data, error } = await download();
    if (error || !data || data.size !== expectedSize) throw new AppError(409, "The removed file is missing or its contents changed.");
    const hash = createHash("sha256"); let count = 0;
    for await (const chunk of data.stream() as unknown as AsyncIterable<Uint8Array>) {
      count += chunk.byteLength;
      if (count > expectedSize) throw new AppError(409, "The removed file is missing or its contents changed.");
      hash.update(chunk);
    }
    if (count !== expectedSize || hash.digest("hex") !== expectedSha256) throw new AppError(409, "The removed file is missing or its contents changed.");
  } finally { busy = false; }
}
