/** Book Bible's author-facing, token-counted pricing boundary.
 * Catalogs are server-owned and must be approved; there are no fallback prices.
 */
import { z } from "zod";
import { AppError } from "../errors.js";
import { readTranslationCatalog } from "./translation-catalog.js";
import { quoteUsage, type UsageQuote } from "./usage-pricing.js";

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const textRequest = z.object({
  jobId: uuid, workspaceId: uuid, bookId: uuid, agentType: z.literal("bookbible"),
  model: z.string().min(1).max(128), maxOutputTokens: z.number().int().min(1).max(6000),
  contextPolicy: z.record(z.string(), z.unknown()), input: z.record(z.string(), z.unknown()),
}).strict();
const countReply = z.object({ inputTokens: z.number().int().positive().max(2_000_000), inputSha256: hash,
  model: z.string().min(1).max(128), maxOutputTokens: z.number().int().positive().max(6000), agentType: z.literal("bookbible") }).strict();

export type BookBibleTextRequest = z.infer<typeof textRequest>;

export function bookBibleCatalog(raw: string | undefined, now: string) {
  try { return readTranslationCatalog(raw, now); }
  catch { throw new AppError(503, "Usage-priced Book Bible generation is not configured for purchase.", undefined, "book_bible_catalog_unavailable"); }
}

export function availableBookBibleModels(raw: string | undefined, now: string) {
  const catalog = bookBibleCatalog(raw, now);
  return { catalogVersion: catalog.version, models: catalog.entries.map((entry) => ({
    id: entry.id, label: entry.label, model: entry.price.model,
    maxOutputTokens: Math.min(6000, entry.maxOutputTokens),
    priceVersion: entry.price.version, policyVersion: entry.policy.version,
  })) };
}

export async function prepareBookBibleQuote(rawCatalog: string | undefined, input: {
  modelId: string; now: string; scope: { jobId: string; workspaceId: string; userId: string; bookId: string };
  request: BookBibleTextRequest; allowProviderTokenCounting: boolean;
}, options: { fetcher?: typeof fetch; clock?: () => string } = {}) {
  if (input.allowProviderTokenCounting !== true) throw new AppError(422, "Consent to sending the selected saved manuscript excerpts for token counting is required.");
  const now = z.string().datetime().parse(input.now);
  const scope = z.object({ jobId: uuid, workspaceId: uuid, userId: uuid, bookId: uuid }).strict().parse(input.scope);
  const catalog = bookBibleCatalog(rawCatalog, now);
  const entry = catalog.entries.find((candidate) => candidate.id === input.modelId);
  if (!entry) throw new AppError(422, "Choose an available Book Bible model.");
  const request = textRequest.parse(input.request);
  if (request.jobId !== scope.jobId || request.workspaceId !== scope.workspaceId || request.bookId !== scope.bookId
    || request.model !== entry.price.model || request.maxOutputTokens > entry.maxOutputTokens) {
    throw new AppError(422, "Book Bible request does not match its selected model or book.");
  }
  const token = process.env.AI_SERVICE_TOKEN?.trim();
  if (!token) throw new AppError(503, "Private AI service authentication is not configured.");
  const base = (process.env.AI_SERVICE_URL ?? `http://127.0.0.1:${process.env.AI_SERVICE_PORT ?? "8000"}`).replace(/\/$/u, "");
  let counted: z.infer<typeof countReply>;
  try {
    const response = await (options.fetcher ?? fetch)(`${base}/v1/ai/text/quote`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", "x-service-token": token }, body: JSON.stringify(request),
    });
    const body = await response.text();
    if (!response.ok || Buffer.byteLength(body) > 65_536) throw new Error("count unavailable");
    counted = countReply.parse(JSON.parse(body));
    if (counted.model !== request.model || counted.maxOutputTokens !== request.maxOutputTokens) throw new Error("count identity mismatch");
  } catch { throw new AppError(503, "Could not verify Book Bible token usage. No generation or credit reservation was started."); }
  if (counted.inputTokens > entry.maxInputTokens) throw new AppError(422, "Book Bible input exceeds the selected model limit.");
  const finishedAt = z.string().datetime().parse((options.clock ?? (() => new Date().toISOString()))());
  const currentCatalog = bookBibleCatalog(rawCatalog, finishedAt);
  if (currentCatalog.version !== catalog.version) throw new AppError(409, "Book Bible pricing changed during token counting. Request a fresh quote.");
  const expiresAt = new Date(Math.min(Date.parse(now) + catalog.quoteLifetimeSeconds * 1000, Date.parse(catalog.expiresAt))).toISOString();
  if (Date.parse(finishedAt) < Date.parse(now) || Date.parse(finishedAt) >= Date.parse(expiresAt)) throw new AppError(409, "Book Bible quote expired while counting. Request a fresh quote.");
  const quote = quoteUsage({
    scope: { jobId: scope.jobId, workspaceId: scope.workspaceId, userId: scope.userId, inputSha256: counted.inputSha256 },
    price: entry.price, policy: entry.policy,
    maximumTokens: [{ dimension: "text_input", tokens: String(counted.inputTokens) },
      { dimension: "text_cached_input", tokens: String(counted.inputTokens) },
      { dimension: "text_output", tokens: String(request.maxOutputTokens) }],
    createdAt: now, expiresAt,
  });
  if (BigInt(quote.reservedCredits) > 2_147_483_647n) throw new AppError(422, "Book Bible quote exceeds the credit ledger limit.");
  return { quote: quote as UsageQuote, request, countedInputTokens: counted.inputTokens, maxOutputTokens: request.maxOutputTokens };
}
