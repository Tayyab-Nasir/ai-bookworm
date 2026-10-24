import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readBrowserSession } from "../lib/browser-session";

const original = globalThis.fetch;
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
afterEach(() => { globalThis.fetch = original; });

test("session reads are bounded, same-origin, uncached, and expose only public identity", async () => {
  let request: RequestInit | undefined;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/auth/session"); request = init;
    return Response.json({ user: { id: A, email: "author@example.test", privateValue: "not-returned" }, access_token: "not-returned" });
  };
  assert.deepEqual(await readBrowserSession(A), { id: A, email: "author@example.test" });
  assert.equal(request?.cache, "no-store"); assert.equal(request?.credentials, "same-origin");
  assert(request?.signal instanceof AbortSignal); assert.equal(request.signal.aborted, false);
});

for (const status of [401, 403, 429, 503]) test(`session ${status} never leaks an upstream message`, async () => {
  globalThis.fetch = async () => Response.json({ error: "sensitive-provider-payload" }, { status });
  await assert.rejects(readBrowserSession(), { message: "Your session could not be verified. Sign in again or retry." });
});
for (const result of [null, [], {}, { user: null }, { user: { id: "not-an-id" } }, { user: { id: 1 } }]) {
  test(`malformed session identity is rejected: ${JSON.stringify(result)}`, async () => {
    globalThis.fetch = async () => Response.json(result);
    await assert.rejects(readBrowserSession(), /session could not be verified/);
  });
}
test("account crossover is refused and optional/oversized email is not fabricated", async () => {
  globalThis.fetch = async () => Response.json({ user: { id: B, email: "x".repeat(321) } });
  await assert.rejects(readBrowserSession(A), /account changed/);
  assert.deepEqual(await readBrowserSession(), { id: B, email: null });
});
test("transport and unreadable JSON failures are safe", async () => {
  globalThis.fetch = async () => { throw new Error("sensitive-transport-error"); };
  await assert.rejects(readBrowserSession(), /session could not be verified/);
  globalThis.fetch = async () => new Response("sensitive-non-json-body");
  await assert.rejects(readBrowserSession(), /session could not be verified/);
});
