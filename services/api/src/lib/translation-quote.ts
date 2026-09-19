import OpenAI from "openai";
import { z } from "zod";
import { createHash } from "node:crypto";
import { AppError } from "../errors.js";
import { quoteCatalogTranslation, readTranslationCatalog } from "./translation-catalog.js";
import { translationProviderRequest, translationRequestHash } from "./translation-generation.js";

type CountRequest = Pick<ReturnType<typeof translationProviderRequest>, "model" | "input">;
export type TranslationTokenCounter = (request: CountRequest) => Promise<unknown>;
const countUnavailable = () => new AppError(503,"Could not verify translation token count. No generation was started.");

export const openAiTranslationTokenCounter: TranslationTokenCounter = async (request) => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw countUnavailable();
  try {
    const client = new OpenAI({apiKey,maxRetries:0,timeout:20000});
    return await client.responses.inputTokens.count(request);
  } catch { throw countUnavailable(); }
};

const language = z.string().regex(/^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/).max(35);
const inputSchema = z.object({
  modelId:z.string().min(1).max(64), text:z.string().min(1).refine((s) => s.trim().length > 0 && Array.from(s).length <= 32000),
  sourceLanguage:language,targetLanguage:language,
  scope:z.object({jobId:z.string().uuid(),workspaceId:z.string().uuid(),userId:z.string().uuid()}).strict(),
}).strict();

/** Internal only: caller must authenticate access and load a saved chapter.
 * Returns a proposal, NOT a hold, accepted purchase or dispatch permission. */
export async function prepareTranslationQuote(rawCatalog: string | undefined, input: z.infer<typeof inputSchema>, options: {
  counter?: TranslationTokenCounter; clock?: () => string;
} = {}) {
  const parsed=inputSchema.safeParse(input);
  if (!parsed.success || parsed.data.sourceLanguage === parsed.data.targetLanguage) throw new AppError(422,"Invalid translation quote input.");
  const safe=parsed.data;
  const clock=options.clock ?? (() => new Date().toISOString());
  const catalog=readTranslationCatalog(rawCatalog,clock());
  const entry=catalog.entries.find((item) => item.id === safe.modelId);
  if (!entry) throw new AppError(422,"Choose an available translation model.");
  const generation={text:safe.text,sourceLanguage:safe.sourceLanguage,targetLanguage:safe.targetLanguage,
    model:entry.price.model,maxOutputTokens:entry.maxOutputTokens};
  const request=translationProviderRequest(generation);
  let counted: unknown;
  try { counted=await (options.counter ?? openAiTranslationTokenCounter)({model:request.model,input:request.input}); }
  catch { throw countUnavailable(); }
  const result=z.object({object:z.literal("response.input_tokens"),input_tokens:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).safeParse(counted);
  if (!result.success) throw countUnavailable();
  const inputSha256=translationRequestHash(generation);
  // Recheck validity AFTER the network response; slow counting cannot extend
  // an expired catalog. No fallback estimate if counting fails or exceeds limits.
  const priced=quoteCatalogTranslation(rawCatalog,{modelId:safe.modelId,scope:{...safe.scope,inputSha256},
    maximumInputTokens:result.data.input_tokens,now:clock()});
  return {...priced, sourceSha256:createHash("sha256").update(safe.text).digest("hex"),
    countedInputTokens:result.data.input_tokens, maxOutputTokens:entry.maxOutputTokens};
}
