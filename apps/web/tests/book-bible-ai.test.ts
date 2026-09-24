import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bibleGenerationBlocked, parseBookBibleCandidates } from "../components/BookMemoryClient";

const ref = { chapterId: "chapter", documentVersionId: "version", nodeId: "n1", textHash: "a".repeat(64) };
const candidate = { suggestionKind: "book_bible_candidate", status: "pending", type: "character",
  name: "Elara", description: "A mapmaker", attributes: { eyes: "silver", maps: ["north", "east"] },
  confidence: 0.8, sourceRefs: [ref] };

test("Book Bible candidate parser preserves structured details and pinned evidence", () => {
  assert.deepEqual(parseBookBibleCandidates([candidate]), [{ type: "character", name: "Elara",
    description: "A mapmaker", attributes: candidate.attributes, confidence: 0.8, sourceRefs: [ref] }]);
  assert.deepEqual(parseBookBibleCandidates([]), []);
});

test("Book Bible candidate parser rejects unsupported or uncited drafts", () => {
  for (const value of [null, [candidate, ...Array(10).fill(candidate)],
    [{ ...candidate, sourceRefs: [] }], [{ ...candidate, sourceRefs: [{ ...ref, textHash: "bad" }] }],
    [{ ...candidate, attributes: { note: "x".repeat(25000) } }]]) {
    assert.throws(() => parseBookBibleCandidates(value), /invalid/i);
  }
});

test("Book Bible generation blocks on unknown or pending status and apply remains an unsaved form action", async () => {
  assert.equal(bibleGenerationBlocked(null), true);
  assert.equal(bibleGenerationBlocked([{ id: "job", createdAt: "now", status: "running" }]), true);
  assert.equal(bibleGenerationBlocked([]), false);
  const here = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(resolve(here, "..", "components", "BookMemoryClient.tsx"), "utf8");
  assert.match(source, /bible\/generate`, "POST"/);
  assert.match(source, />Open as unsaved entry<\/button>/);
  assert.match(source, /setEntryDirty\(true\)/);
  assert.match(source, /choose Save/);
  assert.equal(/function useBibleCandidate[\s\S]*?request<[^>]*>/.test(source), false,
    "opening a candidate must not persist an entry");
});
