/** Internal transport only. NOT job, billing, membership or credential authorization.
 * A worker must first atomically authorize the payer-bound job, its current lease,
 * owner's exact credential revision and one-way dispatch claim in the database.
 * Nothing imports this into public routes or the managed-AI workers yet.
 */
import { createHmac } from "node:crypto";
import { inspect } from "node:util";
import { z } from "zod";
import { aiProvider, type CredentialBinding } from "./ai-connection-vault.js";

const FORMAT = "bookworm-customer-dispatch-v1";
const MAX_PAYLOAD = 524288;
const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/u);
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$/u);
export const customerDispatchScope = z.object({
  grantId: uuid, jobId: uuid, workspaceId: uuid, bookId: uuid, ownerId: uuid,
  connectionId: uuid, credentialRevision: z.number().int().min(1).max(2147483647), leaseToken: uuid,
  provider: aiProvider, agentType: z.enum(["writer", "proofreader", "copyeditor", "consistency", "metadata", "bookbible"]),
  expectedRequestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  policy: z.object({ model, responseModels: z.array(model).min(1).max(16),
    maxOutputTokens: z.number().int().min(1).max(128000), upstream: model.nullable(),
    responseUpstreams: z.array(z.string().min(1).max(100).regex(/^[\x20-\x7e]+$/u)).max(16),
  }).strict(),
}).strict();
export type CustomerDispatchScope = z.infer<typeof customerDispatchScope>;
export class CustomerDispatchError extends Error {
  constructor() { super("Customer dispatch could not be prepared. No request was sent."); }
}

function jsonTree(value: unknown, depth = 0): void {
  if (depth > 30) throw new CustomerDispatchError();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (Buffer.from(value, "utf8").toString("utf8") !== value) throw new CustomerDispatchError();
    return;
  }
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
  if (Array.isArray(value)) { for (const item of value) jsonTree(item, depth + 1); return; }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Buffer.from(key, "utf8").toString("utf8") !== key || !property.enumerable || !("value" in property)) throw new CustomerDispatchError();
      jsonTree(property.value, depth + 1);
    }
    if (Object.getOwnPropertySymbols(value).length) throw new CustomerDispatchError();
    return;
  }
  throw new CustomerDispatchError();
}

/** Base64 is NOT encryption. Never log/persist the returned wire Buffer.
 * Inspection/JSON serialization are redacted; takeBody is deliberately single use.
 */
export class CustomerDispatchEnvelope {
  #body: Buffer | null;
  constructor(body: Buffer) { this.#body = body; }
  takeBody(): Buffer {
    if (!this.#body) throw new CustomerDispatchError();
    const body = this.#body; this.#body = null; return body;
  }
  dispose(): void { this.#body?.fill(0); this.#body = null; }
  toJSON(): string { return "[private-customer-dispatch]"; }
  [inspect.custom](): string { return this.toJSON(); }
}

/** Sign exact bytes, not cross-language re-serialized JSON. Dedicated 256-bit
 * signing keys are explicit server configuration, not a customer's key/token.
 * This copies the caller's key; dispose invalidates this signer and clears its copy.
 */
export function customerDispatchSigner(keyId: string, signingKey: Buffer, now = () => Math.floor(Date.now() / 1000)) {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(keyId) || !Buffer.isBuffer(signingKey) || signingKey.length !== 32) throw new CustomerDispatchError();
  const key = Buffer.from(signingKey); let disposed = false;
  return {
    dispose() { key.fill(0); disposed = true; },
    sign(scopeInput: CustomerDispatchScope, request: unknown, credential: { binding: CredentialBinding; secret: Buffer }): CustomerDispatchEnvelope {
      let bytes: Buffer | undefined;
      try {
        if (disposed) throw new CustomerDispatchError();
        jsonTree(scopeInput); jsonTree(request);
        const scope = customerDispatchScope.parse(scopeInput), binding = credential.binding;
        if (binding.ownerId.toLowerCase() !== scope.ownerId || binding.provider !== scope.provider ||
            binding.connectionId.toLowerCase() !== scope.connectionId || binding.revision !== scope.credentialRevision ||
            !Buffer.isBuffer(credential.secret) || credential.secret.length < 16 || credential.secret.length > 4096) throw new CustomerDispatchError();
        const apiKey = credential.secret.toString("utf8");
        if (!/^[A-Za-z0-9_\-./+=]+$/u.test(apiKey)) throw new CustomerDispatchError();
        const requestJson = JSON.stringify(request), scopeJson = JSON.stringify(scope);
        if (requestJson.includes(apiKey) || scopeJson.includes(apiKey)) throw new CustomerDispatchError();
        const issuedAt = now();
        if (!Number.isSafeInteger(issuedAt) || issuedAt < 1) throw new CustomerDispatchError();
        bytes = Buffer.from(JSON.stringify({ format: FORMAT, scope, requestJson, apiKey, issuedAt, expiresAt: issuedAt + 60 }), "utf8");
        if (bytes.length > MAX_PAYLOAD) throw new CustomerDispatchError();
        const signature = createHmac("sha256", key).update(FORMAT + "\n" + keyId + "\n").update(bytes).digest("hex");
        return new CustomerDispatchEnvelope(Buffer.from(JSON.stringify({ keyId, payload: bytes.toString("base64url"), signature }), "utf8"));
      } catch { throw new CustomerDispatchError(); }
      finally { bytes?.fill(0); }
    },
  };
}
