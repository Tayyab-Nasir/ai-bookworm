/** Exact, server-priced text-agent quote preparation. Counting is not a hold;
 * author acceptance and the quoted-job transaction are separate operations. */
import { z } from "zod";
import { AppError } from "../errors.js";
import { readTranslationCatalog } from "./translation-catalog.js";
import { quoteUsage, type UsageQuote } from "./usage-pricing.js";

const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const counterReply = z.object({
  inputTokens: z.number().int().positive().max(2_000_000), inputSha256: hash,
  model: z.string().min(1).max(128), maxOutputTokens: z.number().int().positive().max(128_000),
  agentType: z.enum(["writer", "proofreader", "copyeditor", "consistency"]),
}).strict();

export type AiReviewGenerationRequest = {
  jobId: string; workspaceId: string; bookId: string;
  agentType: "writer" | "proofreader" | "copyeditor" | "consistency";
  model: string; maxOutputTokens: number; contextPolicy: Record<string, unknown>;
  input: Record<string, unknown>;
};

export function aiReviewCatalog(raw: string | undefined, now: string) {
  try { return readTranslationCatalog(raw, now); }
  catch { throw new AppError(503, "Usage-priced AI writing is not configured for purchase.", undefined, "ai_review_catalog_unavailable"); }
}

export function availableAiReviewModels(raw: string | undefined, now: string) {
  const catalog = aiReviewCatalog(raw, now);
  return { catalogVersion: catalog.version, models: catalog.entries.map((entry) => ({
    id: entry.id, label: entry.label, model: entry.price.model,
    priceVersion: entry.price.version, policyVersion: entry.policy.version,
  })) };
}

export async function prepareAiReviewQuote(rawCatalog: string | undefined, input: {
  modelId: string; now: string; scope: { jobId: string; workspaceId: string; userId: string; bookId: string };
  request: AiReviewGenerationRequest; allowProviderTokenCounting: boolean;
}, options: { fetcher?: typeof fetch; clock?: () => string } = {}) {
  if (input.allowProviderTokenCounting !== true) throw new AppError(422, "Consent to sending the selected saved context for token counting is required.");
  const now = z.string().datetime().parse(input.now);
  const scope = z.object({ jobId: id, workspaceId: id, userId: id, bookId: id }).strict().parse(input.scope);
  const catalog = aiReviewCatalog(rawCatalog, now);
  const entry = catalog.entries.find((candidate) => candidate.id === input.modelId);
  if (!entry) throw new AppError(422, "Choose an available AI writing model.");
  const request = z.object({
    jobId: id, workspaceId: id, bookId: id,
    agentType: z.enum(["writer", "proofreader", "copyeditor", "consistency"]),
    model: z.string().min(1).max(128), maxOutputTokens: z.number().int().positive().max(128_000),
    contextPolicy: z.record(z.string(), z.unknown()), input: z.record(z.string(), z.unknown()),
  }).strict().parse(input.request);
  if (request.jobId !== scope.jobId || request.workspaceId !== scope.workspaceId || request.bookId !== scope.bookId
    || request.model !== entry.price.model || request.maxOutputTokens !== entry.maxOutputTokens) {
    throw new AppError(422, "AI writing request does not match its selected model or book.");
  }
  const token = process.env.AI_SERVICE_TOKEN?.trim();
  if (!token) throw new AppError(503, "Private AI service authentication is not configured.");
  const base = (process.env.AI_SERVICE_URL ?? `http://127.0.0.1:${process.env.AI_SERVICE_PORT ?? "8000"}`).replace(/\/$/u, "");
  let counted: z.infer<typeof counterReply>;
  try {
    const response = await (options.fetcher ?? fetch)(`${base}/v1/ai/text/quote`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", "x-service-token": token },
      body: JSON.stringify(request),
    });
    const body = await response.text();
    if (!response.ok || Buffer.byteLength(body) > 65_536) throw new Error("count unavailable");
    counted = counterReply.parse(JSON.parse(body));
    if (counted.model !== request.model || counted.maxOutputTokens !== request.maxOutputTokens
      || counted.agentType !== request.agentType) throw new Error("count mismatch");
  } catch { throw new AppError(503, "Could not verify text token usage. No generation or credit reservation was started."); }
  if (counted.inputTokens > entry.maxInputTokens) throw new AppError(422, "AI writing input exceeds the selected model limit.");
  const finishedAt = z.string().datetime().parse((options.clock ?? (() => new Date().toISOString()))());
  const currentCatalog = aiReviewCatalog(rawCatalog, finishedAt);
  if (currentCatalog.version !== catalog.version) throw new AppError(409, "AI writing pricing changed during token counting. Request a fresh quote.");
  const expiresAt = new Date(Math.min(Date.parse(now) + catalog.quoteLifetimeSeconds * 1000, Date.parse(catalog.expiresAt))).toISOString();
  if (Date.parse(finishedAt) < Date.parse(now) || Date.parse(finishedAt) >= Date.parse(expiresAt)) {
    throw new AppError(409, "AI writing quote expired while counting. Request a fresh quote.");
  }
  const quote = quoteUsage({
    scope: { jobId: scope.jobId, workspaceId: scope.workspaceId, userId: scope.userId, inputSha256: counted.inputSha256 }, price: entry.price, policy: entry.policy,
    maximumTokens: [
      { dimension: "text_input", tokens: String(counted.inputTokens) },
      { dimension: "text_cached_input", tokens: String(counted.inputTokens) },
      { dimension: "text_output", tokens: String(entry.maxOutputTokens) },
    ], createdAt: now, expiresAt,
  });
  if (BigInt(quote.reservedCredits) > 2_147_483_647n) throw new AppError(422, "AI writing quote exceeds the credit ledger limit.");
  return { quote: quote as UsageQuote, request, countedInputTokens: counted.inputTokens, maxOutputTokens: entry.maxOutputTokens };
}
