import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatedImageCost, openAiImageGenerator } from "./lib/image-generation.js";

test("current OpenAI image pricing distinguishes text, image input and output tokens", () => {
  assert.equal(estimatedImageCost("gpt-image-2.5-sunburst", {
    input_tokens: 300,
    input_tokens_details: { text_tokens: 100, image_tokens: 200 },
    output_tokens: 1_000,
  }), 0.0321);
  assert.equal(estimatedImageCost("fixture-model", { input_tokens: 100, output_tokens: 100 }), 0);
});

test("image adapter submits reference bytes as multipart edits and unconditioned requests as generations", async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENAI_API_KEY;
  const oldModel = process.env.OPENAI_IMAGE_MODEL;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const paths: string[] = [];
  process.env.OPENAI_API_KEY = "fixture-no-network";
  process.env.OPENAI_IMAGE_MODEL = "fixture-model";
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
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  };
  try {
    const input = { prompt: "Same character in a new scene", size: "1024x1024" as const, quality: "low" as const };
    await openAiImageGenerator({ ...input, referenceImages: [{ bytes: png, mimeType: "image/png" }] });
    await openAiImageGenerator(input);
    assert.deepEqual(paths, ["/v1/images/edits", "/v1/images/generations"]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.OPENAI_IMAGE_MODEL; else process.env.OPENAI_IMAGE_MODEL = oldModel;
  }
});
