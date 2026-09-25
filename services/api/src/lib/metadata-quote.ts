/** Server-only quote preparation. Callers must scope saved input, persist the
 * proposal, obtain author acceptance and atomically fund it before dispatch.
 * This function does not create a job, grant funds, or call generation. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AppError } from "../errors.js";
import { readTranslationCatalog } from "./translation-catalog.js";
import { quoteUsage } from "./usage-pricing.js";

const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unicodeScalarText = (minimum: number, maximum: number) => z.string().min(minimum).max(maximum)
  .refine((value) => Buffer.from(value, "utf8").toString("utf8") === value,
    "Text contains an invalid Unicode surrogate.");
const textNode = z.object({
  id: unicodeScalarText(1, 200), text: unicodeScalarText(1, 30_000), textHash: hash,
  truncated: z.boolean().default(false),
}).strict();
const chapter = z.object({
  id, documentVersionId: id, version: z.number().int().positive(),
  title: unicodeScalarText(0, 500), order: z.number().int().nonnegative(),
  nodes: z.array(textNode).min(1).max(200),
}).strict();

export const metadataQuoteContextSchema = z.object({
  chapterIds: z.array(id).min(1).max(5),
  chapters: z.record(id, chapter),
  book: z.object({ title: unicodeScalarText(1, 500), subtitle: unicodeScalarText(0, 500).nullable(),
    author: unicodeScalarText(0, 500).nullable(), language: unicodeScalarText(1, 40) }).strict(),
  styleGuide: z.record(z.string(), z.unknown()),
  bookBible: z.array(z.record(z.string(), z.unknown())).max(50),
  relatedContext: z.array(z.never()).max(0),
  userInstruction: z.string().min(1).max(2_000),
}).strict().superRefine((value, ctx) => {
  const selected = new Set(value.chapterIds);
  if (selected.size !== value.chapterIds.length || selected.size !== Object.keys(value.chapters).length) {
    ctx.addIssue({ code: "custom", message: "Metadata chapter selection is inconsistent." });
  }
  let totalNodes = 0;
  for (const key of Object.keys(value.chapters)) {
    const source = value.chapters[key]!;
    if (!selected.has(key) || key !== source.id || new Set(source.nodes.map((node) => node.id)).size !== source.nodes.length) {
      ctx.addIssue({ code: "custom", message: "Metadata source identity is inconsistent." });
    }
    totalNodes += source.nodes.length;
    for (const node of source.nodes) {
      // The current metadata contract hashes the exact supplied excerpt, not
      // the whole saved node. Never present this as a full-node citation hash.
      if (createHash("sha256").update(node.text).digest("hex") !== node.textHash) {
        ctx.addIssue({ code: "custom", message: "Metadata excerpt hash does not match its text." });
      }
    }
  }
  if (totalNodes > 200) ctx.addIssue({ code: "custom", message: "Metadata source count exceeds its bound." });
});

const scopeSchema = z.object({ jobId: id, workspaceId: id, userId: id, bookId: id }).strict();
const countSchema = z.object({
  inputTokens: z.number().int().positive().max(2_000_000), inputSha256: hash,
  model: z.string().min(1).max(128), agentType: z.literal("metadata"),
  maxOutputTokens: z.number().int().positive().max(128_000),
}).strict();
const clockTime = (value: string) => Date.parse(z.string().datetime().parse(value));

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Strip object references and reject values that JSON transport would change.
 * Hash only a bounded JSON value, never arbitrary JS objects/getters from HTTP. */
function snapshot(value: unknown): z.output<typeof metadataQuoteContextSchema> {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized) > 131_072) throw new Error("size");
    const parsed = metadataQuoteContextSchema.parse(JSON.parse(serialized));
    if (!isDeepStrictEqual(parsed, value)) throw new Error("noncanonical context");
    return parsed;
  } catch { throw new AppError(422, "Metadata quote requires a bounded, canonical saved source snapshot."); }
}

function catalog(raw: string | undefined, now: string) {
  try { return readTranslationCatalog(raw, now); }
  catch { throw new AppError(503, "Usage-priced metadata is not configured for purchase.", undefined, "metadata_catalog_unavailable"); }
}

export function availableMetadataModels(raw: string | undefined, now: string) {
  const value = catalog(raw, now);
  return { catalogVersion: value.version, models: value.entries.map((entry) => ({
    id: entry.id, label: entry.label, model: entry.price.model,
    priceVersion: entry.price.version, policyVersion: entry.policy.version,
  })) };
}

export async function prepareMetadataQuote(input: {
  rawCatalog: string | undefined; modelId: string; scope: z.infer<typeof scopeSchema>;
  context: unknown; maxTokens: number; allowProviderTokenCounting: boolean;
}, options: { fetcher?: typeof fetch; clock?: () => string } = {}) {
  if (input.allowProviderTokenCounting !== true) throw new AppError(422, "Consent to sending selected metadata context for token counting is required.");
  const clock = options.clock ?? (() => new Date().toISOString());
  const startedAt = clock(); const started = clockTime(startedAt);
  const selectedCatalog = catalog(input.rawCatalog, startedAt);
  const entry = selectedCatalog.entries.find((item) => item.id === input.modelId);
  if (!entry) throw new AppError(422, "Choose an available metadata model.");
  const scope = scopeSchema.safeParse(input.scope);
  const maxTokens = z.number().int().min(4_096).max(16_000).safeParse(input.maxTokens);
  if (!scope.success || !maxTokens.success) throw new AppError(422, "Invalid metadata quote scope or context budget.");
  const context = snapshot(input.context);
  const request = {
    jobId: scope.data.jobId, workspaceId: scope.data.workspaceId, bookId: scope.data.bookId,
    agentType: "metadata" as const, model: entry.price.model, maxOutputTokens: entry.maxOutputTokens,
    contextPolicy: { includeBookBible: true, includeStyleGuide: true, includeRelatedContext: false,
      semanticTopK: 5, maxTokens: maxTokens.data },
    input: context,
  };
  // Serialized before yielding: caller mutations cannot change what is counted
  // or returned for later dispatch/persistence.
  const requestBody = JSON.stringify(request);
  const sourceSha256 = createHash("sha256").update(canonicalJson({
    input: context, contextPolicy: request.contextPolicy,
  })).digest("hex");
  const token = process.env.AI_SERVICE_TOKEN?.trim();
  if (!token) throw new AppError(503, "Private AI service authentication is not configured.");
  const baseUrl = (process.env.AI_SERVICE_URL ?? `http://127.0.0.1:${process.env.AI_SERVICE_PORT ?? "8000"}`).replace(/\/$/, "");
  let counted: z.infer<typeof countSchema>;
  try {
    const response = await (options.fetcher ?? fetch)(`${baseUrl}/v1/ai/text/quote`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", "x-service-token": token }, body: requestBody,
    });
    const text = await response.text();
    if (!response.ok || Buffer.byteLength(text) > 65_536) throw new Error("count unavailable");
    counted = countSchema.parse(JSON.parse(text));
    if (counted.model !== request.model || counted.maxOutputTokens !== request.maxOutputTokens) throw new Error("request mismatch");
  } catch { throw new AppError(503, "Could not verify metadata token usage. No generation or credit reservation was started."); }
  const finishedAt = clock(); const finished = clockTime(finishedAt);
  catalog(input.rawCatalog, finishedAt);
  const expiresAt = new Date(Math.min(started + selectedCatalog.quoteLifetimeSeconds * 1000,
    Date.parse(selectedCatalog.expiresAt))).toISOString();
  if (finished < started || finished >= Date.parse(expiresAt)) throw new AppError(409, "Metadata quote expired while counting. Request a fresh quote.");
  if (counted.inputTokens > entry.maxInputTokens) throw new AppError(422, "Metadata input exceeds the selected model limit.");
  const quote = quoteUsage({
    scope: { jobId: scope.data.jobId, workspaceId: scope.data.workspaceId, userId: scope.data.userId, inputSha256: counted.inputSha256 },
    price: entry.price, policy: entry.policy,
    maximumTokens: [{ dimension: "text_input", tokens: String(counted.inputTokens) },
      { dimension: "text_cached_input", tokens: String(counted.inputTokens) },
      { dimension: "text_output", tokens: String(entry.maxOutputTokens) }],
    createdAt: startedAt, expiresAt,
  });
  if (BigInt(quote.reservedCredits) > 2147483647n) throw new AppError(422, "Metadata quote exceeds ledger capacity.");
  return { catalogVersion: selectedCatalog.version, modelId: entry.id, sourceSha256,
    generationRequest: request, quote };
}
