import assert from "node:assert/strict";
import test from "node:test";
import { checkOpenAIModels } from "../scripts/check-openai-models.mjs";

const apiKey = "test-only-key";
const text = "gpt-6.2-astra";
const image = "gpt-image-2.6-sunburst";

test("model inventory uses one fixed GET and reports only required models", async () => {
  let calls = 0;
  const fetchModels = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer test-only-key");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ object: "list", data: [{ id: text }, { id: "unrelated-model" }] });
  };
  assert.deepEqual(await checkOpenAIModels({ apiKey, models: [text, image, image], fetchModels }),
    { status: "models_missing", missing: [image] });
  assert.equal(calls, 1);
  assert.deepEqual(await checkOpenAIModels({ apiKey, models: [text], fetchModels }), { status: "models_visible" });
  assert.equal(calls, 2);
});

test("missing keys and invalid model arguments make no requests", async () => {
  const fetchModels = () => assert.fail("unexpected inventory request");
  assert.deepEqual(await checkOpenAIModels({ models: [text], fetchModels }), { status: "missing_api_key" });
  assert.deepEqual(await checkOpenAIModels({ apiKey, models: [], fetchModels }), { status: "invalid_model_arguments" });
  assert.deepEqual(await checkOpenAIModels({ apiKey, models: ["sk-proj-test"], fetchModels }),
    { status: "invalid_model_arguments" });
});

test("the report redacts provider errors and rejects invalid inventory responses", async () => {
  const check = fetchModels => checkOpenAIModels({ apiKey, models: [text], fetchModels });
  assert.deepEqual(await check(() => Response.json({ error: { code: "expired_secret_key", message: apiKey } }, { status: 401 })),
    { status: "expired_api_key", httpStatus: 401 });
  assert.deepEqual(await check(() => new Response(apiKey, { status: 429 })),
    { status: "inventory_request_failed", httpStatus: 429 });
  assert.deepEqual(await check(() => Response.json({ object: "list", data: [{ name: text }] })),
    { status: "invalid_inventory_response" });
  assert.deepEqual(await check(() => { throw new Error(apiKey); }), { status: "inventory_unreachable" });
});
