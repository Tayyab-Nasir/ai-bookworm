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

test("edition creation forwards an expected actor without replacing it with the current session", async () => {
  const seen: string[] = [];
  globalThis.fetch = async (_url, init) => { seen.push(new Headers(init?.headers).get("x-bookworm-actor") ?? ""); return Response.json({ id: "fixture" }); };
  const client = createClient({ baseUrl: "/api/backend", idempotencyKey: () => "fixture-key" });
  const actor = "a0000000-0000-4000-8000-000000000001";
  await client.createEdition("b0000000-0000-4000-8000-000000000002", { config: { kind: "ebook" } }, actor);
  await client.createEdition("b0000000-0000-4000-8000-000000000002", { config: { kind: "ebook" } });
  assert.deepEqual(seen, [actor, ""]);
});

test("edition reads and updates carry the original actor when requested", async () => {
  const seen: string[] = []; globalThis.fetch = async (_url, init) => { seen.push(new Headers(init?.headers).get("x-bookworm-actor") ?? ""); return Response.json({ editions: [] }); };
  const client = createClient({ baseUrl: "/api/backend" }), actor = "a0000000-0000-4000-8000-000000000001", id = "b0000000-0000-4000-8000-000000000002";
  await client.listEditions(id, actor); await client.updateEdition(id, { expectedUpdatedAt: "2026-01-01T00:00:00.000Z", status: "draft" }, actor);
  await client.listEditions(id); await client.updateEdition(id, { expectedUpdatedAt: "2026-01-01T00:00:00.000Z", status: "draft" });
  assert.deepEqual(seen, [actor, actor, "", ""]);
});
