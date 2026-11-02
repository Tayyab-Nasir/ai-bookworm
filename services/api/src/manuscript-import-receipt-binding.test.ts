import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { importManuscriptImages } from "./lib/manuscript-images.js";

const id = (n: string) => `a5000000-0000-4000-8000-${n.padStart(12, "0")}`;
const book = id("1"), actor = id("2"), workspace = id("3"), source = id("4"), image = id("5"), chapter = id("6");
const sourceChecksum = "a".repeat(64);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

type Mode = "match" | "wrong-response" | "receipt-unavailable" | "receipt-absent" | "definite-sql-error" | "concurrent-receipt" | "pre-dispatch" | "post-dispatch-abort";
function harness(mode: Mode) {
  const objects = new Map<string, Buffer>(), removed: string[][] = [];
  let receipt: unknown = null, reads = 0, rpcCalls = 0;
  const controller = new AbortController();
  const service = {
    from(table: string) {
      assert.equal(table, "book_import_receipts");
      const query = { select: () => query, eq: () => query, maybeSingle: async () => {
        reads++;
        if (reads > 1 && mode === "receipt-unavailable") return { data: null, error: { message: "offline" } };
        if (reads > 1 && mode === "receipt-absent") return { data: null, error: null };
        return { data: receipt, error: null };
      } };
      return query;
    },
    storage: { from: () => ({
      upload: async (path: string, bytes: Buffer) => { objects.set(path, bytes); return { error: null }; },
      download: async (path: string) => ({ data: new Blob([Uint8Array.from(mode === "pre-dispatch" ? Buffer.from("bad") : objects.get(path)!)]), error: null }),
      remove: async (paths: string[]) => { removed.push(paths); for (const path of paths) objects.delete(path); return { error: null }; },
    }) },
    rpc: async (_name: string, args: Record<string, any>) => {
      rpcCalls++;
      const assetIds = (args.p_images as Array<{id:string}>).map(x => x.id);
      const result = { chapters: [{ id: chapter, title: "Opening" }], sourceAssetId: source, assetIds, report: args.p_report };
      const prior = { ...result, assetIds: [id("99")] };
      receipt = { source_checksum: sourceChecksum, result: mode === "concurrent-receipt" ? prior : result };
      if (mode === "post-dispatch-abort") controller.abort();
      if (mode === "definite-sql-error") return { data: null, error: { code: "22023" } };
      return { data: mode === "wrong-response" ? { ...result, assetIds: [] } : mode === "concurrent-receipt" ? prior : result, error: null };
    },
  };
  const input = { service: service as never, scanner: { name: "fixture", scan: async () => ({ verdict: "clean" as const, signature: "v1" }) },
    actorId: actor, bookId: book, workspaceId: workspace, sourceAssetId: source, sourceChecksum,
    chapters: [{ title: "Opening", nodes: [{ id: "text", type: "paragraph" as const, text: "Text" }, { id: "art", type: "image" as const, assetId: image }] }],
    images: [{ id: image, filename: "art.png", mimeType: "image/png" as const, sizeBytes: png.length, checksumSha256: createHash("sha256").update(png).digest("hex"), contentBase64: png.toString("base64") }], warnings: [], signal: controller.signal };
  return { input, objects, removed, rpcCalls: () => rpcCalls, reads: () => reads };
}

for (const mode of ["wrong-response", "receipt-unavailable", "receipt-absent", "definite-sql-error"] as const) test(`${mode} never deletes bytes after commit dispatch`, async () => {
  const h = harness(mode);
  await assert.rejects(importManuscriptImages(h.input));
  assert.equal(h.rpcCalls(), 1);
  assert.equal(h.removed.length, 0);
  assert.equal(h.objects.size, 1);
});

test("matching committed receipt is checked and imported file retained", async () => {
  const h = harness("match"); const result = await importManuscriptImages(h.input);
  assert.equal(h.reads(), 2); assert.equal(result.assetIds.length, 1); assert.equal(h.objects.size, 1); assert.equal(h.removed.length, 0);
});

test("a competing receipt never authorizes deletion of this attempt's uploaded bytes", async () => {
  const h = harness("concurrent-receipt"); const result = await importManuscriptImages(h.input);
  assert.equal(result.assetIds[0], id("99")); assert.equal(h.objects.size, 1); assert.equal(h.removed.length, 0);
});

test("failed pre-dispatch verification cleans only newly uploaded bytes", async () => {
  const h = harness("pre-dispatch"); await assert.rejects(importManuscriptImages(h.input));
  assert.equal(h.rpcCalls(), 0); assert.equal(h.objects.size, 0); assert.equal(h.removed.length, 1);
});

test("abort after commit keeps the referenced image and accepts the durable receipt", async () => {
  const h = harness("post-dispatch-abort"); const result = await importManuscriptImages(h.input);
  assert.equal(h.input.signal.aborted, true); assert.equal(result.assetIds.length, 1);
  assert.equal(h.objects.size, 1); assert.equal(h.removed.length, 0); assert.equal(h.reads(), 2);
});