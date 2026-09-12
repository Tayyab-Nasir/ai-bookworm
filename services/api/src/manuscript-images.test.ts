import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { embeddedImagesSchema, importManuscriptImages, readDocumentResponse } from "./lib/manuscript-images.js";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const PARSER_IMAGE = "22222222-2222-4222-8222-222222222222";
const CHAPTER = "33333333-3333-4333-8333-333333333333";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const image = { id: PARSER_IMAGE, filename: "image.png", mimeType: "image/png" as const,
  sizeBytes: png.length, checksumSha256: createHash("sha256").update(png).digest("hex"), contentBase64: png.toString("base64") };

function fixture(options: { verdict?: "clean" | "infected"; scannerDown?: boolean; storageMismatch?: boolean;
  rpcCode?: string; uncertain?: boolean; receipt?: unknown; raced?: boolean } = {}) {
  const calls: string[] = [];
  const stored = new Map<string, Buffer>();
  let committed: Record<string, any> | undefined;
  let commitName: string | undefined;
  const result = (ids: string[]) => ({ chapters: [{ id: CHAPTER }], assetIds: ids, sourceAssetId: SOURCE, report: { warnings: [] } });
  const service = {
    from() { const query = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: options.receipt ?? null, error: null }) }; return query; },
    storage: { from() { return {
      upload: async (path: string, bytes: Buffer) => { calls.push("upload"); stored.set(path, bytes); return { error: null }; },
      download: async (path: string) => ({ data: new Blob([Uint8Array.from(options.storageMismatch ? Buffer.from("bad") : stored.get(path)!)]), error: null }),
      remove: async (paths: string[]) => { calls.push("cleanup"); paths.forEach((path) => stored.delete(path)); return { error: null }; },
    }; } },
    rpc: async (name: string, args: Record<string, any>) => {
      calls.push("commit"); committed = args; commitName = name;
      if (options.uncertain) throw new Error("lost reply");
      return options.rpcCode ? { data: null, error: { code: options.rpcCode } }
        : { data: result(options.raced ? [PARSER_IMAGE] : args.p_images.map((i: any) => i.id)), error: null };
    },
  };
  const input = { service: service as never, scanner: { name: "fixture-scanner", scan: async () => {
    calls.push("scan"); if (options.scannerDown) throw new Error("offline");
    return { verdict: options.verdict ?? "clean" as const, signature: "fixture-signature" };
  } }, actorId: SOURCE, bookId: CHAPTER, workspaceId: SOURCE, sourceAssetId: SOURCE,
    sourceChecksum: "a".repeat(64), chapters: [{ title: "Arrival", nodes: [{ id: "art", type: "image" as const, assetId: PARSER_IMAGE, altText: "Harbor" }] }],
    images: [image], warnings: [] };
  return { input, calls, stored, result, committed: () => committed, commitName: () => commitName };
}

test("embedded import scans before upload, verifies bytes, remaps references and excludes payloads from SQL", async () => {
  const f = fixture();
  const saved = await importManuscriptImages(f.input);
  assert.deepEqual(f.calls, ["scan", "upload", "commit"]);
  const args = f.committed()!;
  assert.notEqual(args.p_images[0].id, PARSER_IMAGE);
  assert.equal(args.p_chapters[0].nodes[0].assetId, args.p_images[0].id);
  assert.equal(args.p_images[0].scanner, "fixture-scanner");
  assert.equal(args.p_images[0].checksum, image.checksumSha256);
  assert.equal(args.p_images[0].bytes, undefined);
  assert.ok(!JSON.stringify(args).includes(image.contentBase64));
  assert.equal(saved.assetIds[0], args.p_images[0].id);
});

for (const options of [{ verdict: "infected" as const }, { scannerDown: true }]) {
  test(`embedded import rejects ${options.verdict ?? "scanner outage"} before storage or chapter writes`, async () => {
    const f = fixture(options);
    await assert.rejects(importManuscriptImages(f.input), /screening/);
    assert.deepEqual(f.calls, ["scan"]);
  });
}

test("bad checksums, base64 and unknown image references never reach a commit", async () => {
  for (const change of [{ checksumSha256: "0".repeat(64) }, { contentBase64: `${image.contentBase64}\n` }]) {
    const f = fixture(); f.input.images = [{ ...image, ...change }];
    await assert.rejects(importManuscriptImages(f.input), /integrity/);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(); f.input.chapters[0].nodes[0].assetId = SOURCE;
  await assert.rejects(importManuscriptImages(f.input), /no verified image payload/);
  assert.ok(!f.calls.includes("upload"));
  assert.equal(embeddedImagesSchema.safeParse([{ ...image, storagePath: "foreign" }]).success, false);
});

test("failed readback and definite transaction rejection clean only new temporary files", async () => {
  for (const options of [{ storageMismatch: true }, { rpcCode: "22023" }]) {
    const f = fixture(options);
    await assert.rejects(importManuscriptImages(f.input));
    assert.equal(f.stored.size, 0);
    assert.equal(f.calls.at(-1), "cleanup");
  }
});

test("lost commit reply retains potentially referenced files; replay skips scan and upload", async () => {
  const f = fixture({ uncertain: true });
  await assert.rejects(importManuscriptImages(f.input), /uncertain/);
  assert.equal(f.stored.size, 1);
  assert.ok(!f.calls.includes("cleanup"));
  const replay = fixture({ receipt: { source_checksum: "a".repeat(64), result: f.result([PARSER_IMAGE]) } });
  assert.deepEqual((await importManuscriptImages(replay.input)).assetIds, [PARSER_IMAGE]);
  assert.deepEqual(replay.calls, []);
});

test("a concurrent winner's receipt retains its assets and removes this request's unused files", async () => {
  const f = fixture({ raced: true });
  assert.deepEqual((await importManuscriptImages(f.input)).assetIds, [PARSER_IMAGE]);
  assert.equal(f.stored.size, 0);
});

test("parser response boundary rejects oversized declarations and malformed JSON", async () => {
  assert.deepEqual(await readDocumentResponse(new Response('{"ok":true}', { headers: { "content-type": "application/json" } })), { ok: true });
  await assert.rejects(readDocumentResponse(new Response("{}", { headers: { "content-type": "application/json", "content-length": String(81 * 1024 * 1024) } })));
  await assert.rejects(readDocumentResponse(new Response("not-json", { headers: { "content-type": "application/json" } })));
});

test("text-only import commits a zero-image receipt without scanner or storage writes", async () => {
  const f = fixture();
  const input: Parameters<typeof importManuscriptImages>[0] = { ...f.input, images: [],
    chapters: [{ title: "Text", nodes: [{ id: "p", type: "paragraph", text: "Text-only manuscript." }] }] };
  const result = await importManuscriptImages(input);
  assert.deepEqual(f.calls, ["commit"]); assert.deepEqual(result.assetIds, []);
  assert.equal(result.report.chapterCount, 1); assert.equal(result.report.imageCount, 0);
  assert.deepEqual(f.committed()!.p_images, []);
});

test("leased import completes through fenced RPC and aborts before any side effect", async () => {
  const f = fixture();
  const lease = { jobId: SOURCE, token: PARSER_IMAGE };
  await importManuscriptImages({ ...f.input, lease });
  assert.equal(f.commitName(), "complete_leased_manuscript_import");
  assert.equal(f.committed()!.p_job_id, lease.jobId);
  assert.equal(f.committed()!.p_lease_token, lease.token);
  assert.equal(f.committed()!.p_actor_id, undefined);
  const aborted = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(importManuscriptImages({ ...aborted.input, signal: controller.signal }), /abort/i);
  assert.deepEqual(aborted.calls, []);
});

test("oversized reports fail before scan/storage/commit rather than creating an unreadable receipt", async () => {
  for (const warnings of [["x".repeat(2001)], Array.from({ length: 101 }, (_, index) => `Warning ${index}`),
    Array.from({ length: 50 }, (_, index) => `${index}${"x".repeat(1900)}`)]) {
    const f = fixture(); await assert.rejects(importManuscriptImages({ ...f.input, warnings }), /validated limits/);
    assert.deepEqual(f.calls, []);
  }
});
