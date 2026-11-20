import assert from "node:assert/strict";
import { test } from "node:test";
import { sendOnePublicationEmail } from "./lib/publication-email.js";

const dispatch = {
  package_job_id: "11111111-1111-4111-8111-111111111111",
  dispatch_id: "22222222-2222-4222-8222-222222222222",
  recipient_email: "author@example.test",
};
const config = { apiKey: "fixture-key", from: "sender@example.test" };

for (const [name, status, response] of [
  ["accepted", "accepted", () => Response.json({ id: "synthetic-email" })],
  ["rejected", "rejected", () => new Response(null, { status: 422 })],
  ["lost reply", "unconfirmed", () => { throw new Error("synthetic timeout"); }],
  ["conflict", "unconfirmed", () => new Response(null, { status: 409 })],
  ["bad receipt", "unconfirmed", () => Response.json({ id: "a".repeat(16_385) })],
] as const) test(`publication email records ${name} against the original claim`, async () => {
  const calls: unknown[] = [];
  let queued = true;
  const db = {
    rpc: async (name: string, args: unknown) => {
      calls.push([name, args]);
      if (name === "claim_managed_publication_notification") {
        const data = queued ? [dispatch] : [];
        queued = false;
        return { data, error: null };
      }
      return { data: true, error: null };
    },
  } as never;
  const send: typeof fetch = async (url, input) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(input?.redirect, "error");
    assert.equal(new Headers(input?.headers).get("idempotency-key"), "bookworm/publication/" + dispatch.dispatch_id);
    const body = JSON.parse(String(input?.body));
    assert.deepEqual(body.to, [dispatch.recipient_email]);
    assert.ok(!JSON.stringify(body).includes(dispatch.package_job_id));
    return response();
  };
  assert.equal(await sendOnePublicationEmail(db, config, send), status);
  assert.equal(await sendOnePublicationEmail(db, config, () => { throw new Error("unexpected second email"); }), "idle");
  assert.deepEqual(calls[1], ["settle_managed_publication_notification", {
    p_job_id: dispatch.package_job_id, p_dispatch_id: dispatch.dispatch_id, p_status: status,
    p_receipt: status === "accepted" ? "synthetic-email" : null,
  }]);
});
