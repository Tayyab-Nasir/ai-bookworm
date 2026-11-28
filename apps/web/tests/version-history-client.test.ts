import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@bookworm/api-client";
test("historical version read is an encoded, same-origin GET without a mutation body", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ version: { id: "saved" }, document: { chapterId: "chapter", version: 1, nodes: [] } });
  };
  try {
    await createClient({ baseUrl: "/api/backend" }).getDocumentVersion("chapter/one", "saved?two");
    assert.equal(calls[0].url, "/api/backend/v1/chapters/chapter%2Fone/versions/saved%3Ftwo");
    assert.equal(calls[0].init?.method, "GET");
    assert.equal(calls[0].init?.body, undefined);
    assert.equal(calls[0].init?.credentials, "same-origin");
  } finally { globalThis.fetch = original; }
});
