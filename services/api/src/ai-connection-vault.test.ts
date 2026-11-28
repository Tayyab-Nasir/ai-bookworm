import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { credentialVault } from "./lib/ai-connection-vault.js";
import { redactObject, safeRequestLog } from "./lib/redact.js";
const binding = { ownerId: randomUUID(), provider: "openai" as const, connectionId: randomUUID(), revision: 1 };
const config = (keys: Record<string, string> = { current: randomBytes(32).toString("base64") }, active = "current") => ({ AI_CONNECTION_VAULT_KEYRING_JSON: JSON.stringify({ active, keys }) });

test("vault authenticates every binding field, uses fresh nonces and contains no plaintext", () => {
  const vault = credentialVault(config())!, secret = randomBytes(48).toString("base64url");
  const sealed = vault.seal(secret, binding), another = vault.seal(secret, binding);
  assert.notEqual(sealed.nonce, another.nonce); assert.notEqual(sealed.ciphertext, another.ciphertext);
  assert(!JSON.stringify(sealed).includes(secret));
  const decrypted = vault.open(sealed, binding); assert.equal(decrypted.toString(), secret); decrypted.fill(0);
  const canonical = vault.open(sealed, { ...binding, ownerId: binding.ownerId.toUpperCase(), connectionId: binding.connectionId.toUpperCase() });
  assert.equal(canonical.toString(), secret); canonical.fill(0);
  for (const changed of [{ ...binding, ownerId: randomUUID() }, { ...binding, provider: "anthropic" as const }, { ...binding, connectionId: randomUUID() }, { ...binding, revision: 2 }]) {
    assert.throws(() => vault.open(sealed, changed), /storage is unavailable/);
  }
  for (const field of ["nonce", "ciphertext", "tag"] as const) {
    const bytes = Buffer.from(sealed[field], "base64"); bytes[0] ^= 1;
    assert.throws(() => vault.open({ ...sealed, [field]: bytes.toString("base64") }, binding), /storage is unavailable/);
  }
  assert.throws(() => vault.open({ ...sealed, tag: Buffer.alloc(12).toString("base64") }, binding));
});
test("explicit key rotation can read old envelopes but unknown/retired keys fail closed", () => {
  const old = randomBytes(32).toString("base64"), next = randomBytes(32).toString("base64"), secret = randomBytes(48).toString("hex");
  const sealed = credentialVault(config({ old }, "old"))!.seal(secret, binding);
  const rotated = credentialVault(config({ old, next }, "next"))!;
  assert.equal(rotated.open(sealed, binding).toString(), secret);
  assert.equal(rotated.seal(secret, binding).keyId, "next");
  assert.throws(() => credentialVault(config({ next }, "next"))!.open(sealed, binding));
  assert.throws(() => credentialVault(config({ old: next }, "old"))!.open(sealed, binding));
});
test("missing config disables saving and invalid config never exposes key material", () => {
  assert.equal(credentialVault({}), null);
  for (const raw of ["not-json", JSON.stringify({ active: "missing", keys: {} }), JSON.stringify({ active: "a", keys: { a: "untrusted-private-value" } }), JSON.stringify({ active: "a", keys: { a: randomBytes(31).toString("base64") } })]) {
    assert.throws(() => credentialVault({ AI_CONNECTION_VAULT_KEYRING_JSON: raw }), error => error instanceof Error && error.message === "Secure AI key storage is unavailable.");
  }
  const vault = credentialVault(config())!;
  for (const secret of ["short", "a".repeat(4097), "one\n" + "k".repeat(20), "{" + "x".repeat(40)]) assert.throws(() => vault.seal(secret, binding));
});
test("credential envelopes and camel-case keys are scrubbed and sensitive URL paths are fixed", () => {
  const cleaned = redactObject({ apiKey: "private", API_KEY: "private", ciphertext: "private", auth_tag: "private", uploadUrl: "private", nested: { AI_CONNECTION_VAULT_KEYRING_JSON: "private" } });
  assert(!JSON.stringify(cleaned).includes("private"));
  assert.deepEqual(safeRequestLog({ method: "PUT", url: "/v1/account/ai-connections/private?apiKey=private" }), { method: "PUT", url: "/v1/account/ai-connections/[redacted]" });
});
