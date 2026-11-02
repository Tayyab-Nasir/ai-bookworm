import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedServiceText } from "./lib/bounded-service-response.js";

test("service response limit counts streamed bytes and cancels oversized bodies", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(boundedServiceText(new Response(stream, { headers: { "content-length": "1" } }), 5, "too large"), /too large/);
  assert.equal(cancelled, true);
});

test("service response rejects oversized declared bodies and preserves valid UTF-8", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await assert.rejects(boundedServiceText(new Response(stream, { headers: { "content-length": "99" } }), 4, "too large"), /too large/);
  assert.equal(cancelled, true);
  assert.equal(await boundedServiceText(new Response("éx"), 3, "too large"), "éx");
  await assert.rejects(boundedServiceText(new Response("éx"), 2, "too large"), /too large/);
});

test("oversized responses fail promptly even if stream cancellation never settles", async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(4)); },
    cancel() { return new Promise<void>(() => {}); },
  });
  const result = await Promise.race([
    boundedServiceText(new Response(stream), 3, "too large").then(() => "unexpected", () => "rejected"),
    new Promise(resolve => setTimeout(() => resolve("timeout"), 250)),
  ]);
  assert.equal(result, "rejected");
});
