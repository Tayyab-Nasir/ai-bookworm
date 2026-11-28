export function safeNext(value: unknown, fallback = "/dashboard"): string {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    if (/[\\\x00-\x20]/.test(decodeURIComponent(value))) return fallback;
    const url = new URL(value, "https://bookworm.invalid");
    if (url.origin !== "https://bookworm.invalid") return fallback;
    if (!/^\/(dashboard|books|assets|community|settings|billing|team|tasks|approvals|referrals|admin)(\/|\?|#|$)/.test(value)) return fallback;
    return value;
  } catch { return fallback; }
}

export function sameOrigin(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  return origin === expectedOrigin && request.headers.get("sec-fetch-site") !== "cross-site";
}

export function validEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128;
}

export function publicUser(user: { id: string; email?: string; user_metadata?: Record<string, unknown> }) {
  const name = user.user_metadata?.display_name;
  return { id: user.id, email: user.email ?? null, displayName: typeof name === "string" ? name : null };
}
