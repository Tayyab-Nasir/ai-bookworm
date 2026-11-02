import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredStorageOrigin } from "../lib/auth/storage-origin";

test("only canonical HTTPS or loopback Storage origins are published", () => {
  assert.equal(configuredStorageOrigin("https://bookworm.supabase.co/"), "https://bookworm.supabase.co");
  assert.equal(configuredStorageOrigin("https://bookworm.supabase.co"), "https://bookworm.supabase.co");
  assert.equal(configuredStorageOrigin("http://127.0.0.1:54321"), "http://127.0.0.1:54321");
  for (const value of [undefined, "", "garbage", "http://remote.example", "https://user:secret@example.test",
    "https://example.test/path", "https://example.test/../", "https://example.test/?", "https://example.test/#",
    "https://example.test?key=secret", "https://example.test#fragment"]) {
    assert.equal(configuredStorageOrigin(value), null);
  }
});
