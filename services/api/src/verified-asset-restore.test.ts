import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assetRestoreFetch, verifyAssetRestoreBytes } from "./lib/verified-asset-restore.js";

const bytes = Buffer.from("synthetic private restored file");
const sha = createHash("sha256").update(bytes).digest("hex");
const download = async () => ({ data: new Blob([bytes]), error: null });

test("only exact stored file bytes pass restoration verification", async () => {
  await verifyAssetRestoreBytes(download, bytes.length, sha);
  await assert.rejects(verifyAssetRestoreBytes(download, bytes.length + 1, sha), /missing or its contents changed/);
  await assert.rejects(verifyAssetRestoreBytes(download, bytes.length, "b".repeat(64)), /missing or its contents changed/);
  await assert.rejects(verifyAssetRestoreBytes(async () => ({ data: null, error: null }), bytes.length, sha), /missing or its contents changed/);
});

test("concurrent byte verification is refused and admission is released on failure", async () => {
  let finish!: () => void;
  const pending = verifyAssetRestoreBytes(async () => { await new Promise<void>(resolve => { finish = resolve; }); return download(); }, bytes.length, sha);
  await assert.rejects(verifyAssetRestoreBytes(download, bytes.length, sha), /busy/);
  finish(); await pending;
  await assert.rejects(verifyAssetRestoreBytes(async () => { throw new Error("storage unavailable"); }, bytes.length, sha));
  await verifyAssetRestoreBytes(download, bytes.length, sha);
});

test("restore transport bounds streamed responses and refuses redirects", async () => {
  let redirects: string | undefined;
  const synthetic: typeof fetch = async (_input, init) => {
    redirects = init?.redirect;
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < 257; i++) controller.enqueue(new Uint8Array(65536));
      controller.close();
    } }));
  };
  const response = await assetRestoreFetch(new AbortController().signal, synthetic)("https://example.invalid/rest/v1/test");
  await assert.rejects(response.arrayBuffer(), /exceeds limit/);
  assert.equal(redirects, "error");
});

test("aborting stalled storage reads fails closed", async () => {
  const controller = new AbortController();
  const upstream: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } }));
  const response = await assetRestoreFetch(controller.signal, upstream)("https://example.invalid/storage/v1/object/book-assets/file");
  const pending = response.arrayBuffer();
  controller.abort(new Error("synthetic deadline"));
  await assert.rejects(pending, /synthetic deadline|aborted/i);
});
