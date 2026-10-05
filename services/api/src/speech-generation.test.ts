import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatedSpeechUsage, MAX_TTS_INPUT_BYTES, openAiSpeechGenerator, segmentSpeechText } from "./lib/speech-generation.js";

test("speech segmentation pins bounded Unicode character ranges and hashes", () => {
  const text = `${"A".repeat(2_100)}.\n\n${"😀".repeat(2_100)} end.`;
  const segments = segmentSpeechText(text);
  const chars = Array.from(text);
  assert.ok(segments.length > 2);
  for (const segment of segments) {
    assert.ok(segment.end - segment.start <= 4_096);
    assert.equal(chars.slice(segment.start, segment.end).join(""), segment.text);
    assert.match(segment.sha256, /^[a-f0-9]{64}$/);
    assert.equal(segment.creditUnits, Math.ceil((segment.end - segment.start) / 1_000));
  }
  assert.equal(segments.reduce((total, segment) => total + segment.creditUnits, 0),
    segments.reduce((total, segment) => total + Math.ceil((segment.end - segment.start) / 1_000), 0));
});

test("speech segments reserve UTF-8 input budget for saved voice instructions", () => {
  const instructions = "style ".repeat(120);
  const text = "界".repeat(2_400);
  const segments = segmentSpeechText(text, 4_096, instructions);

  assert.ok(segments.length > 2);
  assert.equal(segments.map(segment => segment.text).join(""), text);
  for (const segment of segments) {
    assert.ok(Buffer.byteLength(segment.text, "utf8") + Buffer.byteLength(instructions, "utf8") <= MAX_TTS_INPUT_BYTES);
  }
});

test("speech segmentation rejects instructions that consume the complete safe input budget", () => {
  assert.throws(() => segmentSpeechText("hello", 4_096, "x".repeat(1_800)), /instructions.*limit/i);
});

test("speech provider rejects oversized text plus instructions before reading credentials", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "";
  try {
    await assert.rejects(openAiSpeechGenerator({
      text: "x".repeat(MAX_TTS_INPUT_BYTES), voice: "marin", instructions: "x", speed: 1,
    }), /supported speech model limit/i);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("provider-safe chunks match the database's per-segment audio credit tariff", () => {
  const text = "A".repeat(4_000);
  const segments = segmentSpeechText(text);
  assert.deepEqual(segments.map(segment => segment.end - segment.start), [1_800, 1_800, 400]);
  assert.deepEqual(segments.map(segment => segment.creditUnits), [2, 2, 1]);
});

test("speech cost estimate uses the reviewed model price snapshot", () => {
  const usage = estimatedSpeechUsage("one two three four five", 1);
  assert.equal(usage.inputTokens, 6);
  assert.equal(usage.outputTokens, 40);
  assert.equal(usage.estimatedCostUsd, 0.000484);
});

test("speech input estimate includes repeated voice instructions but not their spoken words", () => {
  const usage = estimatedSpeechUsage("one two three four five", 1, "warm");
  assert.equal(usage.inputCharacters, 27);
  assert.equal(usage.inputTokens, 7);
  assert.equal(usage.outputTokens, 40);
});

test("blank narration and unsafe segment limits fail before a provider call", () => {
  assert.throws(() => segmentSpeechText(" \n "), /no text/i);
  assert.throws(() => segmentSpeechText("hello", 10), /between 256 and 4096/i);
});
