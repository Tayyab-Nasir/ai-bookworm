import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatedImageCost, imageCostEstimateBasis, imageTokenEvidence, imageReconciliationStatus, imageUsageMeasurementStatus, openAiImageGenerator } from "./lib/image-generation.js";

test("raw unsupported or cached usage cannot be laundered through the evidence projection", () => {
  const raw = { input_tokens: 30, output_tokens: 20, total_tokens: 50,
    input_tokens_details: { text_tokens: 10, image_tokens: 20 },
    output_tokens_details: { text_tokens: 0, image_tokens: 20 } };
  assert.equal(imageReconciliationStatus(raw), "supported");
  for (const unsupported of [undefined, {}, { ...raw, cached_tokens: 0 },
    { ...raw, input_tokens_details: { ...raw.input_tokens_details, cached_tokens: 10 } },
    { ...raw, output_tokens_details: { ...raw.output_tokens_details, audio_tokens: 0 } },
    { ...raw, total_tokens: 49 }, { ...raw, output_tokens: "20" }]) {
    assert.equal(imageReconciliationStatus(unsupported), "requires_review");
  }
  const cached = { ...raw, input_tokens_details: { ...raw.input_tokens_details, cached_tokens: 10 } };
  assert.deepEqual(imageTokenEvidence(cached), raw);
  assert.equal(imageReconciliationStatus(cached), "requires_review");
});

test("image receipts preserve only valid measured counters without inventing missing modalities", () => {
  const evidence = { input_tokens: 300, output_tokens: 1000, total_tokens: 1300,
    input_tokens_details: { text_tokens: 100, image_tokens: 200 },
    output_tokens_details: { text_tokens: 0, image_tokens: 1000 } };
  assert.deepEqual(imageTokenEvidence({ ...evidence, prompt: "private", secret: "never save" }), evidence);
  assert.deepEqual(imageTokenEvidence({ input_tokens: 0, output_tokens: -1,
    total_tokens: Number.MAX_SAFE_INTEGER + 1, input_tokens_details: { text_tokens: "1", image_tokens: 4, secret: "private" } }),
    { input_tokens: 0, input_tokens_details: { image_tokens: 4 } });
  for (const value of [undefined, null, [], {}, "100", { input_tokens: NaN }]) {
    assert.equal(imageTokenEvidence(value), undefined);
  }
  assert.deepEqual(imageTokenEvidence({ input_tokens: 1, input_tokens_details: { text_tokens: 2 } }),
    { input_tokens: 1, input_tokens_details: { text_tokens: 2 } });
});

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
  assert.equal(estimatedImageCost("gpt-image-2.5-sunburst", {
    input_tokens: 300, input_tokens_details: { text_tokens: 400, image_tokens: 20 }, output_tokens: 1_000,
  }), 0.0324);
  assert.equal(estimatedImageCost("gpt-image-2.5-sunburst", {
    input_tokens: 300, input_tokens_details: { text_tokens: 100, image_tokens: 250 }, output_tokens: 1_000,
  }), 0.0324);
  assert.equal(estimatedImageCost("gpt-image-2.5-sunburst", { input_tokens: -5, output_tokens: Number.NaN }), 0);
  assert.equal(estimatedImageCost("fixture-model", { input_tokens: 100, output_tokens: 100 }), 0);
  assert.equal(imageCostEstimateBasis("gpt-image-2.5-sunburst", {
    input_tokens: 300, input_tokens_details: { text_tokens: 100, image_tokens: 200 }, output_tokens: 1_000,
  }), "itemized");
  assert.equal(imageCostEstimateBasis("gpt-image-2.5-sunburst", {
    input_tokens: 300, input_tokens_details: { text_tokens: 100, image_tokens: 250 }, output_tokens: 1_000,
  }), "conservative_input");
  assert.equal(imageCostEstimateBasis("gpt-image-2.5-sunburst", { input_tokens: 300, output_tokens: 1_000 }), "conservative_input");
  assert.equal(imageCostEstimateBasis("gpt-image-2.5-sunburst", { input_tokens: 300 }), "unavailable");
  assert.equal(imageCostEstimateBasis("fixture-model", { input_tokens: 300, output_tokens: 1_000 }), "unavailable");
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
      const body = await request.json() as { prompt?: unknown; model?: unknown }; assert.equal(body.prompt, "Same character in a new scene");
      assert.equal(body.model, "fixture-pinned-image");
    }
    return Response.json({ data: [{ b64_json: png.toString("base64") }],
      ...(request.url.endsWith("/generations") ? { usage: { input_tokens: 300, output_tokens: 1_000,
        input_tokens_details: { text_tokens: 100, image_tokens: 200 } } } : {}) });
  };
  try {
    const input = { prompt: "Same character in a new scene", size: "1024x1024" as const, quality: "low" as const };
    const edited = await openAiImageGenerator({ ...input, referenceImages: [{ bytes: png, mimeType: "image/png" }] });
    const created = await openAiImageGenerator({ ...input, model: "fixture-pinned-image" });
    assert.deepEqual(paths, ["/v1/images/edits", "/v1/images/generations"]);
    assert.equal(edited.usage.measurementStatus, "unavailable");
    assert.equal(edited.usage.costEstimateBasis, "unavailable");
    assert.equal(created.usage.measurementStatus, "complete");
    assert.equal(created.model, "fixture-pinned-image");
    assert.equal(created.usage.costEstimateBasis, "unavailable");
    assert.equal(created.usage.estimatedCostUsd, 0);
    assert.deepEqual(created.usage.providerTokenUsage, { input_tokens: 300, output_tokens: 1000,
      input_tokens_details: { text_tokens: 100, image_tokens: 200 } });
    assert.equal(edited.usage.providerTokenUsage, undefined);
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
