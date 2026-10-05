import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { encodeNarrationPcm } from "./lib/narration-encoding.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const pcm = Buffer.alloc(48_000);
const mp3 = Buffer.from([0xff, 0xfb, 0xb0, 0xc0, 1, 2, 3, 4]); // HTTP transport fixture, not native encoding.
const profile = { encodingVersion: "narration-mp3-1.0.0", pcmSha256: sha(pcm), sampleRateHz: 44100,
  channels: 1, bitRateKbps: 192, bitRateMode: "cbr", durationSeconds: 1 };
function response(changes: { bytes?: Buffer; profile?: unknown; headers?: Record<string, string>; status?: number } = {}) {
  const bytes = changes.bytes ?? mp3;
  return new Response(bytes, { status: changes.status ?? 200, headers: { "content-type": "audio/mpeg",
    "x-artifact-sha256": sha(bytes), "x-bookworm-narration-encoding": JSON.stringify(changes.profile ?? profile), ...changes.headers } });
}
test("private encoder binds source, checksum, profile and bounded abortable request", async () => {
  let calls = 0;
  const fetcher = (async (url, options) => {
    calls++;
    assert.match(String(url), /\/audio\/encode-narration$/);
    assert.equal(options?.redirect, "error"); assert.equal(options?.method, "POST");
    assert(options?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(options.body)), { pcmBase64: pcm.toString("base64"), pcmSha256: sha(pcm),
      sampleRateHz: 24000, channels: 1, bitDepth: 16 });
    return response();
  }) as typeof fetch;
  const result = await encodeNarrationPcm(pcm, { fetcher });
  assert.deepEqual(result.bytes, mp3); assert.equal(result.checksum, sha(mp3));
  assert.deepEqual(result.profile, profile); assert.equal(calls, 1);
});
test("encoder rejects incomplete, oversized or aborted source before HTTP", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return response(); }) as typeof fetch;
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(12 * 1024 * 1024 + 2)]) {
    await assert.rejects(encodeNarrationPcm(bytes, { fetcher }));
  }
  await assert.rejects(encodeNarrationPcm(pcm, { fetcher, signal: AbortSignal.abort() }));
  assert.equal(calls, 0);
});
test("encoder refuses foreign PCM, wrong duration/profile, unknown fields, MIME, hashes and oversized headers", async () => {
  const cases: Parameters<typeof response>[0][] = [
    { profile: { ...profile, pcmSha256: "a".repeat(64) } }, { profile: { ...profile, durationSeconds: 2 } },
    { profile: { ...profile, durationSeconds: null } }, { profile: { ...profile, sampleRateHz: 24000 } },
    { profile: { ...profile, bitRateKbps: 96 } }, { profile: { ...profile, bitRateMode: "vbr" } },
    { profile: { ...profile, extra: 1 } }, { headers: { "content-type": "image/png" } },
    { headers: { "x-artifact-sha256": "a".repeat(64) } }, { headers: { "content-length": String(8 * 1024 * 1024 + 1) } },
    { headers: { "x-bookworm-narration-encoding": "x".repeat(2049) } }, { bytes: Buffer.alloc(8) },
  ];
  for (const changes of cases) await assert.rejects(encodeNarrationPcm(pcm, { fetcher: (async () => response(changes)) as typeof fetch }));
});
test("encoder caps chunked responses, cancels them and hides private HTTP failures", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(8 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; } });
  await assert.rejects(encodeNarrationPcm(pcm, { fetcher: (async () => new Response(stream)) as typeof fetch }));
  assert.equal(cancelled, true);
  for (const status of [422, 503]) await assert.rejects(encodeNarrationPcm(pcm, {
    fetcher: (async () => response({ status })) as typeof fetch }), error => !String(error).includes("private runtime"));
  await assert.rejects(encodeNarrationPcm(pcm, { fetcher: (async () => { throw new Error("private runtime"); }) as typeof fetch }),
    error => !String(error).includes("private runtime"));
});
