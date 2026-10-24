import { createCipheriv, createDecipheriv, createSecretKey, randomBytes, type KeyObject } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";

export const aiProvider = z.enum(["openai", "anthropic", "google", "openrouter", "xai"]);
export type AiProvider = z.infer<typeof aiProvider>;
export const apiKeyInput = z.string().min(16).max(4096).regex(/^[A-Za-z0-9_\-./+=]+$/u);
const keyId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/u);
const bindingSchema = z.object({
  ownerId: z.string().uuid(), provider: aiProvider, connectionId: z.string().uuid(),
  revision: z.number().int().min(1).max(2_147_483_647),
}).strict();
export type CredentialBinding = z.infer<typeof bindingSchema>;
export type SealedCredential = { keyId: string; nonce: string; ciphertext: string; tag: string };
export interface CredentialVault {
  seal(secret: string, binding: CredentialBinding): SealedCredential;
  open(sealed: SealedCredential, binding: CredentialBinding): Buffer;
}

function unavailable(): AppError { return new AppError(503, "Secure AI key storage is unavailable."); }
function bytes(value: unknown, min: number, max = min): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw unavailable();
  const result = Buffer.from(value, "base64");
  if (result.length < min || result.length > max || result.toString("base64") !== value) { result.fill(0); throw unavailable(); }
  return result;
}
function aad(binding: CredentialBinding, encryptionKeyId: string): Buffer {
  const value = bindingSchema.safeParse(binding);
  if (!value.success || !keyId.safeParse(encryptionKeyId).success) throw unavailable();
  const { ownerId, provider, connectionId, revision } = value.data;
  // PostgreSQL returns canonical lowercase UUIDs even when a caller supplied
  // uppercase hex. Authenticate the UUID identity, not its input spelling.
  return Buffer.from(JSON.stringify(["bookworm-ai-key", 1, encryptionKeyId, ownerId.toLowerCase(), provider, connectionId.toLowerCase(), revision]));
}

/** Server-only key ring. No defaults, database-derived keys, global provider mutation or plaintext fallback. */
export function credentialVault(source: Record<string, string | undefined> = process.env): CredentialVault | null {
  const raw = source.AI_CONNECTION_VAULT_KEYRING_JSON;
  if (!raw?.trim()) return null;
  try {
    if (raw.length > 4096) throw unavailable();
    const config = z.object({ active: keyId, keys: z.record(keyId, z.string()) }).strict().parse(JSON.parse(raw));
    const entries = Object.entries(config.keys);
    if (entries.length < 1 || entries.length > 8 || !Object.hasOwn(config.keys, config.active)) throw unavailable();
    const keys = new Map<string, KeyObject>();
    for (const [id, encoded] of entries) { const value = bytes(encoded, 32); try { keys.set(id, createSecretKey(value)); } finally { value.fill(0); } }
    return {
      seal(secret, binding) {
        if (!apiKeyInput.safeParse(secret).success) throw new AppError(422, "Enter a provider API key without spaces or control characters.");
        const associated = aad(binding, config.active), nonce = randomBytes(12), plaintext = Buffer.from(secret);
        try {
          const cipher = createCipheriv("aes-256-gcm", keys.get(config.active)!, nonce, { authTagLength: 16 });
          cipher.setAAD(associated);
          const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
          return { keyId: config.active, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
        } finally { plaintext.fill(0); }
      },
      open(sealed, binding) {
        // Private worker seam only. Never expose this through a management API.
        // The caller must separately authorize the job owner/revision at dispatch.
        let pending: Buffer | undefined;
        try {
          const associated = aad(binding, sealed.keyId), key = keys.get(sealed.keyId);
          if (!key) throw unavailable();
          const decipher = createDecipheriv("aes-256-gcm", key, bytes(sealed.nonce, 12), { authTagLength: 16 });
          decipher.setAAD(associated); decipher.setAuthTag(bytes(sealed.tag, 16));
          pending = decipher.update(bytes(sealed.ciphertext, 16, 4096));
          return Buffer.concat([pending, decipher.final()]);
        } catch { throw unavailable(); }
        finally { pending?.fill(0); }
      },
    };
  } catch { throw unavailable(); }
}
