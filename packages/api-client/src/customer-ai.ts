import { AI_PROVIDERS, type AiProvider } from "@bookworm/api-client/ai-connections";
export const CUSTOMER_TEXT_AGENTS = ["writer", "proofreader", "copyeditor", "consistency", "metadata", "bookbible"] as const;
export type CustomerTextAgent = typeof CUSTOMER_TEXT_AGENTS[number];
export interface CustomerAiSelection { workspaceId: string; bookId: string; connectionId: string; credentialRevision: number; provider: AiProvider; agentType: CustomerTextAgent }
export interface CustomerSourceVersion { chapterId: string; documentVersionId: string; version: number }
export interface CustomerAiOption {
  id: string; provider: AiProvider; agentType: CustomerTextAgent; model: string; upstream: string | null; maxOutputTokens: number;
  platformFee: { mode: "platform_plan" | "per_request_credits"; credits: number }; providerCostStatus: "unknown"; expiresAt: string;
}
export interface CustomerAiPreparation {
  operationId: string; selection: CustomerAiSelection; policyId: string;
  source: { bookId: string; agentType: CustomerTextAgent; chapters: CustomerSourceVersion[]; userInstruction: string | null;
    contextPolicy: { includeBookBible: boolean; includeStyleGuide: boolean; includeRelatedContext: false; semanticTopK: number; maxTokens: number } };
}
export interface CustomerAiSaved extends CustomerAiSelection {
  operationId: string; jobId: string | null; policyId: string; model: string; upstream: string | null; maxOutputTokens: number;
  platformFee: CustomerAiOption["platformFee"]; providerCostStatus: "unknown"; sourceVersions: CustomerSourceVersion[];
  chapterCount: number; contextOmitted: number; createdAt: string; expiresAt: string;
  status: "prepared" | "expired" | "closed" | "queued" | "running" | "succeeded" | "cancelled" | "requires_review";
}
export type CustomerAiReceipt = CustomerAiSaved | { operationId: string; status: "not_found" }
  | { operationId: string; bookId: string; status: "closed_before_prepare" };
export const customerUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const model = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$/u;
const fail = (): never => { throw new Error("Customer AI response could not be verified. Keep the saved request for recovery."); };
const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const id = (value: unknown): value is string => typeof value === "string" && customerUuid.test(value);
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value));
function row(value: unknown, fields: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== fields.split(",").sort().join()) return fail();
  return value as Record<string, unknown>;
}
function fee(value: unknown): CustomerAiOption["platformFee"] {
  const r = row(value, "mode,credits");
  if (!integer(r.credits, 0, 1000000) || (r.mode === "platform_plan" ? r.credits !== 0 : r.mode !== "per_request_credits" || Number(r.credits) <= 0)) return fail();
  return { mode: r.mode as CustomerAiOption["platformFee"]["mode"], credits: Number(r.credits) };
}
function policy(r: Record<string, unknown>) {
  if (!AI_PROVIDERS.includes(r.provider as AiProvider) || !CUSTOMER_TEXT_AGENTS.includes(r.agentType as CustomerTextAgent)
    || typeof r.model !== "string" || !model.test(r.model) || (r.upstream !== null && (typeof r.upstream !== "string" || !model.test(r.upstream)))
    || !integer(r.maxOutputTokens, 1, r.agentType === "bookbible" ? 6000 : 128000) || r.providerCostStatus !== "unknown" || !date(r.expiresAt)) return fail();
  return { provider: r.provider as AiProvider, agentType: r.agentType as CustomerTextAgent, model: r.model, upstream: r.upstream as string | null,
    maxOutputTokens: Number(r.maxOutputTokens), platformFee: fee(r.platformFee), providerCostStatus: "unknown" as const, expiresAt: r.expiresAt };
}
export function parseCustomerAiOptions(value: unknown, actor: string, selection: CustomerAiSelection): CustomerAiOption[] {
  const data = row(value, "viewerId,options");
  if (!id(actor) || data.viewerId !== actor || !Array.isArray(data.options) || data.options.length > 50) return fail();
  const options = data.options.map(value => {
    const r = row(value, "id,provider,agentType,model,upstream,maxOutputTokens,platformFee,providerCostStatus,expiresAt"), p = policy(r);
    if (!id(r.id) || p.provider !== selection.provider || p.agentType !== selection.agentType || Date.parse(p.expiresAt) <= Date.now()
      || p.platformFee.mode !== "platform_plan" || p.platformFee.credits !== 0) return fail();
    return { id: r.id, ...p };
  });
  if (new Set(options.map(o => o.id)).size !== options.length) return fail();
  return options;
}
export function parseCustomerAiReceipt(value: unknown, actor: string, bookId: string, operationId: string): CustomerAiReceipt {
  const data = row(value, "viewerId,receipt");
  if (!id(actor) || !id(bookId) || !id(operationId) || data.viewerId !== actor || !data.receipt || typeof data.receipt !== "object") return fail();
  const status = (data.receipt as Record<string, unknown>).status;
  if (status === "not_found" || status === "closed_before_prepare") {
    const r = row(data.receipt, status === "not_found" ? "operationId,status" : "operationId,status,bookId");
    if (r.operationId !== operationId || (status === "closed_before_prepare" && r.bookId !== bookId)) return fail();
    return status === "not_found" ? { operationId, status } : { operationId, bookId, status };
  }
  const r = row(data.receipt, "operationId,jobId,workspaceId,bookId,connectionId,credentialRevision,policyId,provider,agentType,model,upstream,maxOutputTokens,platformFee,providerCostStatus,sourceVersions,chapterCount,contextOmitted,status,createdAt,expiresAt"), p = policy(r);
  if (r.operationId !== operationId || r.bookId !== bookId || !id(r.workspaceId) || !id(r.connectionId) || !id(r.policyId)
    || !integer(r.credentialRevision, 1, 2147483647) || !integer(r.contextOmitted, 0, 121) || !integer(r.chapterCount, 1, 100)
    || !["prepared", "expired", "closed", "queued", "running", "succeeded", "cancelled", "requires_review"].includes(String(status))
    || (["prepared", "expired", "closed"].includes(String(status)) ? r.jobId !== null : !id(r.jobId))
    || !date(r.createdAt) || Date.parse(r.createdAt) >= Date.parse(p.expiresAt) || !Array.isArray(r.sourceVersions) || r.sourceVersions.length !== r.chapterCount) return fail();
  const sourceVersions = r.sourceVersions.map(value => {
    const s = row(value, "chapterId,documentVersionId,version");
    if (!id(s.chapterId) || !id(s.documentVersionId) || !integer(s.version, 1, 999999999)) return fail();
    return { chapterId: s.chapterId, documentVersionId: s.documentVersionId, version: Number(s.version) };
  });
  if (new Set(sourceVersions.map(s => s.chapterId)).size !== sourceVersions.length) return fail();
  return { ...p, operationId, bookId, jobId: r.jobId as string | null, workspaceId: r.workspaceId, connectionId: r.connectionId,
    credentialRevision: Number(r.credentialRevision), policyId: r.policyId, sourceVersions, chapterCount: Number(r.chapterCount),
    contextOmitted: Number(r.contextOmitted), status: status as CustomerAiSaved["status"], createdAt: r.createdAt };
}
type Transport = (action: string, body: unknown, actor: string, signal: AbortSignal) => Promise<unknown>;
export function customerAiClient(send: Transport) {
  const call = (action: string, body: unknown, actor: string, signal?: AbortSignal) => {
    if (!id(actor)) return Promise.reject(new Error("Recheck the account before continuing."));
    const deadline = AbortSignal.timeout(60_000);
    return send(action, body, actor, signal ? AbortSignal.any([signal, deadline]) : deadline);
  };
  const action = async (kind: string, book: string, operation: string, actor: string, body: object, signal?: AbortSignal) => {
    if (!id(book) || !id(operation)) return fail();
    const r = parseCustomerAiReceipt(await call(kind, body, actor, signal), actor, book, operation);
    if (kind === "close" && !["closed_before_prepare", "closed", "cancelled"].includes(r.status)) return fail();
    if (kind === "recover" && r.status !== "succeeded") return fail();
    return r;
  };
  return {
    listCustomerAiOptions: async (selection: CustomerAiSelection, actor: string, signal?: AbortSignal) =>
      parseCustomerAiOptions(await call("options", selection, actor, signal), actor, selection),
    prepareCustomerAi: async (body: CustomerAiPreparation, option: CustomerAiOption, actor: string, signal?: AbortSignal) => {
      const r = await action("prepare", body.selection.bookId, body.operationId, actor, body, signal);
      if (!("sourceVersions" in r) || r.policyId !== body.policyId || r.policyId !== option.id
        || Object.entries(body.selection).some(([key, value]) => r[key as keyof CustomerAiSaved] !== value)
        || r.model !== option.model || r.upstream !== option.upstream || r.maxOutputTokens !== option.maxOutputTokens
        || r.platformFee.credits !== option.platformFee.credits || r.platformFee.mode !== option.platformFee.mode
        || r.sourceVersions.length !== body.source.chapters.length || r.sourceVersions.some((s, i) => {
          const selected = body.source.chapters[i]; return s.chapterId !== selected.chapterId || s.documentVersionId !== selected.documentVersionId || s.version !== selected.version;
        })) return fail();
      return r;
    },
    getCustomerAiStatus: (book: string, operation: string, actor: string, signal?: AbortSignal) => action("status", book, operation, actor, { operationId: operation }, signal),
    closeCustomerAi: (book: string, operation: string, actor: string, signal?: AbortSignal) => action("close", book, operation, actor, { operationId: operation, bookId: book }, signal),
    recoverCustomerAi: (book: string, operation: string, actor: string, signal?: AbortSignal) => action("recover", book, operation, actor, { operationId: operation }, signal),
    confirmCustomerAi: async (expected: CustomerAiSaved, actor: string, signal?: AbortSignal) => {
      if (expected.status !== "prepared" || Date.parse(expected.expiresAt) <= Date.now()
        || expected.platformFee.mode !== "platform_plan" || expected.platformFee.credits !== 0) return fail();
      const r = await action("confirm", expected.bookId, expected.operationId, actor,
        { operationId: expected.operationId, expectedPlatformFeeCredits: expected.platformFee.credits, consent: true }, signal);
      if (!("sourceVersions" in r) || !r.jobId) return fail();
      // The only permitted difference is the job/state. Preserve the whole
      // reviewed identity, source list, policy, fee and original expiry.
      const immutable = (v: CustomerAiSaved) => { const { jobId: _job, status: _status, ...rest } = v; return JSON.stringify(rest); };
      if (immutable(r) !== immutable(expected)) return fail();
      return r;
    },
  };
}
