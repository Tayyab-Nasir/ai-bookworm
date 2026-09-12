import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("chapter navigator uses the author workspace system instead of inline styling", async () => {
  const source = await readFile(new URL("../components/BookTree.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-current/);
  assert.match(source, /focus-visible:ring-2/);
  assert.match(source, /rounded-xl/);
  assert.doesNotMatch(source, /style=\{\{/);
});
