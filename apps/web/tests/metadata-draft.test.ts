import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { metadataQuoteIntentKey, parseGeneratedMetadataCandidate } from "../components/BookMemoryClient";

test("generated metadata parser keeps bounded publishing fields and valid evidence", () => {
  const candidate = parseGeneratedMetadataCandidate({
    description: "  A warm, evidence-based description grounded in the saved story.  ",
    keywords: [" cozy fantasy ", "", 42, "found family"],
    categories: [" Fiction / Fantasy "],
    audience: " Adult fantasy readers ",
    rationale: " Drawn from the story's established tone. ",
    confidence: 0.82,
    sourceRefs: [
      { chapterId: "chapter-1", documentVersionId: "version-1", nodeId: "node-4", textHash: "abc123", note: "Opening scene" },
      { note: "missing chapter id" },
    ],
  });

  assert.equal(candidate.description, "A warm, evidence-based description grounded in the saved story.");
  assert.deepEqual(candidate.keywords, ["cozy fantasy", "found family"]);
  assert.deepEqual(candidate.categories, ["Fiction / Fantasy"]);
  assert.equal(candidate.audience, "Adult fantasy readers");
  assert.equal(candidate.confidence, 0.82);
  assert.deepEqual(candidate.sourceRefs, [{ chapterId: "chapter-1", documentVersionId: "version-1", nodeId: "node-4", textHash: "abc123", note: "Opening scene" }]);
});

test("generated metadata parser rejects incomplete drafts", () => {
  assert.throws(() => parseGeneratedMetadataCandidate(null), /invalid metadata draft/i);
  assert.throws(() => parseGeneratedMetadataCandidate({ description: "Description", keywords: [], categories: ["Fiction"] }), /incomplete/i);
  assert.throws(() => parseGeneratedMetadataCandidate({
    description: "A sufficiently detailed book description for this generated candidate.",
    keywords: ["fantasy"], categories: ["Fiction / Fantasy"],
    sourceRefs: [{ chapterId: "chapter-1" }],
  }), /incomplete|invalid/i);
});

test("metadata UI keeps AI generation and persistence as separate author actions", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(resolve(here, "..", "components", "BookMemoryClient.tsx"), "utf8");
  assert.match(source, /metadata\/quotes`, "POST"/);
  assert.match(source, /metadata\/quotes\/\$\{encodeURIComponent\(metadataQuoteIntent\.requestId\)\}\/accept/);
  assert.match(source, /expectedCredits: metadataQuote\.reservedCredits/);
  assert.match(source, /I agree to send the selected saved chapters.*input-token counting/s);
  assert.match(source, /Accepting starts one generation and reserves this amount/s);
  assert.doesNotMatch(source, /metadata\/generate`, "POST"/, "the author UI must not bypass exact token quotes");
  assert.match(source, />Use this draft<\/button>/);
  assert.match(source, /Using a draft does not save it\./);
  assert.match(source, /AI draft copied into the form\. Review it, then choose Save metadata/);
  const useDraft = source.split("function useMetadataCandidate()")[1]?.split("async function loadBibleHistory()")[0] ?? "";
  assert.equal(/request<[^>]*>/.test(useDraft), false, "Use draft must not make a persistence request");
});

test("metadata quote recovery key is isolated by book and contains no manuscript text", () => {
  const first = metadataQuoteIntentKey("book-one");
  const second = metadataQuoteIntentKey("book-two");
  assert.equal(first, "bookworm:metadata-quote:v1:book-one");
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /chapter|manuscript|source text/i);
});
