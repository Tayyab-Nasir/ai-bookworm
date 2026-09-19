import assert from "node:assert/strict";
import { test } from "node:test";
import { metadataRequestCanRestart, metadataGenerationBlocked } from "../components/BookMemoryClient";

test("generation waits for saved status and unresolved jobs before allowing new spending", () => {
  assert.equal(metadataGenerationBlocked(null), true);
  assert.equal(metadataGenerationBlocked([{ id: "job", createdAt: "now", status: "running" }]), true);
  assert.equal(metadataGenerationBlocked([]), false);
});

test("metadata retry preserves uncertain paid requests and permits definite corrections", () => {
  for (const error of [new Error("Network lost"), null, { status: 500 }, { status: 503 }, { status: 409, details: { status: "running" } }]) {
    assert.equal(metadataRequestCanRestart(error), false);
  }
  for (const error of [{ status: 422 }, { status: 403 }, { status: 409, details: { status: "failed" } }]) {
    assert.equal(metadataRequestCanRestart(error), true);
  }
});
