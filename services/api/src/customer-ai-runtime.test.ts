import { test } from "node:test";
import assert from "node:assert/strict";
import { customerAiRuntimePreparation } from "./lib/customer-ai-runtime.js";
import type { SupabaseFactory } from "./lib/supabase.js";

const factory = (() => { throw new Error("unexpected database access"); }) as SupabaseFactory;
const privateToken = "synthetic-private-token-value";
const enabled = { CUSTOMER_AI_PREPARATION_ENABLED: "true", CUSTOMER_AI_PRIVATE_SERVICE_URL: "https://private.example",
  CUSTOMER_AI_PRIVATE_SERVICE_TOKEN: privateToken, NODE_ENV: "production" };

test("customer preparation is opt-in and does no work while composing", () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("unexpected network access"); };
  assert.equal(customerAiRuntimePreparation({}, factory, fetcher), undefined);
  assert.equal(customerAiRuntimePreparation({ ...enabled, CUSTOMER_AI_PREPARATION_ENABLED: "false" }, factory, fetcher), undefined);
  const preparation = customerAiRuntimePreparation(enabled, factory, fetcher);
  assert.equal(typeof preparation?.prepare, "function");
  assert.equal(calls, 0);
});

test("rejects malformed activation and unsafe or incomplete service configuration without exposing input", () => {
  const bad = [
    { ...enabled, CUSTOMER_AI_PREPARATION_ENABLED: "TRUE" },
    { ...enabled, CUSTOMER_AI_PRIVATE_SERVICE_URL: undefined },
    { ...enabled, CUSTOMER_AI_PRIVATE_SERVICE_TOKEN: undefined },
    { ...enabled, CUSTOMER_AI_PRIVATE_SERVICE_TOKEN: "short" },
    { ...enabled, CUSTOMER_AI_PRIVATE_SERVICE_URL: "https://name:secret@example.com" },
    { ...enabled, CUSTOMER_AI_PRIVATE_SERVICE_URL: "https://private.example/path" },
    { ...enabled, CUSTOMER_AI_PRIVATE_SERVICE_URL: "http://private.example" },
    { ...enabled, CUSTOMER_AI_PRIVATE_SERVICE_URL: "http://127.0.0.1:8000" },
    { ...enabled, CUSTOMER_AI_ALLOW_LOOPBACK_HTTP: "true" },
    { ...enabled, CUSTOMER_AI_ALLOW_LOOPBACK_HTTP: "yes" },
  ];
  for (const config of bad) {
    assert.throws(() => customerAiRuntimePreparation(config, factory), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Customer AI preparation configuration is invalid.");
      assert.doesNotMatch(error.stack ?? "", /synthetic-private-token-value|name:secret/u);
      return true;
    });
  }
});

test("loopback HTTP requires explicit opt-in and a development or test environment", () => {
  for (const NODE_ENV of ["development", "test"]) {
    assert.equal(typeof customerAiRuntimePreparation({ ...enabled, NODE_ENV,
      CUSTOMER_AI_PRIVATE_SERVICE_URL: "http://127.0.0.1:8000", CUSTOMER_AI_ALLOW_LOOPBACK_HTTP: "true" }, factory)?.prepare, "function");
  }
  assert.throws(() => customerAiRuntimePreparation({ ...enabled, NODE_ENV: "test",
    CUSTOMER_AI_PRIVATE_SERVICE_URL: "http://private.example", CUSTOMER_AI_ALLOW_LOOPBACK_HTTP: "true" }, factory));
});
