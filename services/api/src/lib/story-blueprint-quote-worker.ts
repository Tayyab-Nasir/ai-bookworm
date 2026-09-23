/**
 * One leased, provider-token-counting step for a Story Blueprint quote.
 * It never generates a proposal, reserves credits, or creates an AI job.
 */
import { z } from "zod";
import type { SupabaseClient } from "./supabase.js";
import { quoteStoryBlueprintUsage, type StoryBlueprintCatalogSnapshot } from "./story-blueprint-pricing.js";
import { storyBlueprintGenerationContextPolicy, storyBlueprintSourceSnapshotSchema } from "./story-blueprint-generation-contract.js";

const id = z.string().uuid();
const bookSnapshotSchema = z.object({
  title: z.string().max(500).refine((value) => value.trim().length > 0),
  author: z.string().max(500),
  language: z.string().max(40).refine((value) => value.trim().length > 0),
}).strict();
const requestSchema = z.object({
  id, user_id: id, workspace_id: id, book_id: id, blueprint_id: id,
  source_revision: z.number().int().min(1), source_snapshot_json: storyBlueprintSourceSnapshotSchema,
  book_snapshot_json: bookSnapshotSchema, catalog_json: z.unknown(), generation_job_id: id,
  lease_token: id, status: z.literal("counting"),
}).passthrough();
const countSchema = z.object({
  inputTokens: z.number().int().positive().max(2_000_000), inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().trim().min(1).max(128),
}).strict();

function firstRow(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

function aiServiceUrl() {
  return (process.env.AI_SERVICE_URL ?? `http://127.0.0.1:${process.env.AI_SERVICE_PORT ?? "8000"}`).replace(/\/$/u, "");
}

function serviceHeaders() {
  return { "content-type": "application/json", ...(process.env.AI_SERVICE_TOKEN ? { "x-service-token": process.env.AI_SERVICE_TOKEN } : {}) };
}

async function countInput(fetcher: typeof fetch, request: z.output<typeof requestSchema>) {
  const catalog = request.catalog_json as StoryBlueprintCatalogSnapshot;
  const response = await fetcher(`${aiServiceUrl()}/v1/ai/story-blueprint/quote`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000), headers: serviceHeaders(),
    body: JSON.stringify({
      jobId: request.generation_job_id, workspaceId: request.workspace_id, bookId: request.book_id,
      model: catalog.model, maxOutputTokens: catalog.maxOutputTokens,
      contextPolicy: storyBlueprintGenerationContextPolicy,
      input: { storyBlueprint: request.source_snapshot_json, book: request.book_snapshot_json },
    }),
  });
  const text = await response.text();
  if (!response.ok || Buffer.byteLength(text, "utf8") > 64_000) throw new Error("Story Blueprint token count unavailable");
  const counted = countSchema.parse(JSON.parse(text));
  if (counted.model !== catalog.model) throw new Error("Story Blueprint token-count model mismatch");
  return counted;
}

export type StoryBlueprintQuoteStepOutcome = {
  status: "idle" | "ready" | "completion_unknown";
  requestId?: string;
};

export async function runOneStoryBlueprintQuoteStep(
  sb: SupabaseClient,
  options: { leaseSeconds?: number; fetcher?: typeof fetch; clock?: () => string } = {},
): Promise<StoryBlueprintQuoteStepOutcome> {
  const leaseSeconds = options.leaseSeconds ?? 180;
  const claimed = await sb.rpc("claim_story_blueprint_quote_request", { p_lease_seconds: leaseSeconds });
  if (claimed.error) throw new Error("Story Blueprint quote claim unavailable");
  const parsed = requestSchema.safeParse(firstRow(claimed.data));
  if (!firstRow(claimed.data)) return { status: "idle" };
  if (!parsed.success) return { status: "completion_unknown" };
  const request = parsed.data;
  try {
    const counted = await countInput(options.fetcher ?? fetch, request);
    const usageQuote = quoteStoryBlueprintUsage(request.catalog_json as StoryBlueprintCatalogSnapshot, {
      scope: {
        jobId: request.generation_job_id, workspaceId: request.workspace_id, userId: request.user_id,
        inputSha256: counted.inputSha256,
      },
      countedInputTokens: counted.inputTokens,
      now: (options.clock ?? (() => new Date().toISOString()))(),
    });
    const created = await sb.rpc("create_story_blueprint_quote_proposal", {
      p_request_id: request.id, p_lease_token: request.lease_token, p_usage_quote: usageQuote,
    });
    if (created.error || !firstRow(created.data)) throw new Error("Story Blueprint quote persistence uncertain");
    return { status: "ready", requestId: request.id };
  } catch {
    // The SQL function only fails a live lease. If this network call is
    // uncertain, its expired lease is terminalized rather than re-counted.
    try {
      await sb.rpc("fail_story_blueprint_quote_request", {
        p_request_id: request.id, p_lease_token: request.lease_token,
      });
    } catch { /* Preserve the lease for SQL's unknown-outcome recovery. */ }
    return { status: "completion_unknown", requestId: request.id };
  }
}
