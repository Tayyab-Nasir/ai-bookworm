import assert from "node:assert/strict";
import { test } from "node:test";
import { compareRevisionText } from "../lib/version-comparison";
const revision = (version_number: number, plain_text?: string) => ({ id: String(version_number), version_number, plain_text });
test("comparison is chronological and reconstructs exact unicode and whitespace", () => {
  const old = "Hello  world.\n\nمرحبا!", next = "Hello new world.\nمرحبا!";
  const result = compareRevisionText(revision(9, next), revision(2, old))!;
  assert.equal(result.before.version_number, 2);
  assert.equal(result.changes.filter((c) => c.kind !== "add").map((c) => c.text).join(""), old);
  assert.equal(result.changes.filter((c) => c.kind !== "del").map((c) => c.text).join(""), next);
});
test("missing history is not an empty chapter", () => {
  assert.equal(compareRevisionText(revision(1), revision(2, "text")), null);
  assert.equal(compareRevisionText(revision(1, ""), revision(2, ""))?.identical, true);
  assert.equal(compareRevisionText(revision(1, ""), revision(2, "text"))?.changes[0].kind, "add");
});
test("whitespace changes are preserved and large comparisons are bounded", () => {
  assert.equal(compareRevisionText(revision(1, "a b"), revision(2, "a\nb"))?.identical, false);
  const result = compareRevisionText(revision(1, "old ".repeat(10000)), revision(2, "new ".repeat(10000)))!;
  assert.equal(result.mode, "full"); assert.equal(result.changes.length, 2);
});
