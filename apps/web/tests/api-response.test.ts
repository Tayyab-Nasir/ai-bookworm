import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ApiClientError, createClient } from "@bookworm/api-client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("a malformed successful response is an error, never a saved result", async () => {
  for (const response of [
    new Response("private-upstream-html", { status: 200, headers: { "content-type": "text/html" } }),
    new Response("{broken", { status: 200, headers: { "content-type": "application/json" } }),
    Response.json(null),
    Response.json("private-upstream-detail"),
  ]) {
    globalThis.fetch = async () => response;
    await assert.rejects(createClient({ baseUrl: "/api/backend" }).listWorkspaces(), (error: unknown) => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "invalid_response");
      assert.equal(error.message, "The service returned an unreadable response.");
      assert.ok(!error.message.includes("private-upstream"));
      return true;
    });
  }
});

test("an unreadable failed response preserves the HTTP failure without exposing its body", async () => {
  globalThis.fetch = async () => new Response("private-upstream-detail", { status: 503 });
  await assert.rejects(createClient({ baseUrl: "/api/backend" }).listWorkspaces(), (error: unknown) => {
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "invalid_response");
    assert.ok(!error.message.includes("private-upstream-detail"));
    return true;
  });
});

test("private JSON dependency errors remain structured and bodyless actions still work", async () => {
  globalThis.fetch = async () => Response.json({ error: { code: "dependency_unavailable", message: "Workspace service unavailable.", requestId: "fixture-request" } }, { status: 503 });
  await assert.rejects(createClient({ baseUrl: "/api/backend" }).listWorkspaces(), (error: unknown) => {
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "dependency_unavailable");
    assert.equal(error.requestId, "fixture-request");
    return true;
  });
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.deepEqual(await createClient({ baseUrl: "/api/backend" }).listWorkspaces(), {});
});
