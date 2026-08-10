import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEnv, resetEnvCache } from "./index.ts";

const valid = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  REDIS_URL: "redis://localhost:6379",
  QDRANT_URL: "http://localhost:6333",
};

describe("loadEnv", () => {
  it("parses valid env with defaults", () => {
    resetEnvCache();
    const env = loadEnv(valid);
    assert.equal(env.API_PORT, 3001);
    assert.equal(env.NODE_ENV, "development");
    assert.equal(env.DEFAULT_AI_PROVIDER, "anthropic");
  });

  it("throws on missing required var", () => {
    resetEnvCache();
    assert.throws(() => loadEnv({}), /Invalid environment configuration/);
  });

  it("throws on invalid URL", () => {
    resetEnvCache();
    assert.throws(() => loadEnv({ ...valid, SUPABASE_URL: "not-a-url" }));
  });
});
