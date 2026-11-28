/** Private bounded conversion of saved provider PCM; never generates new speech. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import { MAX_NARRATION_PCM_BYTES } from "./realtime-narration.js";

export const MAX_NARRATION_MP3_BYTES = 8 * 1024 * 1024;
export const narrationEncodingProfileSchema = z.object({
  encodingVersion: z.literal("narration-mp3-1.0.0"), pcmSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sampleRateHz: z.literal(44100), channels: z.literal(1), bitRateKbps: z.literal(192), bitRateMode: z.literal("cbr"),
  durationSeconds: z.number().finite().positive().max(MAX_NARRATION_PCM_BYTES / 48_000 + 0.25),
}).strict();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const isNarrationMp3 = (bytes: Buffer) => bytes.length >= 4 &&
  (bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0));
const unavailable = () => new AppError(503, "Saved narration could not be encoded or verified. Its original evidence is unchanged.");

export async function encodeNarrationPcm(pcm: Buffer, options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2 || pcm.length > MAX_NARRATION_PCM_BYTES || pcm.length % 2) {
    throw new AppError(422, "Narration requires bounded complete 24-kHz mono 16-bit PCM.");
  }
  if (options.signal?.aborted) throw unavailable();
  const token = process.env.RENDERING_SERVICE_TOKEN || process.env.SERVICE_AUTH_TOKEN;
  if (!options.fetcher && !token) throw unavailable();
  const base = process.env.RENDERING_SERVICE_URL ?? `http://127.0.0.1:${process.env.RENDERING_SERVICE_PORT ?? "8002"}`;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(130_000)]) : AbortSignal.timeout(130_000);
  const pcmSha256 = sha(pcm);
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(`${base.replace(/\/$/, "")}/audio/encode-narration`, {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-service-token": token } : {}) },
      body: JSON.stringify({ pcmBase64: pcm.toString("base64"), pcmSha256, sampleRateHz: 24000, channels: 1, bitDepth: 16 }),
      redirect: "error", signal,
    });
  } catch { throw unavailable(); }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 422) throw new AppError(422, "Saved narration cannot be encoded within the supported profile.");
    throw unavailable();
  }
  if (Number(response.headers.get("content-length")) > MAX_NARRATION_MP3_BYTES) {
    await response.body.cancel().catch(() => {}); throw unavailable();
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_NARRATION_MP3_BYTES) throw unavailable();
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
  } catch { await reader.cancel().catch(() => {}); throw unavailable(); }
  finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, size), checksum = sha(bytes);
  const header = response.headers.get("x-bookworm-narration-encoding");
  try {
    if (!header || header.length > 2048) throw unavailable();
    const profile = narrationEncodingProfileSchema.parse(JSON.parse(header));
    if (!isNarrationMp3(bytes) || response.headers.get("content-type")?.split(";")[0]?.trim() !== "audio/mpeg"
      || response.headers.get("x-artifact-sha256") !== checksum || profile.pcmSha256 !== pcmSha256
      || Math.abs(profile.durationSeconds - pcm.length / 48_000) > 0.25) throw unavailable();
    return { bytes, checksum, profile };
  } catch { throw unavailable(); }
}
