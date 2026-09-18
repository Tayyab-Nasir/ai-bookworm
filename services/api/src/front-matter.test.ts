import assert from "node:assert/strict";
import { test } from "node:test";
import { editionConfigSchema } from "./routes/editions.js";

test("edition front matter validates, preserves exact text and defaults without legal claims", () => {
  for (const kind of ["ebook", "print"] as const) {
    const front_matter = { copyright_notice: "Copyright Ada & Co.\n<Permission required>", publisher: "Finch" };
    const config = editionConfigSchema.parse({ kind, front_matter });
    if (config.kind === "audiobook") throw new Error("wrong format");
    assert.deepEqual(config.front_matter, front_matter);
    assert.deepEqual(editionConfigSchema.parse(config), config);
    const defaults = editionConfigSchema.parse({ kind });
    if (defaults.kind === "audiobook") throw new Error("wrong format");
    assert.deepEqual(defaults.front_matter, { copyright_notice: "", publisher: "" });
    for (const [field, limit] of [["publisher", 200], ["copyright_notice", 3000]] as const) {
      assert.equal(editionConfigSchema.safeParse({ kind, front_matter: { [field]: "x".repeat(limit + 1) } }).success, false);
    }
    assert.equal(editionConfigSchema.safeParse({ kind, front_matter: { registered: true } }).success, false);
  }
  const ebook = editionConfigSchema.parse({ kind: "ebook", include_title_page: true });
  assert.equal(ebook.kind === "ebook" && ebook.include_title_page, true);
});
