import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../../../packages/api-client/src/index";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const client = createClient({ baseUrl: "/api/backend", idempotencyKey: () => "test-operation" });

test("account support and data-rights calls bind the original actor and validate returned ownership", async () => {
  const savedFetch = globalThis.fetch; const calls: { method: string; actor: string | null; key: string | null }[] = [];
  let viewer = A, owner = A, badReceipt = false, wrongCancelId = false, wrongContent = false;
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers), method = init?.method ?? "GET";
    calls.push({ method, actor: headers.get("x-bookworm-actor"), key: headers.get("idempotency-key") });
    const support = String(url).includes("support/tickets");
    const input = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const record = { id: method === "DELETE" ? (wrongCancelId ? "different-id" : "test-id") : "synthetic", user_id: owner,
      status: badReceipt ? "wrong" : method === "DELETE" ? "cancelled" : support ? "open" : "submitted",
      request_type: input.type, reason: wrongContent ? "different reason" : input.reason?.trim() || null, category: input.category, subject: input.subject?.trim(), body: wrongContent ? "different body" : input.body?.trim() };
    const result = support ? method === "GET" ? { tickets: [record] } : { ticket: record } : method === "GET" ? { requests: [record] } : { request: record };
    return Response.json({ viewerId: viewer, ...result });
  };
  try {
    await client.listDataRequests(A); await client.listSupportTickets(A);
    await client.createDataRequest({ type: "export" }, A); await client.cancelDataRequest("test-id", A);
    await client.createSupportTicket({ category: "general", subject: "help", body: "a longer message" }, A);
    assert.equal(calls.length, 5); assert(calls.every(call => call.actor === A));
    assert.deepEqual(calls.filter(call => call.method === "POST").map(call => call.key), ["test-operation", "test-operation"]);
    await client.createSupportTicket({ category: "general", subject: "  help  ", body: "  a longer message  " }, A);
    await client.createDataRequest({ type: "export", reason: "  a private reason  " }, A);
    viewer = B; await assert.rejects(client.listDataRequests(A), /requested account/);
    viewer = A; owner = B; await assert.rejects(client.listSupportTickets(A), /requested account/);
    await assert.rejects(client.createDataRequest({ type: "export" }, A), /requested account/);
    owner = A; badReceipt = true;
    await assert.rejects(client.createDataRequest({ type: "export" }, A), /requested change/);
    await assert.rejects(client.cancelDataRequest("test-id", A), /requested change/);
    badReceipt = false; wrongCancelId = true;
    await assert.rejects(client.cancelDataRequest("test-id", A), /requested change/);
    wrongCancelId = false; wrongContent = true;
    await assert.rejects(client.createDataRequest({ type: "export", reason: "private reason" }, A), /requested change/);
    await assert.rejects(client.createSupportTicket({ category: "general", subject: "help", body: "a secret message" }, A), (error: Error) => /requested change/.test(error.message) && !error.message.includes("secret message"));
    wrongContent = false; badReceipt = true;
    await assert.rejects(client.createSupportTicket({ category: "general", subject: "help", body: "a longer message" }, A), /requested change/);
    await client.listDataRequests(); assert.equal(calls.at(-1)?.actor, null);
  } finally { globalThis.fetch = savedFetch; }
});
