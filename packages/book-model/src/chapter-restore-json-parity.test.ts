import { test } from "node:test";
import assert from "node:assert/strict";
import { BookNodeSchema } from "./schema.js";

test("untrusted stored numbers can change through JavaScript and require a restore guard", () => {
  const unsafe = JSON.parse('{"id":"x","type":"paragraph","attributes":{"huge":1e400,"precise":9007199254740993}}');
  const parsed = BookNodeSchema.parse(unsafe);
  assert.equal((parsed.attributes as Record<string, unknown>).huge, Infinity);
  assert.equal(JSON.stringify(parsed).includes('"huge":null'), true);
  assert.equal(JSON.stringify(parsed).includes('"precise":9007199254740992'), true);
  const safe = JSON.parse('{"id":"x","type":"paragraph","attributes":{"limit":9007199254740991,"negative":-9007199254740991}}');
  assert.deepEqual(JSON.parse(JSON.stringify(BookNodeSchema.parse(safe))), safe);
});

test("Zod drops own __proto__ keys at node and attributes boundaries", () => {
  const input = JSON.parse('{"id":"x","type":"paragraph","__proto__":{"a":1},"attributes":{"__proto__":{"b":2}}}');
  assert.equal(Object.hasOwn(input, "__proto__"), true);
  assert.equal(Object.hasOwn(input.attributes, "__proto__"), true);
  const parsed = BookNodeSchema.parse(input);
  assert.equal(Object.hasOwn(parsed, "__proto__"), false);
  assert.equal(Object.hasOwn(parsed.attributes!, "__proto__"), false);
});
