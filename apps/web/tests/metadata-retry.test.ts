import assert from "node:assert/strict";
import { test } from "node:test";
import { metadataRequestCanRestart } from "../components/BookMemoryClient";

test("metadata retry preserves uncertain paid requests and permits definite corrections", () => {
  for (const error of [new Error("Network lost"), null, { status: 500 }, { status: 503 }, { status: 409, details: { status: "running" } }]) {
    assert.equal(metadataRequestCanRestart(error), false);
  }
  for (const error of [{ status: 422 }, { status: 403 }, { status: 409, details: { status: "failed" } }]) {
    assert.equal(metadataRequestCanRestart(error), true);
  }
});
