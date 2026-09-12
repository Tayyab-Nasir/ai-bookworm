import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyStorageObjects, inspectPrivateStorageOrphans } from "./lib/storage-reconciliation.js";

const workspace = "a0000000-0000-4000-8000-000000000001";
const asset = "b0000000-0000-4000-8000-000000000001";
const path = `workspaces/${workspace}/assets/${asset}/v1/private.txt`;

test("storage reconciliation only reports old, managed, unreferenced objects", () => {
  const report = classifyStorageObjects({
    references: [path], graceHours: 168, now: new Date("2026-09-11T12:00:00.000Z"),
    objects: [
      { path, createdAt: "2026-08-01T00:00:00.000Z" },
      { path: path.replace("v1/private.txt", "v2/unreferenced.txt"), createdAt: "2026-08-01T00:00:00.000Z" },
      { path: path.replace("v1/private.txt", "v3/new.txt"), createdAt: "2026-09-11T11:59:00.000Z" },
      { path: path.replace("v1/private.txt", "v4/unknown-age.txt"), createdAt: null },
      { path: "unexpected/private.txt", createdAt: "2026-08-01T00:00:00.000Z" },
    ],
  });
  assert.equal(report.referencedObjects, 1);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].path.endsWith("unreferenced.txt"), true);
  assert.equal(report.youngerUnreferencedObjects, 1);
  assert.equal(report.unverifiedAgeObjects, 1);
  assert.equal(report.outOfScopeObjects, 1);
});

test("storage reconciliation rejects a grace period too short for uncertain writes", () => {
  assert.throws(() => classifyStorageObjects({ references: [], objects: [], graceHours: 1 }), /24 through 8760/);
});

test("receipt-bound images are retained and unavailable recovery references fail closed", async () => {
  const generatedPath = path.replace("private.txt", "generated.png");
  for (const mode of ["valid", "query-error", "malformed"] as const) {
    const client = {
      from(table: string) {
        const query = {
          select: () => query, order: () => query,
          range: async () => table === "image_completion_receipts"
            ? { data: [{ completion_json: { p_storage_path: mode === "malformed" ? null : generatedPath } }], error: mode === "query-error" ? { message: "unavailable" } : null }
            : { data: [], error: null },
        };
        return query;
      },
      storage: { from: () => ({ list: async () => ({ data: [{ id: "stored", name: generatedPath.slice("workspaces/".length), created_at: "2026-08-01T00:00:00Z" }], error: null }) }) },
    };
    if (mode !== "valid") {
      await assert.rejects(inspectPrivateStorageOrphans(client as never), /image_recovery_reference/);
    } else {
      const report = await inspectPrivateStorageOrphans(client as never, { now: new Date("2026-09-12T00:00:00Z") });
      assert.equal(report.referenceCount, 1);
      assert.equal(report.referencedObjects, 1);
      assert.deepEqual(report.candidates, []);
    }
  }
});
