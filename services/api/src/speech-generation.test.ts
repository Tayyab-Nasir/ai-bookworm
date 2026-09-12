import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatedSpeechUsage, segmentSpeechText } from "./lib/speech-generation.js";

test("speech segmentation pins bounded Unicode character ranges and hashes", () => {
  const text = `${"A".repeat(2_100)}.\n\n${"😀".repeat(2_100)} end.`;
  const segments = segmentSpeechText(text);
  const chars = Array.from(text);
  assert.equal(segments.length, 2);
  for (const segment of segments) {
    assert.ok(segment.end - segment.start <= 4_096);
    assert.equal(chars.slice(segment.start, segment.end).join(""), segment.text);
    assert.match(segment.sha256, /^[a-f0-9]{64}$/);
    assert.equal(segment.creditUnits, Math.ceil((segment.end - segment.start) / 1_000));
  }
});

test("speech cost estimate uses the reviewed model price snapshot", () => {
  const usage = estimatedSpeechUsage("one two three four five", 1);
  assert.equal(usage.inputTokens, 6);
  assert.equal(usage.outputTokens, 40);
  assert.equal(usage.estimatedCostUsd, 0.000484);
});

test("blank narration and unsafe segment limits fail before a provider call", () => {
  assert.throws(() => segmentSpeechText(" \n "), /no text/i);
  assert.throws(() => segmentSpeechText("hello", 10), /between 256 and 4096/i);
});
