import assert from "node:assert/strict";
import { test } from "node:test";
import { metadataRequestCanRestart, metadataGenerationBlocked, persistPaidQuoteIntent, canAcceptMetadataQuote, requestMetadataQuoteResult, metadataCancellationMessage } from "../components/BookMemoryClient";

test("generation waits for saved status and unresolved jobs before allowing new spending", () => {
  assert.equal(metadataGenerationBlocked(null), true);
  assert.equal(metadataGenerationBlocked([{ id: "job", createdAt: "now", status: "running" }]), true);
  assert.equal(metadataGenerationBlocked([]), false);
});

test("paid counting requires durable same-key browser recovery before submission", () => {
  const intent = { idempotencyKey: "same-key", body: { chapterIds: ["saved-chapter"] } };
  const writes: { key: string; value: string }[] = [];
  persistPaidQuoteIntent({ setItem: (key, value) => { writes.push({ key, value }); }, removeItem: () => {} }, "recovery-key", intent);
  assert.deepEqual(writes, [{ key: "recovery-key", value: JSON.stringify(intent) }]);
  assert.throws(() => persistPaidQuoteIntent({ setItem: () => { throw new Error("blocked"); }, removeItem: () => {} }, "recovery-key", intent), /No paid quote request was sent/);
});

test("metadata approval rejects expired, unconfirmed or noninteger credit quotes", () => {
  const quote = { id: "quote", status: "ready" as const, model: "approved", reservedCredits: 31, expiresAt: "2030-01-01T00:00:00.000Z", acceptedJobId: null };
  const now = Date.parse("2029-01-01T00:00:00.000Z");
  assert.equal(canAcceptMetadataQuote(quote, true, now), true);
  assert.equal(canAcceptMetadataQuote(quote, false, now), false);
  assert.equal(canAcceptMetadataQuote({ ...quote, status: "accepted" }, true, now), false);
  assert.equal(canAcceptMetadataQuote({ ...quote, reservedCredits: 1.5 }, true, now), false);
  assert.equal(canAcceptMetadataQuote(quote, true, Date.parse("2031-01-01T00:00:00.000Z")), false);
});

test("lost metadata creation uses read-only key recovery and never silently counts again", async () => {
  const intent = { idempotencyKey: "original-key", body: { idempotencyKey: "original-key", modelId: "approved", chapterIds: ["chapter"], maxTokens: 12000, allowProviderTokenCounting: true as const } };
  const calls: unknown[] = [];
  const fetchRequest = async <T>(path: string, method?: string, body?: unknown): Promise<T> => {
    calls.push({ path, method, body }); return { request: { id: "saved-request", status: "ready" }, quote: null } as T;
  };
  await requestMetadataQuoteResult(fetchRequest, "/books/book", intent, true);
  await requestMetadataQuoteResult(fetchRequest, "/books/book", intent);
  await requestMetadataQuoteResult(fetchRequest, "/books/book", { ...intent, requestId: "saved-request" });
  assert.deepEqual(calls, [
    { path: "/books/book/metadata/quotes", method: "POST", body: intent.body },
    { path: "/books/book/metadata/quotes/recover", method: "POST", body: { idempotencyKey: "original-key" } },
    { path: "/books/book/metadata/quote-requests/saved-request", method: undefined, body: undefined },
  ]);
  let recoveryCalls = 0;
  await assert.rejects(requestMetadataQuoteResult(async () => { recoveryCalls++; throw Object.assign(new Error("not found"), { status: 404 }); }, "/books/book", intent), /not found/);
  assert.equal(recoveryCalls, 1, "missing recovery cannot fall back to a counting POST");
});

test("metadata retry preserves uncertain paid requests and permits definite corrections", () => {
  for (const error of [new Error("Network lost"), null, { status: 500 }, { status: 503 }, { status: 409, details: { status: "running" } }]) {
    assert.equal(metadataRequestCanRestart(error), false);
  }
  for (const error of [{ status: 422 }, { status: 403 }, { status: 409, details: { status: "failed" } }]) {
    assert.equal(metadataRequestCanRestart(error), true);
  }
});

test("verified pre-dispatch cancellation distinguishes released credits from provider uncertainty", () => {
  for (const status of ["failed", "cancelled"]) for (const errorCode of ["metadata_source_changed_before_dispatch", "metadata_request_mismatch_before_dispatch", "metadata_quote_expired_before_dispatch", "metadata_permission_revoked_before_dispatch"]) {
    assert.match(metadataCancellationMessage({ status, errorCode }) ?? "", /cancelled before provider dispatch and released the reserved credits/);
  }
  assert.equal(metadataCancellationMessage({ status: "running", errorCode: "metadata_quote_expired_before_dispatch" }), null);
  assert.equal(metadataCancellationMessage({ status: "failed", errorCode: "metadata_generation_requires_review" }), null);
});
