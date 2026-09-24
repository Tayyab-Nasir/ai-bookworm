import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatedImageCost, imageUsageMeasurementStatus, openAiImageGenerator } from "./lib/image-generation.js";

test("image usage provenance distinguishes missing and partial provider telemetry", () => {
  assert.equal(imageUsageMeasurementStatus(undefined), "unavailable");
  assert.equal(imageUsageMeasurementStatus({}), "unavailable");
  assert.equal(imageUsageMeasurementStatus({ input_tokens: 12 }), "partial");
  assert.equal(imageUsageMeasurementStatus({ input_tokens: 12, output_tokens: 34 }), "complete");
  assert.equal(imageUsageMeasurementStatus({ input_tokens: -1, output_tokens: 34 }), "partial");
});

test("current OpenAI image pricing distinguishes text, image input and output tokens", () => {
  assert.equal(estimatedImageCost("gpt-image-2.5-sunburst", {
    input_tokens: 300,
    input_tokens_details: { text_tokens: 100, image_tokens: 200 },
    output_tokens: 1_000,
  }), 0.0321);
  assert.equal(estimatedImageCost("gpt-image-2.5-flare", {
    input_tokens: 300, input_tokens_details: { text_tokens: 100 }, output_tokens: 1_000,
  }), 0.0321);
  assert.equal(estimatedImageCost("gpt-image-2", {
    input_tokens: 300, input_tokens_details: { text_tokens: 100, image_tokens: 200 }, output_tokens: 1_000,
  }), 0.01605);
  assert.equal(estimatedImageCost("gpt-image-2.5-sunburst", {
    input_tokens: 300, input_tokens_details: { text_tokens: 100, image_tokens: 100 }, output_tokens: 1_000,
  }), 0.0321);
  assert.equal(estimatedImageCost("gpt-image-2.5-sunburst", { input_tokens: 300, output_tokens: 1_000 }), 0.0324);
  assert.equal(estimatedImageCost("gpt-image-2.5-sunburst", { input_tokens: -5, output_tokens: Number.NaN }), 0);
  assert.equal(estimatedImageCost("fixture-model", { input_tokens: 100, output_tokens: 100 }), 0);
});

test("image adapter submits reference bytes as multipart edits and unconditioned requests as generations", async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENAI_API_KEY;
  const oldModel = process.env.OPENAI_IMAGE_MODEL;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const paths: string[] = [];
  process.env.OPENAI_API_KEY = "fixture-no-network";
  process.env.OPENAI_IMAGE_MODEL = "gpt-image-2.5-sunburst";
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    // SDK probes native FormData support with a local data URL.
    if (new URL(request.url).protocol === "data:") return new Response("");
    paths.push(new URL(request.url).pathname);
    if (request.url.endsWith("/edits")) {
      const body = await request.formData();
      const files = [...body.values()].filter(value => typeof value !== "string");
      assert.equal(files.length, 1);
      assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), png);
      assert.equal(body.get("prompt"), "Same character in a new scene");
    } else {
      const body = await request.json() as { prompt?: unknown }; assert.equal(body.prompt, "Same character in a new scene");
    }
    return Response.json({ data: [{ b64_json: png.toString("base64") }],
      ...(request.url.endsWith("/generations") ? { usage: { input_tokens: 300, output_tokens: 1_000,
        input_tokens_details: { text_tokens: 100, image_tokens: 200 } } } : {}) });
  };
  try {
    const input = { prompt: "Same character in a new scene", size: "1024x1024" as const, quality: "low" as const };
    const edited = await openAiImageGenerator({ ...input, referenceImages: [{ bytes: png, mimeType: "image/png" }] });
    const created = await openAiImageGenerator(input);
    assert.deepEqual(paths, ["/v1/images/edits", "/v1/images/generations"]);
    assert.equal(edited.usage.measurementStatus, "unavailable");
    assert.equal(created.usage.measurementStatus, "complete");
    assert.equal(created.usage.estimatedCostUsd, 0.0321);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.OPENAI_IMAGE_MODEL; else process.env.OPENAI_IMAGE_MODEL = oldModel;
  }
});

test("image adapter does not silently retry an ambiguous provider response", async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENAI_API_KEY;
  let calls = 0;
  process.env.OPENAI_API_KEY = "fixture-no-network";
  globalThis.fetch = async input => {
    if (new URL(String(input)).protocol === "data:") return new Response("");
    calls++;
    return Response.json({ error: { message: "temporarily unavailable", type: "server_error" } }, { status: 503 });
  };
  try {
    await assert.rejects(openAiImageGenerator({ prompt: "Forest scene", size: "1024x1024", quality: "low" }));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});
