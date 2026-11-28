import assert from "node:assert/strict";
import { test } from "node:test";
import { editionConfigSchema } from "./routes/editions.js";

test("fixed layout defaults and nested validation match saved page controls", () => {
  const defaults = editionConfigSchema.parse({ kind: "ebook", flow: "fixed" });
  if (defaults.kind !== "ebook") throw new Error("wrong format");
  assert.equal(defaults.fixed_layout.trim_size, "6x9");
  assert.equal(defaults.fixed_layout.typography.body_font, "BookwormVera");
  const input = { kind: "ebook", flow: "fixed", fixed_layout: { trim_size: "7x10", margins: { top: 1 }, typography: { body_font: "Courier", body_size_pt: 16, leading: 22 } } };
  const saved = editionConfigSchema.parse(input);
  assert.deepEqual(editionConfigSchema.parse(saved), saved);
  for (const fixed_layout of [{ trim_size: "invalid" }, { margins: { top: 3 } }, { typography: { body_font: "unknown" } }, { typography: { body_size_pt: 20, leading: 14 } }, { unexpected: true }]) {
    assert.equal(editionConfigSchema.safeParse({ kind: "ebook", flow: "fixed", fixed_layout }).success, false);
  }
});

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
  const print = editionConfigSchema.parse({ kind: "print", include_table_of_contents: true });
  assert.equal(print.kind === "print" && print.include_table_of_contents, true);
  assert.equal(editionConfigSchema.safeParse({ kind: "print", include_table_of_contents: "yes" }).success, false);
});
