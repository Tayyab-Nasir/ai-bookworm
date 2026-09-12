import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("book setup scans uploads before importing chapters", async () => {
  const source = await readFile(resolve(here, "..", "components", "BookSetupClient.tsx"), "utf8");
  const workflow = await readFile(resolve(here, "..", "lib", "manuscript-setup.ts"), "utf8");
  assert.match(workflow, /await input\.api\.confirmAssetUpload\(source.assetId/);
  assert.match(workflow, /await input\.api\.importManuscript\(checkpoint.bookId, source.assetId\)/);
  assert.match(source, /await runManuscriptSetup/);
  assert.match(source, /Checking source\.\.\./);
  assert.match(source, /Importing chapters\.\.\./);
  assert.doesNotMatch(source, /Chapter extraction is not yet connected/);
});

test("asset library reports upload and quarantine states", async () => {
  const source = await readFile(resolve(here, "..", "app", "assets", "page.tsx"), "utf8");
  assert.match(source, /Verifying checksum, file type, and malware status/);
  assert.match(source, /Rejected by malware scan/);
  assert.match(source, /Scan unavailable, quarantined/);
  assert.match(source, /disabled=\{!workspaceId \|\| !canEdit \|\| Boolean\(uploadStage\)\}/);
});
