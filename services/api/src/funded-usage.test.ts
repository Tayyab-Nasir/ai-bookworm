import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteUsage } from "./lib/usage-pricing.js";
import { reservePricedUsage, settlePricedUsage, claimPricedDispatch } from "./lib/funded-usage.js";
import type { SupabaseClient } from "./lib/supabase.js";

const scope = { jobId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", userId: "33333333-3333-4333-8333-333333333333", inputSha256: "a".repeat(64) };
const now = "2026-09-19T00:00:00Z";
const quote = () => quoteUsage({ scope,
  price: { provider: "openai", model: "synthetic", version: "test-v1", rates: [{ dimension: "text_output", microUsdPerMillionTokens: "1000000" }] },
  policy: { approved: true, version: "test-v1", microUsdPerCredit: "1000", minimumCredits: "1", platformMicroUsd: "0", markupBasisPoints: 10000 },
  maximumTokens: [{ dimension: "text_output", tokens: "3000" }], createdAt: now, expiresAt: "2026-09-19T00:15:00Z",
});
const receipt = () => ({ scope, provider: "openai" as const, model: "synthetic", requestId: "req-test", measurement: "measured" as const, tokens: [{ dimension: "text_output" as const, tokens: "1000" }] });
function fixture() {
  const state = { row: null as Record<string, unknown> | null, calls: [] as { name: string; args: Record<string, unknown> }[], fail: false };
  const client = {
    from: (table: string) => { assert.equal(table, "funded_usage_quotes"); return { select: () => ({ eq: (_: string, id: string) => ({ maybeSingle: async () => ({ data: state.row?.job_id === id ? structuredClone(state.row) : null, error: null }) }) }) }; },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.calls.push({ name, args });
      if (state.fail) return { data: null, error: { code: "connection_failure", message: "private connection detail" } };
      if (name === "reserve_funded_usage_quote") {
        const q = args.p_quote as ReturnType<typeof quote>;
        state.row = { job_id: scope.jobId, user_id: scope.userId, workspace_id: scope.workspaceId,
          quote_json: structuredClone(q), reserved_credits: Number(q.reservedCredits), status: "held", settlement_json: null };
      } else {
        assert.equal(name, "settle_funded_usage_quote");
        const s = args.p_settlement as { status: string };
        state.row = { ...state.row, status: s.status === "settle" ? "settled" : "requires_review", settlement_json: structuredClone(s) };
      }
      return { data: structuredClone(state.row), error: null };
    },
  } as unknown as SupabaseClient;
  return { state, client };
}
test("funded adapter persists canonical quote and settles from saved rates once", async () => {
  const { state, client } = fixture(); const q = quote();
  await reservePricedUsage(client, q, now);
  await reservePricedUsage(client, q, "2026-09-20T00:00:00Z");
  assert.equal(state.calls.length, 1); // late recovery, not a dispatch permission
  const settled = await settlePricedUsage(client, scope.jobId, receipt());
  assert.equal(settled.status, "settled");
  const result = state.calls[1].args.p_settlement as { debitCredits: string; releaseCredits: string };
  assert.equal(result.debitCredits, "1"); assert.equal(result.releaseCredits, "2");
  assert.deepEqual(await settlePricedUsage(client, scope.jobId, receipt()), settled);
  assert.equal(state.calls.length, 2);
});
test("adapter rejects tampered quotes, stale new quotes and wrong receipt scope before write", async () => {
  const { state, client } = fixture();
  await assert.rejects(() => reservePricedUsage(client, { ...quote(), reservedCredits: "1" }, now), /invalid saved/);
  await assert.rejects(() => reservePricedUsage(client, quote(), "2026-09-20T00:00:00Z"), /not valid/);
  assert.equal(state.calls.length, 0);
  await reservePricedUsage(client, quote(), now);
  await assert.rejects(() => settlePricedUsage(client, scope.jobId, { ...receipt(), model: "other" }), /does not match/);
  await assert.rejects(() => settlePricedUsage(client, scope.jobId, { ...receipt(), measurement: "estimated" }), /estimated/);
  assert.equal(state.calls.length, 1);
});
test("over-limit receipt saves review hold; changed settlement cannot release it", async () => {
  const { state, client } = fixture(); await reservePricedUsage(client, quote(), now);
  const large = { ...receipt(), tokens: [{ dimension: "text_output" as const, tokens: "3001" }] };
  assert.equal((await settlePricedUsage(client, scope.jobId, large)).status, "requires_review");
  assert.ok(!("releaseCredits" in (state.calls[1].args.p_settlement as object)));
  await assert.rejects(() => settlePricedUsage(client, scope.jobId, receipt()), /conflict/);
  assert.equal(state.calls.length, 2);
});
test("database failures preserve pending state and hide connection details", async () => {
  const { state, client } = fixture(); await reservePricedUsage(client, quote(), now); state.fail = true;
  await assert.rejects(() => settlePricedUsage(client, scope.jobId, receipt()), /usage quote storage unavailable/);
  assert.equal(state.row?.status, "held"); assert.equal(state.row?.settlement_json, null);
  state.fail = false; assert.equal((await settlePricedUsage(client, scope.jobId, receipt())).status, "settled");
});
test("missing and mismatched saved rows cannot settle", async () => {
  const { state, client } = fixture();
  await assert.rejects(() => settlePricedUsage(client, scope.jobId, receipt()), /no funded quote/);
  await reservePricedUsage(client, quote(), now);
  state.row!.reserved_credits = 10;
  await assert.rejects(() => settlePricedUsage(client, scope.jobId, receipt()), /identity mismatch/);
  assert.equal(state.calls.length, 1);
});

test("dispatch accepts only affirmative database authorization and never treats replay as permission", async () => {
  const input = { jobId: scope.jobId, leaseToken: scope.userId, inputSha256: scope.inputSha256, model: "synthetic" };
  for (const data of [false, null, {}, "true"]) {
    const client = { rpc: async () => ({ data, error: null }) } as unknown as SupabaseClient;
    await assert.rejects(() => claimPricedDispatch(client, input));
  }
  const client = { rpc: async (name: string, args: Record<string, unknown>) => {
    assert.equal(name, "claim_funded_dispatch"); assert.equal(args.p_lease_token, input.leaseToken);
    return { data: true, error: null };
  } } as unknown as SupabaseClient;
  await claimPricedDispatch(client, input);
  const stale = { rpc: async () => ({ data: null, error: { code: "40001" } }) } as unknown as SupabaseClient;
  await assert.rejects(() => claimPricedDispatch(stale, input), /lease lost/);
});
