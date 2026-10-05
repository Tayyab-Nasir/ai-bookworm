import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { AppError } from "./errors.js";
import { generateRealtimeNarration, measuredNarrationQuantities, narrationInstructions,
  MAX_NARRATION_PCM_BYTES, type RealtimeNarrationInput } from "./lib/realtime-narration.js";
import { quoteUsage, reconcileUsage } from "./lib/usage-pricing.js";

const USER = "a6200000-0000-4000-8000-000000000001";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const input: RealtimeNarrationInput = { userId: USER, model: "gpt-realtime-2.1-mini",
  text: "Read this café chapter.", voice: "marin", speed: 1, instructions: "Warm delivery", maxOutputTokens: 1_024 };
const usage = { input_tokens: 60, output_tokens: 220, total_tokens: 280,
  input_token_details: { text_tokens: 60, audio_tokens: 0, cached_tokens: 10,
    cached_tokens_details: { text_tokens: 10, audio_tokens: 0 } },
  output_token_details: { text_tokens: 20, audio_tokens: 200 } };
const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
type Events = Record<string, any>[];

function fixture(request = input, options: {
  events?: (events: Events) => Events; session?: (session: Record<string, any>) => Record<string, any>;
  transcript?: string; stall?: boolean;
} = {}) {
  const sent: Record<string, any>[] = [];
  const connections: { model: string; safetyIdentifier: string }[] = [];
  class Fake extends EventEmitter {
    closed = 0; terminated = 0;
    socket = Object.assign(new EventEmitter(), { terminate: () => {
      this.terminated++; queueMicrotask(() => this.socket.emit("close"));
    } });
    close() { this.closed++; }
    send(value: Record<string, any>) {
      sent.push(value);
      if (value.type === "session.update") {
        const session = { id: "sess_fixture", ...value.session };
        queueMicrotask(() => this.emit("event", { type: "session.updated", event_id: "configuration",
          session: options.session?.(session) ?? session }));
      } else if (value.type === "response.create") {
        const text = options.transcript ?? request.text;
        const response = { id: "resp_fixture", metadata: value.response.metadata,
          conversation_id: null, max_output_tokens: request.maxOutputTokens, output_modalities: ["audio"] };
        const part = { response_id: "resp_fixture", item_id: "item_fixture", output_index: 0, content_index: 0 };
        const events: Events = [
          { type: "response.created", response },
          { type: "response.output_audio.delta", ...part, delta: pcm.subarray(0, 4).toString("base64") },
          { type: "response.output_audio_transcript.delta", ...part, delta: text.slice(0, 4) },
          { type: "response.output_audio.delta", ...part, delta: pcm.subarray(4).toString("base64") },
          { type: "response.output_audio_transcript.delta", ...part, delta: text.slice(4) },
          { type: "response.output_audio.done", ...part },
          { type: "response.output_audio_transcript.done", ...part, transcript: text },
          { type: "response.done", response: { ...response, status: "completed", usage: structuredClone(usage),
            output: [{ id: "item_fixture", type: "message", role: "assistant", status: "completed",
              content: [{ type: "output_audio", transcript: text }] }] } },
        ].map((event, index) => ({ event_id: `part_${index}`, ...event }));
        queueMicrotask(() => { for (const event of options.events?.(events) ?? events) this.emit("event", event); });
      }
    }
  }
  const connection = new Fake();
  const connect = (params: { model: string; safetyIdentifier: string }) => {
    connections.push(params);
    if (!options.stall) queueMicrotask(() => connection.emit("event", { type: "session.created", event_id: "session",
      session: { id: "sess_fixture", type: "realtime", model: request.model } }));
    return connection as never;
  };
  return { connection, connect, connections, sent };
}

test("realtime narration uses one isolated bounded server-side audio request and measured receipt", async () => {
  const data = fixture();
  const result = await generateRealtimeNarration(input, { connect: data.connect });
  assert.deepEqual(data.connections, [{ model: input.model, safetyIdentifier: sha(USER) }]);
  assert.deepEqual(result.bytes, pcm);
  assert.deepEqual({ mimeType: result.mimeType, sampleRateHz: result.sampleRateHz, channels: result.channels, bitDepth: result.bitDepth },
    { mimeType: "audio/pcm", sampleRateHz: 24_000, channels: 1, bitDepth: 16 });
  assert.equal(result.sourceSha256, sha(input.text)); assert.equal(result.audioSha256, sha(pcm));
  assert.equal(result.responseId, "resp_fixture"); assert.equal(result.model, input.model);
  assert.equal(result.durationSeconds, pcm.length / 48_000); assert.ok(result.latencyMs >= 0);
  assert.equal(result.transcript, input.text); assert.equal(result.reviewRequired, false);
  assert.deepEqual(result.rawUsage, usage); assert.deepEqual(result.measuredTokens, measuredNarrationQuantities(usage, input.maxOutputTokens));
  assert.deepEqual(data.sent.map(event => event.type), ["session.update", "response.create"]);
  const create = data.sent[1].response;
  assert.equal(create.conversation, "none"); assert.equal(create.max_output_tokens, input.maxOutputTokens);
  assert.equal(create.instructions, narrationInstructions(input.instructions));
  assert.deepEqual(create.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: input.text }] }]);
  assert.deepEqual(create.tools, []); assert.equal(create.tool_choice, "none");
  assert.equal(data.sent[0].session.tracing, null); assert.equal(data.sent[0].session.truncation, "disabled");
  assert.equal(data.sent[0].session.audio.input.turn_detection, null);
  assert.equal(data.connection.closed, 1); assert.equal(data.connection.terminated, 1);
  assert.equal(data.connection.listenerCount("event"), 0);
  data.connection.emit("error", new Error("PRIVATE_LATE_PROVIDER_ERROR"));
  assert.equal(data.sent.length, 2, "late error must not reconnect or generate again");
});

test("both supported latest realtime profiles preserve pinned model and Unicode source identity", async () => {
  const request = { ...input, model: "gpt-realtime-2.1" as const, text: "帰郷 😀 — café", instructions: null };
  const data = fixture(request);
  const result = await generateRealtimeNarration(request, { connect: data.connect });
  assert.equal(result.model, request.model); assert.equal(result.sourceSha256, sha(request.text));
  assert.equal(result.reviewRequired, false);
});

test("measured narration separates cached text, transcript text and audio output for exact approved pricing", () => {
  const tokens = measuredNarrationQuantities(usage, 1_024); assert.ok(tokens);
  assert.deepEqual(tokens, [{ dimension: "text_input", tokens: "50" }, { dimension: "text_cached_input", tokens: "10" },
    { dimension: "text_output", tokens: "20" }, { dimension: "audio_output", tokens: "200" }]);
  // Synthetic approved policy only; no production catalog or purchase enabled.
  const scope = { jobId: "a6200000-0000-4000-8000-000000000002", workspaceId: "a6200000-0000-4000-8000-000000000003", userId: USER, inputSha256: sha(input.text) };
  const quote = quoteUsage({ scope, price: { version: "fixture-20261005", provider: "openai", model: input.model,
    rates: [{ dimension: "text_input", microUsdPerMillionTokens: "600000" }, { dimension: "text_cached_input", microUsdPerMillionTokens: "60000" },
      { dimension: "text_output", microUsdPerMillionTokens: "2400000" }, { dimension: "audio_output", microUsdPerMillionTokens: "20000000" }] },
    policy: { version: "fixture", approved: true, microUsdPerCredit: "100", markupBasisPoints: 15_000, platformMicroUsd: "0", minimumCredits: "1" },
    maximumTokens: tokens.map(item => ({ ...item, tokens: item.dimension === "audio_output" ? "4096" : "1000" })),
    createdAt: "2026-10-05T04:00:00Z", expiresAt: "2026-10-05T04:30:00Z" });
  const settled = reconcileUsage(quote, { scope, provider: "openai", model: input.model, requestId: "resp_fixture", measurement: "measured", tokens });
  assert.equal(settled.status, "settle");
  if (settled.status === "settle") {
    assert.equal(settled.providerMicroUsd, "4079"); assert.equal(settled.debitCredits, "62");
    assert.equal(settled.releaseCredits, "1213");
  }
  assert.throws(() => reconcileUsage(quote, { scope, provider: "openai", model: input.model,
    requestId: "resp_fixture", measurement: "estimated", tokens }), /estimated usage requires reconciliation/);
});

for (const [name, change] of [
  ["missing usage", () => null],
  ["missing itemization", (value: any) => { delete value.output_token_details; return value; }],
  ["new billing counter", (value: any) => ({ ...value, other_tokens: 1 })],
  ["new cached modality", (value: any) => { value.input_token_details.cached_tokens_details.other_tokens = 1; return value; }],
  ["negative count", (value: any) => { value.output_token_details.audio_tokens = -1; return value; }],
  ["fractional count", (value: any) => { value.input_tokens = 60.5; return value; }],
  ["unsafe integer", (value: any) => { value.input_tokens = Number.MAX_SAFE_INTEGER + 1; return value; }],
  ["unbalanced input", (value: any) => { value.input_tokens++; return value; }],
  ["unbalanced output", (value: any) => { value.output_tokens++; return value; }],
  ["unbalanced total", (value: any) => { value.total_tokens++; return value; }],
  ["missing cache breakdown", (value: any) => { delete value.input_token_details.cached_tokens_details; return value; }],
  ["cached total mismatch", (value: any) => { value.input_token_details.cached_tokens++; return value; }],
  ["cached exceeds input", (value: any) => { value.input_token_details.cached_tokens = 100; return value; }],
  ["unexpected audio input", (value: any) => { value.input_token_details.text_tokens--; value.input_token_details.audio_tokens = 1; return value; }],
  ["unexpected image input", (value: any) => { value.input_token_details.text_tokens--; value.input_token_details.image_tokens = 1; return value; }],
  ["no audio output", (value: any) => { value.output_token_details.text_tokens = value.output_tokens; value.output_token_details.audio_tokens = 0; return value; }],
] as const) {
  test(`narration usage fails closed for ${name} without discarding original receipt`, async () => {
    const raw = change(structuredClone(usage));
    assert.equal(measuredNarrationQuantities(raw, 1_024), null);
    const data = fixture(input, { events: events => { events.at(-1)!.response.usage = raw; return events; } });
    const result = await generateRealtimeNarration(input, { connect: data.connect });
    assert.equal(result.reviewRequired, true); assert.deepEqual(result.reviewReasons, ["usage_unsupported"]);
    assert.equal(result.measuredTokens, null); assert.deepEqual(result.rawUsage, raw);
    assert.equal(data.connections.length, 1); assert.equal(data.sent.filter(event => event.type === "response.create").length, 1);
  });
}

test("zero-cache usage may omit a breakdown but cannot infer missing token measurements", () => {
  const raw = structuredClone(usage);
  raw.input_token_details.cached_tokens = 0;
  delete (raw.input_token_details as any).cached_tokens_details;
  assert.ok(measuredNarrationQuantities(raw, 1_024));
  delete (raw.input_token_details as any).audio_tokens;
  assert.equal(measuredNarrationQuantities(raw, 1_024), null);
  assert.equal(measuredNarrationQuantities(usage, 200), null, "usage above the explicit output budget needs review");
  assert.equal(measuredNarrationQuantities(usage, NaN), null);
});

test("altered narration is retained for review and is never stamped as verbatim", async () => {
  const data = fixture(input, { transcript: "Added introduction. Read this chapter." });
  const result = await generateRealtimeNarration(input, { connect: data.connect });
  assert.equal(result.reviewRequired, true); assert.deepEqual(result.reviewReasons, ["transcript_mismatch"]);
  assert.ok(result.measuredTokens); assert.deepEqual(result.bytes, pcm);
  assert.equal(result.sourceSha256, sha(input.text));
});

test("only Unicode normalization and whitespace differences are tolerated in transcript review", async () => {
  const request = { ...input, text: "café\n\nchapter" };
  const data = fixture(request, { transcript: "cafe\u0301  chapter" });
  assert.equal((await generateRealtimeNarration(request, { connect: data.connect })).reviewRequired, false);
});

const ambiguous = (error: unknown) => error instanceof AppError && error.code === "narration_transport_ambiguous"
  && !error.message.includes("PRIVATE") && error.details === undefined;
for (const [name, change] of [
  ["wrong response", (events: Events) => { events[1].response_id = "foreign"; return events; }],
  ["wrong output item", (events: Events) => { events[3].item_id = "foreign"; return events; }],
  ["wrong part index", (events: Events) => { events[1].content_index = 1; return events; }],
  ["replayed event", (events: Events) => { events[3].event_id = events[1].event_id; return events; }],
  ["noncanonical base64", (events: Events) => { events[1].delta = "AA??"; return events; }],
  ["empty audio", (events: Events) => events.filter(event => event.type !== "response.output_audio.delta")],
  ["odd PCM length", (events: Events) => { events[1].delta = Buffer.from([1]).toString("base64"); return events; }],
  ["missing audio completion", (events: Events) => events.filter(event => event.type !== "response.output_audio.done")],
  ["missing transcript completion", (events: Events) => events.filter(event => event.type !== "response.output_audio_transcript.done")],
  ["corrupt transcript stream", (events: Events) => { events[6].transcript = "PRIVATE_MISMATCH"; return events; }],
  ["incomplete response", (events: Events) => { events.at(-1)!.response.status = "incomplete"; return events; }],
  ["wrong request metadata", (events: Events) => { events[0].response.metadata = { narrationRequestId: "foreign" }; return events; }],
  ["unrequested second item", (events: Events) => { events.at(-1)!.response.output.push(events.at(-1)!.response.output[0]); return events; }],
  ["final output differs", (events: Events) => { events.at(-1)!.response.output[0].content[0].transcript = "PRIVATE_OTHER"; return events; }],
  ["unexpected tool call", (events: Events) => [{ type: "response.function_call_arguments.delta", event_id: "tool" }, ...events]],
  ["provider error", (events: Events) => [{ type: "error", event_id: "provider", error: { message: "PRIVATE_API_KEY" } }, ...events]],
  ["usage evidence overflow", (events: Events) => { events.at(-1)!.response.usage = { private: "x".repeat(20_000) }; return events; }],
] as const) {
  test(`narration transport refuses ${name} without refund, fallback or a second request`, async () => {
    const data = fixture(input, { events: change });
    await assert.rejects(generateRealtimeNarration(input, { connect: data.connect }), ambiguous);
    assert.equal(data.connections.length, 1); assert.equal(data.sent.filter(event => event.type === "response.create").length, 1);
    assert.equal(data.connection.closed, 1); assert.equal(data.connection.terminated, 1);
  });
}

test("byte, transcript and event limits bound malicious or runaway streams", async () => {
  const changes: ((events: Events) => Events)[] = [
    events => { const delta = Buffer.alloc(512 * 1024).toString("base64"); return [events[0], ...Array.from({ length: Math.ceil(MAX_NARRATION_PCM_BYTES / (512 * 1024)) + 1 },
      (_, index) => ({ ...events[1], event_id: `large_${index}`, delta }))]; },
    events => { events[2].delta = "x".repeat(8_193); return events; },
    events => [events[0], ...Array.from({ length: 20_001 }, (_, index) => ({ type: "rate_limits.updated", event_id: `flood_${index}` }))],
  ];
  for (const change of changes) {
    const data = fixture(input, { events: change });
    await assert.rejects(generateRealtimeNarration(input, { connect: data.connect }), ambiguous);
    assert.equal(data.connections.length, 1);
  }
});

for (const [name, change] of [
  ["wrong model", (session: any) => ({ ...session, model: "gpt-4o-mini-tts" })],
  ["wrong session", (session: any) => ({ ...session, id: "foreign" })],
  ["wrong voice", (session: any) => { session.audio.output.voice = "cedar"; return session; }],
  ["wrong sample rate", (session: any) => { session.audio.output.format.rate = 44_100; return session; }],
  ["unlimited output", (session: any) => ({ ...session, max_output_tokens: "inf" })],
  ["tools enabled", (session: any) => ({ ...session, tools: [{ type: "function" }] })],
] as const) {
  test(`configuration acknowledgement refuses ${name} before response creation`, async () => {
    const data = fixture(input, { session: change });
    await assert.rejects(generateRealtimeNarration(input, { connect: data.connect }), ambiguous);
    assert.equal(data.sent.some(event => event.type === "response.create"), false);
  });
}

test("invalid source, role, voice, speed and budgets never open a connection", async () => {
  for (const change of [{ text: " " }, { text: "x".repeat(1_801) }, { instructions: "x".repeat(1_800) },
    { model: "gpt-6-astra" }, { voice: "fable" }, { speed: 2 }, { maxOutputTokens: Infinity }, { unexpected: true }]) {
    let connects = 0;
    await assert.rejects(generateRealtimeNarration({ ...input, ...change } as never,
      { connect: () => { connects++; throw new Error("must not connect"); } }), (error: unknown) => error instanceof AppError && error.status === 422);
    assert.equal(connects, 0);
  }
  await assert.rejects(generateRealtimeNarration(input, { timeoutMs: 130_001 }), (error: unknown) => error instanceof AppError && error.status === 422);
});

test("default realtime provider is fail-closed even if a server key exists", async () => {
  const oldFlag = process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED; const oldKey = process.env.OPENAI_API_KEY;
  process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = "false"; process.env.OPENAI_API_KEY = "synthetic-not-a-key";
  try { await assert.rejects(generateRealtimeNarration(input), (error: unknown) => error instanceof AppError && error.code === "narration_purchase_disabled"); }
  finally {
    if (oldFlag === undefined) delete process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED; else process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = oldFlag;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});

test("enabled transport without a server key fails before constructing a provider connection", async () => {
  const oldFlag = process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED; const oldKey = process.env.OPENAI_API_KEY;
  process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = "true"; process.env.OPENAI_API_KEY = "";
  try { await assert.rejects(generateRealtimeNarration(input), (error: unknown) => error instanceof AppError && error.code === "speech_provider_not_configured"); }
  finally {
    if (oldFlag === undefined) delete process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED; else process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = oldFlag;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});

test("timeout, abort, closed socket and setup errors remain ambiguous without retry or secret exposure", async () => {
  const timed = fixture(input, { stall: true });
  await assert.rejects(generateRealtimeNarration(input, { connect: timed.connect, timeoutMs: 5 }), ambiguous);
  assert.equal(timed.connections.length, 1);
  const controller = new AbortController(); controller.abort();
  let connects = 0;
  await assert.rejects(generateRealtimeNarration(input, { signal: controller.signal, connect: () => { connects++; return timed.connection as never; } }),
    (error: unknown) => error instanceof AppError && error.code === "narration_cancelled");
  assert.equal(connects, 0);
  for (const mode of ["abort", "close", "error"]) {
    const data = fixture(input, { stall: true }); const active = new AbortController();
    const pending = generateRealtimeNarration(input, { connect: data.connect, signal: active.signal });
    if (mode === "abort") active.abort();
    else if (mode === "close") data.connection.socket.emit("close");
    else data.connection.emit("error", new Error("PRIVATE_WEBSOCKET_ERROR"));
    await assert.rejects(pending, ambiguous); assert.equal(data.connections.length, 1);
  }
  await assert.rejects(generateRealtimeNarration(input, { connect: () => { throw new Error("PRIVATE_SETUP_KEY"); } }), ambiguous);
});
