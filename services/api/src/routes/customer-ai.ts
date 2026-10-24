/** Authenticated durable customer-key request workflow. Creation is disabled
 * without an explicitly configured preparation dependency. No key resolution,
 * provider invocation, automatic queue activation, price/default policy here.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { customerDispatchScope } from "../lib/customer-ai-dispatch.js";
import type { customerAiPreparation } from "../lib/customer-ai-prepare.js";
import { customerSourceInput } from "../lib/customer-ai-source.js";
import { boundedSupabaseFetch } from "../lib/supabase.js";

const id = z.string().uuid().regex(/^[a-f0-9-]+$/u);
const revision = z.number().int().min(1).max(2147483647);
const fee = z.object({ mode: z.enum(["platform_plan", "per_request_credits"]), credits: z.number().int().min(0).max(1000000) }).strict()
  .refine(value => value.mode === "platform_plan" ? value.credits === 0 : value.credits > 0);
const selection = z.object({ workspaceId: id, bookId: id, connectionId: id, credentialRevision: revision,
  provider: customerDispatchScope.shape.provider, agentType: customerDispatchScope.shape.agentType }).strict();
const preparation = z.object({ operationId: id, selection, policyId: id, source: customerSourceInput }).strict();
const option = z.object({ id, provider: customerDispatchScope.shape.provider, agentType: customerDispatchScope.shape.agentType,
  policy: customerDispatchScope.shape.policy, platformFee: fee, expiresAt: z.string().datetime({ offset: true }) }).strict();
const saved = z.object({ operationId: id, jobId: id.nullable(), workspaceId: id, bookId: id, connectionId: id,
  credentialRevision: revision, policyId: id, provider: customerDispatchScope.shape.provider, agentType: customerDispatchScope.shape.agentType,
  model: customerDispatchScope.shape.policy.shape.model, maxOutputTokens: z.number().int().min(1).max(128000),
  platformFee: fee, providerCostStatus: z.literal("unknown"), contextOmitted: z.number().int().min(0).max(121),
  chapterCount: z.number().int().min(1).max(100), status: z.enum(["prepared", "expired", "closed", "queued", "running", "succeeded", "cancelled", "requires_review"]),
  createdAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }) }).strict()
  .refine(row => ["prepared", "expired", "closed"].includes(row.status) ? row.jobId === null : row.jobId !== null);
const receipt = z.union([saved, z.object({ operationId: id, status: z.literal("not_found") }).strict()]);
const operation = z.object({ operationId: id }).strict();
const confirmation = operation.extend({ expectedPlatformFeeCredits: z.number().int().min(0).max(1000000), consent: z.literal(true) }).strict();
export type CustomerAiPreparation = ReturnType<typeof customerAiPreparation>;

function input<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(422, "Review the saved source, connection and request fields.");
  return result.data;
}
const unavailable = () => new AppError(503, "Customer AI request outcome is unconfirmed. Check its saved status before trying again.");
function actor(req: FastifyRequest) {
  if (req.headers["x-bookworm-actor"] !== req.userId) throw new AppError(422, "The current account identity is required.");
  if (req.url.includes("?")) throw new AppError(422, "Customer AI request fields belong in the request body.");
}
function checkedReceipt(value: unknown, operationId: string) {
  const parsed = receipt.safeParse(value);
  if (!parsed.success || parsed.data.operationId !== operationId) throw unavailable();
  return parsed.data;
}

export function customerAiRoutes(app: FastifyInstance, options: { preparation?: CustomerAiPreparation } = {}) {
  const preparer = options.preparation;
  const config = { bodyLimit: 131072, config: { durableIdempotency: true } };
  const enabled = () => { if (!preparer) throw new AppError(503, "Customer-key generation is not activated."); return preparer; };
  async function rpc(name: string, args: Record<string, unknown>) {
    try {
      const { data, error } = await app.supabaseFactory(undefined, boundedSupabaseFetch(AbortSignal.timeout(15_000))).rpc(name, args);
      if (error) {
        if (["40001", "23505"].includes(error.code)) throw new AppError(409, "This request changed or cannot safely advance. Check its saved status.");
        if (error.code === "42501") throw new AppError(403, "Current account and book access are required.");
        if (error.code === "23514") {
          if (args.p_action === "recover") throw new AppError(409, "The saved provider receipt could not be accepted. Keep this request for review.");
          throw new AppError(403, "A current approved policy, paid access and available allowance or credits are required.");
        }
        if (error.code === "22023") throw new AppError(422, "Review the request and confirm its exact platform fee and provider charges.");
        if (error.code === "P0429") throw new AppError(429, "Too many preparations. Wait before creating another request.");
        if (error.code === "P0002") throw new AppError(404, "Saved customer request not found.");
        throw unavailable();
      }
      return data as unknown;
    } catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
  }
  async function policies(owner: string, selected: z.infer<typeof selection>) {
    const values = z.array(option).max(50).safeParse(await rpc("customer_ai_preparation_options", {
      p_owner_id: owner, p_workspace_id: selected.workspaceId, p_book_id: selected.bookId,
      p_connection_id: selected.connectionId, p_revision: selected.credentialRevision, p_agent_type: selected.agentType,
    }));
    if (!values.success || new Set(values.data.map(row => row.id)).size !== values.data.length
      || values.data.some(row => row.provider !== selected.provider || row.agentType !== selected.agentType || Date.parse(row.expiresAt) <= Date.now())) throw unavailable();
    return values.data;
  }
  app.post("/account/customer-ai/options", config, async req => {
    actor(req); enabled(); const selected = input(selection, req.body); req.body = undefined;
    const values = await policies(req.userId, selected);
    return { viewerId: req.userId, options: values.map(row => ({ id: row.id, provider: row.provider, agentType: row.agentType,
      model: row.policy.model, maxOutputTokens: row.agentType === "bookbible" ? Math.min(row.policy.maxOutputTokens, 6000) : row.policy.maxOutputTokens,
      upstream: row.policy.upstream, platformFee: row.platformFee, providerCostStatus: "unknown" as const, expiresAt: row.expiresAt })) };
  });
  app.post("/account/customer-ai/prepare", config, async req => {
    actor(req); const service = enabled(), value = input(preparation, req.body); req.body = undefined;
    if (value.source.bookId !== value.selection.bookId || value.source.agentType !== value.selection.agentType) throw new AppError(422, "Source and AI selection must match.");
    const selected = (await policies(req.userId, value.selection)).find(row => row.id === value.policyId);
    if (!selected) throw new AppError(409, "The selected policy is no longer available. Reload the options.");
    const prepared = await service.prepare({ userId: req.userId, accessToken: req.userToken }, value.source,
      { provider: selected.provider, policy: selected.policy });
    if (prepared.source.ownerId !== req.userId || prepared.source.workspaceId !== value.selection.workspaceId
      || prepared.source.bookId !== value.source.bookId || prepared.source.agentType !== value.source.agentType
      || prepared.provider !== selected.provider || prepared.model !== selected.policy.model) throw unavailable();
    const result = checkedReceipt(await rpc("prepare_customer_ai_request", {
      p_operation_id: value.operationId, p_owner_id: req.userId, p_workspace_id: prepared.source.workspaceId, p_book_id: prepared.source.bookId,
      p_connection_id: value.selection.connectionId, p_revision: value.selection.credentialRevision, p_policy_id: selected.id,
      p_request_sha256: prepared.requestSha256, p_request: prepared.source.request, p_sources: prepared.source.sourceVersions,
      p_context_omitted: prepared.contextOmitted,
    }), value.operationId);
    if (result.status === "not_found" || result.workspaceId !== value.selection.workspaceId || result.bookId !== value.source.bookId
      || result.connectionId !== value.selection.connectionId || result.credentialRevision !== value.selection.credentialRevision
      || result.policyId !== selected.id || result.provider !== selected.provider || result.agentType !== selected.agentType
      || result.model !== selected.policy.model || result.platformFee.mode !== selected.platformFee.mode || result.platformFee.credits !== selected.platformFee.credits
      || result.maxOutputTokens !== prepared.maxOutputTokens || result.contextOmitted !== prepared.contextOmitted
      || result.chapterCount !== prepared.source.sourceVersions.length) throw unavailable();
    return { viewerId: req.userId, receipt: result };
  });
  for (const action of ["status", "confirm", "cancel", "recover"] as const) app.post(`/account/customer-ai/${action}`, config, async req => {
    actor(req);
    if (action === "confirm") enabled(); // Status/cancel/recovery survive configuration or key revocation.
    const value = action === "confirm" ? input(confirmation, req.body) : input(operation, req.body); req.body = undefined;
    const result = checkedReceipt(await rpc("customer_ai_request_action", {
      p_owner_id: req.userId, p_operation_id: value.operationId, p_action: action,
      p_expected_fee: "expectedPlatformFeeCredits" in value ? value.expectedPlatformFeeCredits : null,
      p_consent: "consent" in value && value.consent === true,
    }), value.operationId);
    if (action !== "status" && result.status === "not_found") throw unavailable();
    if (action === "confirm" && (["prepared", "expired", "closed"].includes(result.status)
      || !("platformFee" in result) || !("expectedPlatformFeeCredits" in value) || result.platformFee.credits !== value.expectedPlatformFeeCredits)) throw unavailable();
    if (action === "cancel" && !["closed", "cancelled"].includes(result.status)) throw unavailable();
    if (action === "recover" && result.status !== "succeeded") throw unavailable();
    return { viewerId: req.userId, receipt: result };
  });
}
