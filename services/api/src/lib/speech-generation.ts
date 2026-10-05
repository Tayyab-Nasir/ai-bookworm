import OpenAI from "openai";
import { createHash } from "node:crypto";
import { AppError } from "../errors.js";

export const AUDIOBOOK_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova",
  "sage", "shimmer", "verse", "marin", "cedar",
] as const;
export type AudiobookVoice = typeof AUDIOBOOK_VOICES[number];
export const MAX_TTS_INPUT_BYTES = 1_800;

export interface SpeechSegment {
  index: number;
  start: number;
  end: number;
  text: string;
  sha256: string;
  creditUnits: number;
}

export interface SpeechGenerationInput {
  text: string;
  voice: AudiobookVoice;
  instructions?: string | null;
  speed: number;
}

export interface GeneratedSpeech {
  bytes: Buffer;
  mimeType: "audio/mpeg";
  provider: "openai";
  model: string;
  requestId: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    latencyMs: number;
    inputCharacters: number;
    estimationMethod: "word-rate-v1";
  };
}

export type SpeechGenerator = (input: SpeechGenerationInput) => Promise<GeneratedSpeech>;

function preferredBreak(chars: string[], start: number, hardEnd: number) {
  const floor = start + Math.floor((hardEnd - start) * 0.6);
  for (let i = hardEnd; i > floor; i--) {
    if (chars[i - 1] === "\n" && chars[i - 2] === "\n") return i - 1;
  }
  for (let i = hardEnd; i > floor; i--) {
    if (/[.!?]/u.test(chars[i - 1] ?? "") && /\s/u.test(chars[i] ?? "")) return i;
  }
  for (let i = hardEnd; i > floor; i--) if (/\s/u.test(chars[i - 1] ?? "")) return i - 1;
  return hardEnd;
}

function speechInputBytes(text: string, instructions?: string | null) {
  return Buffer.byteLength(text, "utf8") + Buffer.byteLength(instructions ?? "", "utf8");
}

export function segmentSpeechText(value: string, maxCharacters = 4_096, instructions?: string | null): SpeechSegment[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 256 || maxCharacters > 4_096) {
    throw new Error("speech segment limit must be between 256 and 4096 characters");
  }
  const instructionBytes = Buffer.byteLength(instructions ?? "", "utf8");
  const maxTextBytes = MAX_TTS_INPUT_BYTES - instructionBytes;
  if (maxTextBytes < 1) throw new AppError(422, "Narration instructions exceed the supported speech input limit.");
  const chars = Array.from(value);
  const segments: SpeechSegment[] = [];
  let start = 0;
  while (start < chars.length) {
    while (start < chars.length && /\s/u.test(chars[start] ?? "")) start++;
    if (start >= chars.length) break;
    let hardEnd = start;
    let textBytes = 0;
    while (hardEnd < chars.length && hardEnd - start < maxCharacters) {
      const nextBytes = Buffer.byteLength(chars[hardEnd] ?? "", "utf8");
      if (textBytes + nextBytes > maxTextBytes) break;
      textBytes += nextBytes;
      hardEnd++;
    }
    if (hardEnd === start) throw new AppError(422, "Narration text exceeds the supported speech input limit.");
    let end = hardEnd === chars.length ? hardEnd : preferredBreak(chars, start, hardEnd);
    while (end > start && /\s/u.test(chars[end - 1] ?? "")) end--;
    if (end <= start) end = hardEnd;
    const text = chars.slice(start, end).join("");
    segments.push({
      index: segments.length,
      start,
      end,
      text,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      // Keep the queue's authoritative per-segment operational quota tariff.
      creditUnits: Math.ceil((end - start) / 1_000),
    });
    if (segments.length > 250) throw new AppError(422, "This chapter requires more than 250 narration segments.");
    start = end;
  }
  if (!segments.length) throw new AppError(422, "This chapter has no text to narrate.");
  return segments;
}

// The Speech endpoint returns audio bytes rather than a token receipt. This
// estimate uses 150 spoken words/minute and 20 audio tokens/second; exact
// provider spend must be reconciled later from OpenAI organization usage.
export function estimatedSpeechUsage(text: string, speed: number, instructions?: string | null) {
  const inputCharacters = Array.from(text).length + Array.from(instructions ?? "").length;
  const inputTokens = Math.ceil(inputCharacters / 4);
  const words = text.trim().split(/\s+/u).filter(Boolean).length;
  const seconds = words / 2.5 / speed;
  const outputTokens = Math.ceil(seconds * 20);
  const estimatedCostUsd = Number((inputTokens * 0.6e-6 + outputTokens * 12e-6).toFixed(6));
  return { inputTokens, outputTokens, estimatedCostUsd, inputCharacters, estimationMethod: "word-rate-v1" as const };
}

function hasMp3Signature(bytes: Buffer) {
  return bytes.subarray(0, 3).toString("ascii") === "ID3"
    || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
}

export const openAiSpeechGenerator: SpeechGenerator = async ({ text, voice, instructions, speed }) => {
  if (Array.from(text).length > 4_096) throw new AppError(422, "Narration input exceeds 4096 characters.");
  if (speechInputBytes(text, instructions) > MAX_TTS_INPUT_BYTES) {
    throw new AppError(422, "Narration input exceeds the supported speech model limit.");
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new AppError(503, "Audiobook generation is not configured.", undefined, "speech_provider_not_configured");
  const model = process.env.OPENAI_TTS_MODEL?.trim() || "gpt-4o-mini-tts";
  const client = new OpenAI({ apiKey, timeout: 130_000, maxRetries: 0 });
  const started = Date.now();
  const response = await client.audio.speech.create({
    model,
    voice,
    input: text,
    response_format: "mp3",
    speed,
    ...(instructions ? { instructions } : {}),
  }, { timeout: 130_000, maxRetries: 0 });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 50 * 1024 * 1024 || !hasMp3Signature(bytes)) {
    throw new AppError(503, "The speech provider returned invalid audio.", undefined, "invalid_speech_output");
  }
  return {
    bytes,
    mimeType: "audio/mpeg",
    provider: "openai",
    model,
    requestId: (response as unknown as { _request_id?: string })._request_id ?? null,
    usage: { ...estimatedSpeechUsage(text, speed, instructions), latencyMs: Date.now() - started },
  };
};
