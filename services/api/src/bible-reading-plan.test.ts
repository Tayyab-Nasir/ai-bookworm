import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildBibleReadingPlan } from "./lib/bible-reading-plan.js";

const chapter = (text: string) => ({ id: "chapter", title: "Arrival", order: 0, version: 1,
  documentVersionId: "version", nodes: [{ id: "node", text }] });
test("Bible reading pages cover large Unicode nodes exactly, without broken code points", () => {
  const text = ('A😀港\n"\\').repeat(7000);
  const plan = buildBibleReadingPlan([chapter(text)], 4096);
  assert.ok(plan.pages.length > 1);
  const parts = plan.pages.flatMap(page => {
    assert.ok(page.bytes <= Math.floor(4096 * 1.7));
    assert.ok(page.ranges.length <= 100);
    return page.ranges.map(range => {
      assert.equal(range.textHash, createHash("sha256").update(text).digest("hex"));
      const part = text.slice(range.startOffset, range.endOffset);
      assert.equal(Buffer.from(part).toString("utf8"), part);
      return part;
    });
  });
  assert.equal(parts.join(""), text);
  assert.equal(plan.fingerprint, buildBibleReadingPlan([chapter(text)], 4096).fingerprint);
  assert.notEqual(plan.fingerprint, buildBibleReadingPlan([{ ...chapter(text), documentVersionId: "new" }], 4096).fingerprint);
});
test("Bible reading plan keeps all short nodes and rejects ambiguous or empty evidence", () => {
  const input = { ...chapter(""), nodes: Array.from({ length: 201 }, (_, i) => ({ id: `n${i}`, text: "fact" })) };
  const plan = buildBibleReadingPlan([input], 12000);
  assert.equal(plan.pages.flatMap(page => page.ranges).length, 201);
  assert.throws(() => buildBibleReadingPlan([chapter("  ")], 12000));
  assert.throws(() => buildBibleReadingPlan([{ ...input, nodes: [{ id: "a", text: "one" }, { id: "a", text: "two" }] }], 12000));
});
