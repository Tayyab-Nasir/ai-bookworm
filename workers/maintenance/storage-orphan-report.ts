import { defaultSupabaseFactory } from "../../services/api/src/lib/supabase.js";
import { inspectPrivateStorageOrphans } from "../../services/api/src/lib/storage-reconciliation.js";

async function main() {
  const args = process.argv.slice(2);
  const match = args[0]?.match(/^--grace-hours=(\d+)$/u);
  if (args.length > 1 || (args.length === 1 && !match)) {
    throw new Error("Usage: storage:orphan-report [--grace-hours=168]");
  }
  const graceHours = match ? Number(match[1]) : 168;
  if (!Number.isInteger(graceHours) || graceHours < 24 || graceHours > 24 * 365) {
    throw new Error("Usage: storage:orphan-report [--grace-hours=24..8760]");
  }
  const report = await inspectPrivateStorageOrphans(defaultSupabaseFactory(), {
    graceHours,
  });
  // Paths can contain private filenames. Emit aggregates only; review paths in a
  // controlled operator session before any separately authorized deletion work.
  console.log(JSON.stringify({
    status: "dry_run", generatedAt: report.generatedAt, graceHours: report.graceHours,
    referenceCount: report.referenceCount, objectCount: report.objectCount,
    referencedObjects: report.referencedObjects, outOfScopeObjects: report.outOfScopeObjects,
    unverifiedAgeObjects: report.unverifiedAgeObjects,
    youngerUnreferencedObjects: report.youngerUnreferencedObjects,
    candidateCount: report.candidates.length,
  }));
}
main().catch((error) => {
  const usage = error instanceof Error && error.message.startsWith("Usage:");
  console.error(JSON.stringify({ status: usage ? "storage_inventory_usage_error" : "storage_inventory_unavailable" }));
  process.exitCode = 1;
});
