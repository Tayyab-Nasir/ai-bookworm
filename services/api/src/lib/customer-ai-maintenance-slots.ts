/** Explicit service-only slot client. No timer, activation, retries or provider calls. */
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { boundedSupabaseFetch, type SupabaseClient } from "./supabase.js";

const id = z.string().uuid().regex(/^[0-9a-f-]+$/u);
const action = z.enum(["reconcile", "recover_receipt"]);
const version = z.number().int().min(1).max(2_147_483_647);
const timestamp = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u)
  .refine(value => { try { timeKey(value); return true; } catch { return false; } });
const state = z.enum(["pending", "completed", "needs_review"]);
const result = z.enum(["unchanged", "settled", "released", "requires_review"]).nullable();
const attempt = z.object({ attemptId: id, jobId: id, action, state, result }).strict().refine(value =>
  value.state === "completed" ? value.result !== null && (value.action !== "recover_receipt" || value.result === "settled") : value.result === null);
const identity = z.object({ jobId: id, action }).strict();
const acknowledgement = identity.extend({ attemptId: id, version }).strict();
const slotCursor = z.object({ jobId: id, action }).strict();
const observationCursor = z.object({ createdAt: timestamp, attemptId: id }).strict();
const slotRow = z.object({ job_id: id, action, version, attempt_id: id, state, result }).strict()
  .refine(value => value.state === "completed" ? value.result !== null && (value.action !== "recover_receipt" || value.result === "settled") : value.result === null);
const observationRow = z.object({ attempt_id: id, job_id: id, action, slot_version: version,
  result: z.enum(["unchanged", "settled", "released"]), created_at: timestamp }).strict()
  .refine(value => value.action !== "recover_receipt" || value.result === "settled");
const openResponse = z.union([z.object({ status: z.literal("not_actionable") }).strict(),
  z.object({ status: z.literal("open"), version, attempt }).strict()]);
const ackResponse = z.object({ status: z.literal("observed"), attemptId: id, version,
  result: z.enum(["unchanged", "settled", "released"]) }).strict();

// Compare timestamps without truncating PostgreSQL's microsecond precision.
function timeKey(value: string): bigint {
  const day = value.slice(0, 10), dayMillis = Date.parse(day + "T00:00:00Z");
  if (!Number.isFinite(dayMillis) || new Date(dayMillis).toISOString().slice(0, 10) !== day) throw new Error();
  const suffix = value.match(/([+-]\d{2})(?::?(\d{2}))?$/u);
  const normalized = suffix ? value.slice(0, -suffix[0].length) + suffix[1] + ":" + (suffix[2] ?? "00") : value;
  const ms = Date.parse(normalized); if (!Number.isFinite(ms)) throw new Error();
  const fractional = value.match(/\.(\d{1,6})/u)?.[1] ?? "";
  return BigInt(ms) * 1_000n + BigInt(fractional.padEnd(6, "0").slice(3));
}
function compareSlots(a: { jobId: string; action: string }, b: { jobId: string; action: string }) {
  return a.jobId === b.jobId ? (a.action < b.action ? -1 : a.action > b.action ? 1 : 0) : a.jobId < b.jobId ? -1 : 1;
}
function compareObservations(a: { createdAt: string; attemptId: string }, b: { createdAt: string; attemptId: string }) {
  const left = timeKey(a.createdAt), right = timeKey(b.createdAt);
  return left === right ? (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0) : left < right ? -1 : 1;
}

export type CustomerAiSlotIdentity = z.infer<typeof identity>;
export type CustomerAiSlotAcknowledgement = z.infer<typeof acknowledgement>;
export type CustomerAiSlotCursor = z.infer<typeof slotCursor>;
export type CustomerAiObservationCursor = z.infer<typeof observationCursor>;
type Outcome<T, I> = { status: "confirmed"; value: T } | { status: "unknown"; request: I };
type SlotRow = z.infer<typeof slotRow>;
type ObservationRow = z.infer<typeof observationRow>;

export function customerAiMaintenanceSlots(config: {
  databaseUrl: string; serviceRoleKey: string; mode?: "development" | "test" | "production";
  allowLoopbackHttp?: boolean; databaseFetch?: typeof fetch;
}) {
  const invalid = () => new Error("Customer AI maintenance slot configuration is invalid.");
  const lifetime = new AbortController(); let sb: SupabaseClient;
  try {
    if (!config || typeof config.databaseUrl !== "string" || config.databaseUrl !== config.databaseUrl.trim()
      || typeof config.serviceRoleKey !== "string" || !/^[A-Za-z0-9_./+=-]{16,4096}$/u.test(config.serviceRoleKey)
      || (config.allowLoopbackHttp !== undefined && typeof config.allowLoopbackHttp !== "boolean")
      || (config.allowLoopbackHttp === true && !["development", "test"].includes(config.mode ?? ""))) throw invalid();
    const url = new URL(config.databaseUrl), loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
      || !(url.protocol === "https:" || (config.allowLoopbackHttp === true && loopback && url.protocol === "http:"))) throw invalid();
    sb = createClient(url.origin, config.serviceRoleKey, { db: { retry: false },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: boundedSupabaseFetch(lifetime.signal, config.databaseFetch) } });
  } catch { lifetime.abort(); throw invalid(); }
  let closed = false;
  async function call<T, I>(name: string, args: Record<string, unknown>, validate: (data: unknown) => T, request: I, signal?: AbortSignal): Promise<Outcome<T, I>> {
    if (closed || (signal !== undefined && !(signal instanceof AbortSignal))) throw new Error("Customer AI maintenance slots are unavailable.");
    if (signal?.aborted) return { status: "unknown", request };
    const deadline = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
    let abort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new Error()); deadline.addEventListener("abort", abort, { once: true }); if (deadline.aborted) abort(); });
      const response = await Promise.race([sb.rpc(name, args).abortSignal(deadline), interrupted]);
      if (deadline.aborted || response.error) throw new Error();
      return { status: "confirmed", value: validate(response.data) };
    } catch { return { status: "unknown", request }; }
    finally { if (abort) deadline.removeEventListener("abort", abort); }
  }
  return {
    async open(value: CustomerAiSlotIdentity, signal?: AbortSignal) {
      const parsed = identity.safeParse(value); if (!parsed.success) throw new Error("Customer AI maintenance slots are unavailable.");
      const saved = parsed.data;
      return call("open_customer_ai_maintenance_slot", { p_job_id: saved.jobId, p_action: saved.action }, data => {
        const result = openResponse.parse(data);
        if (result.status === "open" && (result.attempt.jobId !== saved.jobId || result.attempt.action !== saved.action)) throw new Error();
        return result;
      }, saved, signal);
    },
    async ack(value: CustomerAiSlotAcknowledgement, signal?: AbortSignal) {
      const parsed = acknowledgement.safeParse(value); if (!parsed.success) throw new Error("Customer AI maintenance slots are unavailable.");
      const saved = parsed.data;
      return call("ack_customer_ai_maintenance_slot", { p_job_id: saved.jobId, p_action: saved.action, p_attempt_id: saved.attemptId, p_version: saved.version }, data => {
        const result = ackResponse.parse(data);
        if (result.attemptId !== saved.attemptId || result.version !== saved.version || (saved.action === "recover_receipt" && result.result !== "settled")) throw new Error();
        return result;
      }, saved, signal);
    },
    async listSlots(input: { limit: number; cursor?: CustomerAiSlotCursor }, signal?: AbortSignal) {
      const parsed = z.object({ limit: z.number().int().min(1).max(100), cursor: slotCursor.optional() }).strict().safeParse(input);
      if (!parsed.success) throw new Error("Customer AI maintenance slots are unavailable.");
      const { limit, cursor } = parsed.data;
      return call("list_customer_ai_maintenance_slots", { p_limit: limit, p_after_job_id: cursor?.jobId ?? null, p_after_action: cursor?.action ?? null }, data => {
        const rows: SlotRow[] = z.array(slotRow).max(limit).parse(data);
        if (new Set(rows.map(item => item.attempt_id)).size !== rows.length) throw new Error();
        let previous = cursor;
        for (const item of rows) { const current = { jobId: item.job_id, action: item.action };
          if (previous && compareSlots(previous, current) >= 0) throw new Error(); previous = current; }
        return { rows, nextCursor: rows.length === limit ? previous! : null };
      }, parsed.data, signal);
    },
    async listObservations(input: { limit: number; cursor?: CustomerAiObservationCursor }, signal?: AbortSignal) {
      const parsed = z.object({ limit: z.number().int().min(1).max(100), cursor: observationCursor.optional() }).strict().safeParse(input);
      if (!parsed.success) throw new Error("Customer AI maintenance slots are unavailable.");
      const { limit, cursor } = parsed.data;
      return call("list_customer_ai_maintenance_observations", { p_limit: limit, p_after_created_at: cursor?.createdAt ?? null, p_after_attempt_id: cursor?.attemptId ?? null }, data => {
        const rows: ObservationRow[] = z.array(observationRow).max(limit).parse(data);
        if (new Set(rows.map(item => item.attempt_id)).size !== rows.length
          || new Set(rows.map(item => JSON.stringify([item.job_id, item.action, item.slot_version]))).size !== rows.length) throw new Error();
        let previous = cursor;
        for (const item of rows) { const current = { createdAt: item.created_at, attemptId: item.attempt_id };
          if (previous && compareObservations(previous, current) >= 0) throw new Error(); previous = current; }
        return { rows, nextCursor: rows.length === limit ? previous! : null };
      }, parsed.data, signal);
    },
    close() { closed = true; lifetime.abort(); },
  };
}
