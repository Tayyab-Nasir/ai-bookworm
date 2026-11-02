import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";

const uuid = z.string().uuid();
const maxSegment = 50 * 1024 * 1024;
const boundedFetch = (disconnect: AbortSignal): typeof fetch => async (input, init) => {
  const signal = AbortSignal.any([disconnect, AbortSignal.timeout(60_000), ...(init?.signal ? [init.signal] : [])]);
  const response = await fetch(input, { ...init, signal, redirect: "error" });
  const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
  if (!path.startsWith("/storage/v1/object/") || !response.body) return response;
  const advertised = response.headers.get("content-length");
  if (advertised && (!/^\d+$/u.test(advertised) || Number(advertised) > maxSegment)) {
    await response.body.cancel().catch(() => {}); throw new Error("Private audio exceeds the segment limit.");
  }
  let size = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    size += chunk.byteLength;
    if (size > maxSegment) throw new Error("Private audio exceeds the segment limit.");
    controller.enqueue(chunk);
  } }), { signal });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};
const segmentAsset = z.object({ id: uuid, workspace_id: uuid, storage_path: z.string(), mime_type: z.literal("audio/mpeg"),
  type: z.literal("audiobook_segment"), size_bytes: z.number().int().positive().max(maxSegment),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i), deleted_at: z.null() }).passthrough();

/** Parse one bounded HTTP byte range; never accept multipart responses. */
export function audioByteRange(header: string | undefined, size: number) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) { if (!last) return null; return { start: Math.max(0, size - last), end: size - 1, partial: true }; }
  if (first >= size || (last !== null && last < first)) return null;
  return { start: first, end: Math.min(last ?? size - 1, size - 1), partial: true };
}

/** Return verified bytes only for the same account and caller-visible exact segment. */
export function privateAudioRoutes(app: FastifyInstance) {
  // Each response verifies a complete segment before slicing; bound concurrent memory.
  const serving = new Set<string>();
  app.get("/audiobook-jobs/:projectId/segments/:index/private-audio", async (req, reply) => {
    const parsed = z.object({ projectId: uuid, index: z.string().regex(/^(0|[1-9][0-9]{0,2})$/u) }).safeParse(req.params);
    if (!parsed.success || Number(parsed.data.index) >= 250) throw new AppError(404, "Narration segment not found.");
    if (req.headers["x-bookworm-actor"] !== req.userId) throw new AppError(409, "The original account is required to access this audio.");
    const { projectId, index } = parsed.data;
    const disconnect = new AbortController();
    req.raw.once("aborted", () => disconnect.abort()); reply.raw.once("close", () => disconnect.abort());
    const caller = app.supabaseFactory(req.userToken, boundedFetch(disconnect.signal));
    const project = await caller.from("audiobook_projects").select("id,workspace_id,segment_count").eq("id", projectId).maybeSingle();
    if (project.error) throw new AppError(503, "Narration is unavailable.");
    if (!project.data || !uuid.safeParse(project.data.workspace_id).success || !Number.isInteger(project.data.segment_count)
      || Number(index) >= project.data.segment_count) throw new AppError(404, "Narration segment not found.");
    const segment = await caller.from("audiobook_segments").select("project_id,segment_index,asset_id,completed_at")
      .eq("project_id", projectId).eq("segment_index", Number(index)).maybeSingle();
    if (segment.error) throw new AppError(503, "Narration segment is unavailable.");
    if (!segment.data || segment.data.project_id !== projectId || segment.data.segment_index !== Number(index)
      || !segment.data.completed_at || !uuid.safeParse(segment.data.asset_id).success) throw new AppError(404, "Narration segment not found.");
    const result = await caller.from("assets").select("*").eq("id", segment.data.asset_id).eq("workspace_id", project.data.workspace_id).is("deleted_at", null).maybeSingle();
    const asset = segmentAsset.safeParse(result.data);
    if (result.error) throw new AppError(503, "Narration segment is unavailable.");
    if (!asset.success || asset.data.id !== segment.data.asset_id || asset.data.workspace_id !== project.data.workspace_id
      || asset.data.storage_path !== `workspaces/${project.data.workspace_id}/audiobooks/${projectId}/${index}.mp3`) throw new AppError(404, "Narration segment not found.");
    // No validator is offered, so If-Range cannot match: return the full body.
    const range = audioByteRange(req.headers["if-range"] ? undefined : req.headers.range, asset.data.size_bytes);
    reply.header("cache-control", "private, no-store").header("accept-ranges", "bytes").header("x-content-type-options", "nosniff");
    if (!range) return reply.code(416).header("content-range", `bytes */${asset.data.size_bytes}`).send();
    if (disconnect.signal.aborted) throw new AppError(503, "Narration request was disconnected.");
    const flight = `${req.userId}:${projectId}:${index}`;
    if (serving.has(flight) || serving.size >= 2) throw new AppError(429, "Narration playback is busy. Try again shortly.");
    serving.add(flight);
    let handedOff = false;
    try {
    const object = await caller.storage.from("book-assets").download(asset.data.storage_path);
    if (object.error || !object.data) throw new AppError(503, "Private narration is unavailable.");
    if (object.data.size !== asset.data.size_bytes) throw new AppError(503, "Narration integrity could not be verified.");
    const bytes = Buffer.from(await object.data.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== asset.data.checksum.toLowerCase()) throw new AppError(503, "Narration integrity could not be verified.");
    // Recheck RLS visibility before releasing the bytes, including revocation during the storage read.
    const access = await caller.from("audiobook_projects").select("id,workspace_id,segment_count").eq("id", projectId).maybeSingle();
    if (access.error || !access.data || access.data.id !== projectId || access.data.workspace_id !== project.data.workspace_id || access.data.segment_count !== project.data.segment_count)
      throw new AppError(403, "Narration access changed.");
    const recheckedSegment = await caller.from("audiobook_segments").select("project_id,segment_index,asset_id,completed_at")
      .eq("project_id", projectId).eq("segment_index", Number(index)).maybeSingle();
    const recheckedAsset = await caller.from("assets").select("*").eq("id", asset.data.id).eq("workspace_id", project.data.workspace_id).is("deleted_at", null).maybeSingle();
    const latest = segmentAsset.safeParse(recheckedAsset.data);
    if (recheckedSegment.error || !recheckedSegment.data || recheckedSegment.data.asset_id !== asset.data.id
      || recheckedSegment.data.project_id !== projectId || recheckedSegment.data.segment_index !== Number(index) || !recheckedSegment.data.completed_at
      || recheckedAsset.error || !latest.success || latest.data.storage_path !== asset.data.storage_path
      || latest.data.checksum !== asset.data.checksum || latest.data.size_bytes !== asset.data.size_bytes
      || latest.data.id !== asset.data.id || latest.data.workspace_id !== asset.data.workspace_id) throw new AppError(403, "Narration access changed.");
    // A dependency can complete after close even if it ignores cancellation.
    if (disconnect.signal.aborted) throw new AppError(503, "Narration request was disconnected.");
    reply.type("audio/mpeg").header("content-length", range.end - range.start + 1);
    if (range.partial) reply.code(206).header("content-range", `bytes ${range.start}-${range.end}/${bytes.length}`);
    const release = () => serving.delete(flight);
    reply.raw.once("finish", release); reply.raw.once("close", release); handedOff = true;
    return reply.send(bytes.subarray(range.start, range.end + 1));
    } finally { if (!handedOff) serving.delete(flight); }
  });

}
