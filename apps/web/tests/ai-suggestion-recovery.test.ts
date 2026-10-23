import assert from "node:assert/strict";
import { test } from "node:test";
import type { AiJobWithSuggestions } from "@bookworm/api-client";
import { readSuggestionDecision, recoverSuggestionDecision, suggestionDecisionKey, type SuggestionDecision } from "../lib/ai-suggestion-recovery";

const decision: SuggestionDecision = { schema: 1, userId: "author", bookId: "book", chapterId: "chapter", jobId: "job", suggestionId: "proposal", action: "apply", expectedVersion: 1 };
const job = (status: "pending" | "accepted" | "rejected" = "accepted"): AiJobWithSuggestions => ({ id: "job", book_id: "book", chapter_ids: ["chapter"],
  agent_type: "writer", status: "succeeded", model: "approved", usage_json: {}, context_source_count: 0,
  created_at: "2026-10-23T08:00:00Z", started_at: null, completed_at: null, error_code: null, error_message: null,
  suggestions: [{ id: "proposal", ai_job_id: "job", entity_type: "chapter", entity_id: "chapter", status, operation_json: { expectedVersion: 1 },
    reviewed_by: "author", rationale: "Proposed edit", confidence: null, created_at: "2026-10-23T08:00:00Z", reviewed_at: null }] });
const receipt = () => ({ status: "saved" as const, operationId: "ai-suggestion:proposal", versionId: "version-2", document: { chapterId: "chapter", version: 2, nodes: [] } });
const current = async () => ({ chapter: { id: "chapter", book_id: "book", title: "Chapter", order_index: 0, status: "draft",
  current_document_version_id: "version-1", created_at: "2026-10-23T08:00:00Z", updated_at: "2026-10-23T08:00:00Z" },
  role: "owner", document: { chapterId: "chapter", version: 1, nodes: [] } });

test("suggestion recovery retains only scoped identities and rejects malformed decisions", () => {
  const raw = JSON.stringify({ ...decision, privateText: "Do not retain this manuscript" });
  assert.deepEqual(readSuggestionDecision(raw, "author", "book", "chapter"), decision);
  assert.equal(suggestionDecisionKey("author", "book", "chapter"), "bookworm:ai-decision:author:book:chapter");
  for (const change of [{ jobId: "../other" }, { expectedVersion: -1 }, { action: "accept" }, { userId: "other" }, { schema: 2 }])
    assert.equal(readSuggestionDecision(JSON.stringify({ ...decision, ...change }), "author", "book", "chapter"), null);
});

test("accepted suggestion recovery reads the job and its original saved operation without posting", async () => {
  const calls: string[] = [];
  const api = { getAiJob: async (id: string) => { calls.push(id); return job(); }, getChapterDocument: current,
    getChapterSaveStatus: async (id: string, operation: string) => { calls.push(`${id}:${operation}`); return receipt(); } };
  assert.equal((await recoverSuggestionDecision(api, decision)).version, 2);
  assert.deepEqual(calls, ["job", "chapter:ai-suggestion:proposal"]);
  for (const change of [{ book_id: "other" }, { id: "other" }, { chapter_ids: [] }, { suggestions: [] }])
    await assert.rejects(recoverSuggestionDecision({ ...api, getAiJob: async () => ({ ...job(), ...change }) }, decision), /does not match/);
  for (const change of [{ operationId: "other" }, { document: { chapterId: "other", version: 2, nodes: [] } }, { document: { chapterId: "chapter", version: 3, nodes: [] } }])
    await assert.rejects(recoverSuggestionDecision({ ...api, getChapterSaveStatus: async () => ({ ...receipt(), ...change }) }, decision), /receipt/);
});

test("pending and rejected decisions need no acceptance receipt; another reviewer has no own-author receipt", async () => {
  const noReceipt = async () => { throw Error("Unexpected receipt request"); };
  for (const status of ["pending", "rejected"] as const)
    assert.equal((await recoverSuggestionDecision({ getAiJob: async () => job(status), getChapterSaveStatus: noReceipt, getChapterDocument: current }, decision)).status, status);
  const missing = async () => ({ status: "not_found" as const, operationId: "ai-suggestion:proposal" });
  await assert.rejects(recoverSuggestionDecision({ getAiJob: async () => job(), getChapterSaveStatus: missing, getChapterDocument: current }, decision), /receipt is unavailable/);
  const other = job(); other.suggestions[0].reviewed_by = "another-author";
  assert.equal((await recoverSuggestionDecision({ getAiJob: async () => other, getChapterSaveStatus: missing, getChapterDocument: current }, decision)).version, null);
});

test("newer committed chapter fences an unresolved old Apply, with a second status read for a concurrent acceptance", async () => {
  const newer = async () => { const value = await current(); value.document.version = 3; return value; };
  let reads = 0;
  const api = { getAiJob: async () => { reads++; return job("pending"); }, getChapterSaveStatus: async () => receipt(), getChapterDocument: newer };
  const stale = await recoverSuggestionDecision(api, decision);
  assert.equal(stale.status, "stale"); assert.equal(stale.version, 3); assert.equal(reads, 2);
  reads = 0;
  const accepted = await recoverSuggestionDecision({ ...api, getAiJob: async () => ++reads === 1 ? job("pending") : job("accepted") }, decision);
  assert.equal(accepted.status, "accepted"); assert.equal(accepted.version, 2); assert.equal(reads, 2);
});
