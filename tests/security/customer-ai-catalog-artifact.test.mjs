/** Emit the embedded query with the actual TypeScript compiler and execute the artifact. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { customerAiCatalogSnapshotSql } from "../../services/api/src/lib/customer-ai-catalog-snapshot.ts";

test("compiled SQL module contains the pinned authoritative query", async () => {
  const out = await mkdtemp(join(tmpdir(), "bookworm-catalog-artifact-"));
  const source = fileURLToPath(new URL("../../services/api/src/lib/customer-ai-catalog-snapshot.ts", import.meta.url));
  const compiler = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const result = spawnSync(process.execPath, [compiler, "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "--outDir", out, source], { env, timeout: 30000, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, "TypeScript compilation must succeed");
  await writeFile(join(out, "package.json"), '{"type":"module"}');
  const artifact = join(out, "customer-ai-catalog-snapshot.js");
  const contents = await readFile(artifact, "utf8");
  assert(contents.includes("export const customerAiCatalogSnapshotSql"));
  const compiled = await import(pathToFileURL(artifact).href);
  assert.equal(compiled.customerAiCatalogSnapshotSql.replace(/\r\n/g, "\n"), customerAiCatalogSnapshotSql.replace(/\r\n/g, "\n"));
  assert.equal(createHash("sha256").update(compiled.customerAiCatalogSnapshotSql.replace(/\r\n/g, "\n")).digest("hex"), "cd8968cbee936d45f1f87abfa6b4084b57fa22dd3fb231ca3a0bd5d72310cff4");
});
