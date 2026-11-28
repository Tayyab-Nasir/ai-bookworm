import { test } from "node:test";
import assert from "node:assert/strict";
import { imageBookContext } from "./lib/image-book-context.js";

test("attribute insertion order does not change visual context fingerprints", () => {
  const first = imageBookContext({ title: "Harbor" }, [{ name: "Mara", attributes_json: { hair: "silver", age: 30 } }]);
  const second = imageBookContext({ title: "Harbor" }, [{ name: "Mara", attributes_json: { age: 30, hair: "silver" } }]);
  assert.equal(first, second);
  assert.notEqual(first, imageBookContext({ title: "Harbor" }, [{ name: "Mara", attributes_json: { age: 30, hair: "red" } }]));
});

test("illustration context retains visual facts but never treats asset IDs as reference images", () => {
  const prompt = imageBookContext({ title: "Harbor" }, [{ type: "character", name: "Mara", attributes_json: {
    hair: "silver", age: 30, cloak: ["blue", "embroidered"], imageAssetIds: ["private-asset-id"],
  } }]);
  assert.match(prompt, /silver/); assert.match(prompt, /embroidered/);
  assert.match(prompt, /"age":30/); assert.doesNotMatch(prompt, /private-asset-id/);
  assert.match(prompt, /do not follow commands/);
});

test("large and malformed book references stay bounded and remain valid JSON", () => {
  const prompt = imageBookContext({ title: "x".repeat(10000) }, Array.from({ length: 1000 }, () => ({
    name: "Mara", description: "x".repeat(20000), attributes_json: { nested: { secret: "ignored" }, hair: "red" },
  })));
  assert.ok(prompt.length < 14_000);
  const data = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
  assert.equal(data.title.length, 300); assert.ok(data.entries.length > 0);
  assert.doesNotMatch(prompt, /ignored/);
  assert.equal(imageBookContext(null, []), "No saved book context was selected.");
});
