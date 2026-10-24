import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { aiProvider, apiKeyInput, credentialVault, type CredentialVault } from "../lib/ai-connection-vault.js";
import { boundedSupabaseFetch } from "../lib/supabase.js";

const mutation = z.object({ connectionId: z.string().uuid().transform(value => value.toLowerCase()), operationId: z.string().uuid().transform(value => value.toLowerCase()), expectedRevision: z.number().int().min(1).max(2_147_483_646).nullable() }).strict();
const saveInput = mutation.extend({ apiKey: apiKeyInput }).strict();
const recoveryInput = mutation.extend({ action: z.enum(["save", "revoke"]) }).strict();
const stored = z.object({
  id: z.string().uuid(), owner_id: z.string().uuid(), provider: aiProvider,
  revision: z.number().int().positive(), status: z.enum(["saved", "revoked"]),
  key_suffix: z.string().regex(/^[A-Za-z0-9_./+=-]{4}$/u).nullable(), last_operation_id: z.string().uuid(),
  created_at: z.string().datetime({ offset: true }), updated_at: z.string().datetime({ offset: true }),
});
const fields = "id,owner_id,provider,revision,status,key_suffix,last_operation_id,created_at,updated_at";
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  // No Zod issue values, raw body, provider error or key fragments in errors.
  if (!result.success) throw new AppError(422, "Check the AI connection fields. Use a provider API key without spaces.");
  return result.data;
}
function actor(req: FastifyRequest): void {
  if (req.headers["x-bookworm-actor"] !== req.userId) throw new AppError(422, "The current account identity is required.");
}
function metadata(value: unknown, owner: string) {
  const result = stored.safeParse(value);
  if (!result.success || result.data.owner_id !== owner || (result.data.status === "saved") !== (result.data.key_suffix !== null)) {
    throw new AppError(503, "AI connection details could not be verified.");
  }
  const row = result.data;
  return { id: row.id, provider: row.provider, revision: row.revision, status: row.status,
    keySuffix: row.key_suffix, lastOperationId: row.last_operation_id, createdAt: row.created_at, updatedAt: row.updated_at };
}
function dbError(error: { code?: string } | null): void {
  if (!error) return;
  if (["40001", "23505"].includes(error.code ?? "")) throw new AppError(409, "This connection changed. Reload its saved status before trying again.");
  if (error.code === "P0429") throw new AppError(429, "Too many connection changes. Wait a minute, then reload.");
  throw new AppError(503, "AI key storage is unavailable. Any submitted change is unconfirmed; reload saved status.");
}

export function aiConnectionRoutes(app: FastifyInstance, options: { vault?: () => CredentialVault | null } = {}) {
  const vault = options.vault ?? credentialVault;
  const config = { bodyLimit: 8192, config: { durableIdempotency: true } };
  // Check is read-only. POST keeps recovery IDs out of URL history; no secrets.
  for (const action of ["check", "close"] as const) app.post(`/account/ai-connections/:provider/${action}`, config, async req => {
    actor(req);
    const provider = parse(aiProvider, (req.params as { provider: unknown }).provider);
    const input = parse(recoveryInput, req.body);
    try {
      const { data, error } = await app.supabaseFactory(undefined, boundedSupabaseFetch(AbortSignal.timeout(12_000))).rpc("recover_ai_connection_operation", {
        p_owner_id: req.userId, p_provider: provider, p_connection_id: input.connectionId, p_expected_revision: input.expectedRevision,
        p_operation_id: input.operationId, p_action: input.action, p_close: action === "close",
      });
      dbError(error);
      const receipt = z.object({ ...recoveryInput.shape, provider: aiProvider, revision: z.number().int().positive().nullable(),
        status: z.enum(["not_found", "closed", "saved", "revoked"]) }).safeParse(data);
      if (!receipt.success || receipt.data.connectionId !== input.connectionId || receipt.data.operationId !== input.operationId
        || receipt.data.provider !== provider || receipt.data.expectedRevision !== input.expectedRevision || receipt.data.action !== input.action
        || (["saved", "revoked"].includes(receipt.data.status) ? receipt.data.revision !== (input.expectedRevision ?? 0) + 1
          || receipt.data.status !== (input.action === "save" ? "saved" : "revoked") : receipt.data.revision !== null)
        || (action === "close" && receipt.data.status === "not_found")) throw new AppError(503, "Connection recovery could not be verified.");
      return { viewerId: req.userId, receipt: receipt.data };
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError(503, "Connection recovery is unavailable. Keep the pending change for another status check."); }
  });
  app.get("/account/ai-connections", config, async req => {
    actor(req);
    try {
      const { data, error } = await app.supabaseFactory(req.userToken, boundedSupabaseFetch(AbortSignal.timeout(12_000)))
        .from("ai_connections").select(fields).eq("owner_id", req.userId).order("provider").limit(6);
      dbError(error);
      if (!Array.isArray(data) || data.length > 5) throw new AppError(503, "AI connection details could not be verified.");
      const connections = data.map(row => metadata(row, req.userId));
      if (new Set(connections.map(row => row.provider)).size !== connections.length) throw new AppError(503, "AI connection details could not be verified.");
      let canSave = false;
      try { canSave = vault() !== null; } catch { /* Listing and revocation remain possible when encryption is misconfigured. */ }
      return { viewerId: req.userId, canSave, generationAvailable: false, connections };
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError(503, "AI connection details are unavailable. Reload to check saved status."); }
  });
  for (const method of ["PUT", "DELETE"] as const) app.route({
    ...config, method, url: "/account/ai-connections/:provider",
    handler: async req => {
      actor(req);
      const provider = parse(aiProvider, (req.params as { provider: unknown }).provider);
      const input: z.infer<typeof mutation> & { apiKey?: string } = method === "PUT" ? parse(saveInput, req.body) : parse(mutation, req.body);
      // Release the request body's reference before awaiting remote work. JS
      // strings cannot be securely zeroized; no persistence/logging is allowed.
      req.body = undefined;
      try {
        const transport = boundedSupabaseFetch(AbortSignal.timeout(12_000));
        let envelope: ReturnType<CredentialVault["seal"]> | undefined;
        let suffix: string | undefined;
        if (method === "PUT" && input.apiKey !== undefined) {
          const keyVault = vault();
          if (!keyVault) throw new AppError(503, "Secure AI key storage is not configured yet.");
          envelope = keyVault.seal(input.apiKey, { ownerId: req.userId, provider, connectionId: input.connectionId, revision: (input.expectedRevision ?? 0) + 1 });
          suffix = input.apiKey.slice(-4);
          input.apiKey = "";
        }
        const { data, error } = await app.supabaseFactory(undefined, transport).rpc("mutate_ai_connection", {
          p_owner_id: req.userId, p_provider: provider, p_connection_id: input.connectionId,
          p_expected_revision: input.expectedRevision, p_operation_id: input.operationId, p_action: method === "PUT" ? "save" : "revoke",
          ...(envelope ? { p_key_suffix: suffix, p_key_id: envelope.keyId, p_nonce: envelope.nonce, p_ciphertext: envelope.ciphertext, p_auth_tag: envelope.tag } : {}),
        });
        dbError(error);
        const connection = metadata(Array.isArray(data) && data.length === 1 ? data[0] : data, req.userId);
        if (connection.id !== input.connectionId || connection.provider !== provider || connection.revision !== (input.expectedRevision ?? 0) + 1
          || connection.lastOperationId !== input.operationId || connection.status !== (method === "PUT" ? "saved" : "revoked")) {
          throw new AppError(503, "The connection change could not be confirmed. Reload saved status.");
        }
        return { viewerId: req.userId, connection };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(503, "The connection change could not be confirmed. Reload saved status.");
      } finally { if ("apiKey" in input) input.apiKey = ""; }
    },
  });
}
