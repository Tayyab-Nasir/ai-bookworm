import { test } from "node:test";
import assert from "node:assert/strict";
import type { BookNode } from "@bookworm/book-model";
import type { SupabaseClient } from "./lib/supabase.js";
import { appendVersion } from "./lib/authoring.js";

test("chapter save sends table cells and captions to saved reading text without changing rich content", async () => {
  const nodes: BookNode[] = [
    { id: "prose", type: "paragraph", text: "Opening words" },
    { id: "table", type: "table", rows: [["Name", "Role"], ["Elara", "Writer"]] },
    { id: "image", type: "image", caption: "The hidden garden", altText: "Private accessibility description" },
  ];
  const original = JSON.stringify(nodes);
  let captured: Record<string, unknown> | undefined;
  const sb = { rpc: async (name: string, body: Record<string, unknown>) => {
    assert.equal(name, "append_chapter_version");
    captured = body;
    return { data: { id: "version-2", version_number: 2, content_json: body.p_content_json }, error: null };
  } } as unknown as SupabaseClient;
  const result = await appendVersion(sb, "chapter-1", 1, nodes, "save-1", "Manuscript edited");
  assert.equal(captured?.p_plain_text, "Opening words\n\nName\tRole\nElara\tWriter\n\nThe hidden garden");
  assert.equal(captured?.p_word_count, 9);
  assert.deepEqual(captured?.p_content_json, { schemaVersion: "1.0", nodes });
  assert.equal(captured?.p_expected_version, 1);
  assert.equal(captured?.p_operation_id, "save-1");
  assert.equal(result.version, 2);
  assert.deepEqual(result.document.nodes, nodes);
  assert.equal(JSON.stringify(nodes), original);
});

test("version writes keep explicit text precedence and empty text valid", async () => {
  for (const [nodes, expectedText, expectedCount] of [
    [[{ id: "table", type: "table", rows: [["Old cells"]], text: "New prose" }], "New prose", 2],
    [[{ id: "empty", type: "paragraph", text: "" }], "", 0],
  ] as [BookNode[], string, number][]) {
    const sb = { rpc: async (_name: string, body: Record<string, unknown>) => {
      assert.equal(body.p_plain_text, expectedText);
      assert.equal(body.p_word_count, expectedCount);
      return { data: [{ id: "version-3", version_number: 3, content_json: body.p_content_json }], error: null };
    } } as unknown as SupabaseClient;
    assert.equal((await appendVersion(sb, "chapter-1", 2, nodes, "save-2", "Edited")).version, 3);
  }
});
