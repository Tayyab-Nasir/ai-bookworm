import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranslationWorkerArguments } from "./lib/translation-worker-mode.js";

test("translation CLI defaults to funded quoted work and rejects legacy dispatch", () => {
  assert.deepEqual(parseTranslationWorkerArguments([]), { once: false, mode: "quoted" });
  assert.deepEqual(parseTranslationWorkerArguments(["--once", "--prepare-quotes"]), { once: true, mode: "prepare-quotes" });
  assert.throws(() => parseTranslationWorkerArguments(["--legacy"]), /Usage/);
  assert.throws(() => parseTranslationWorkerArguments(["--quoted", "--prepare-quotes"]), /Usage/);
});
