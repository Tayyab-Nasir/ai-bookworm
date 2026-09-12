import assert from "node:assert/strict";
import { test } from "node:test";
import { runOneDocumentJob } from "./lib/document-worker.js";

const job = {
  id: "11111111-1111-4111-8111-111111111111",
  book_id: "22222222-2222-4222-8222-222222222222",
  source_asset_id: "33333333-3333-4333-8333-333333333333",
  source_checksum: "a".repeat(64), created_by: "44444444-4444-4444-8444-444444444444",
  status: "running", attempts: 1, error_code: null,
  created_at: new Date().toISOString(), available_at: new Date().toISOString(), completed_at: null,
  lease_token: "55555555-5555-4555-8555-555555555555",
};

function fixture(options: { completionError?: boolean; recovered?: "running" | "succeeded"; recoveredToken?: string } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const sb = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "claim_manuscript_import") return { data: [job], error: null };
      if (name === "complete_leased_manuscript_import") return options.completionError
        ? { data: null, error: { message: "lost reply" } } : { data: { chapters: [] }, error: null };
      if (name === "fail_manuscript_import") return { data: { ...job, status: "queued" }, error: null };
      return { data: true, error: null };
    },
    from: () => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq"]) builder[method] = () => builder;
      builder.maybeSingle = async () => ({ data: {
        status: options.recovered ?? "running", lease_token: options.recoveredToken ?? job.lease_token,
      }, error: null });
      return builder;
    },
  };
  return { sb: sb as never, calls };
}

test("document worker executes one fenced job and completes it", async () => {
  const f = fixture(); let input: Record<string, unknown> | undefined;
  const result = await runOneDocumentJob(f.sb, { execute: async (value) => {
    input = value as unknown as Record<string, unknown>;
    return { chapters: [], assetIds: [], sourceAssetId: job.source_asset_id, report: { warnings: [], chapterCount: 0, imageCount: 0 } } as never;
  } });
  assert.deepEqual(result, { status: "succeeded", jobId: job.id });
  assert.deepEqual((input?.lease as Record<string, unknown>), { jobId: job.id, token: job.lease_token });
  assert.equal(input?.expectedChecksum, job.source_checksum);
  assert.equal(f.calls.filter((call) => call.name === "complete_leased_manuscript_import").length, 1);
});

test("retryable worker failures are persisted without leaking error text", async () => {
  const f = fixture();
  const result = await runOneDocumentJob(f.sb, { execute: async () => { throw new Error("secret provider detail"); } });
  assert.equal(result.status, "queued");
  const failure = f.calls.find((call) => call.name === "fail_manuscript_import");
  assert.equal(failure?.args.p_error_code, "document_dependency_unavailable");
  assert.doesNotMatch(JSON.stringify(f.calls), /secret provider detail/);
});

test("lost completion reply recovers succeeded state and never records failure", async () => {
  const f = fixture({ completionError: true, recovered: "succeeded" });
  const result = await runOneDocumentJob(f.sb, { execute: async () => ({}) as never });
  assert.equal(result.status, "succeeded");
  assert.ok(!f.calls.some((call) => call.name === "fail_manuscript_import"));
});

test("stale lease cannot complete or fail another worker's job", async () => {
  const f = fixture({ recoveredToken: "66666666-6666-4666-8666-666666666666" });
  const result = await runOneDocumentJob(f.sb, { execute: async () => { throw new Error("interrupted"); } });
  assert.equal(result.status, "lease_lost");
  assert.ok(!f.calls.some((call) => call.name === "fail_manuscript_import"));
});

test("empty queue is idle", async () => {
  const sb = { rpc: async () => ({ data: [], error: null }) };
  assert.deepEqual(await runOneDocumentJob(sb as never), { status: "idle" });
});
