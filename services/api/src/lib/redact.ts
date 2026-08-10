// Log scrubber (MASTER-BUILD-SPEC 17): never log manuscript text, tokens,
// secrets, or signed URLs. Deep-clone with sensitive keys nulled.
const SENSITIVE_KEYS = new Set([
  "text", "content", "manuscript", "body", "token", "secret", "password",
  "authorization", "cookie", "x-service-token", "signed_url", "signedUrl",
  "upload_url", "uploadUrl", "api_key", "apiKey",
]);

const SIGNED_URL_RE = /[?&](X-Amz-Signature|Signature|token|sig)=/i;

export function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) return "[redacted]";
  if (typeof value === "string" && SIGNED_URL_RE.test(value)) return "[redacted-url]";
  return value;
}

export function redactObject<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactObject(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactObject(redactValue(k, v));
    }
    return out as T;
  }
  return value;
}
