import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { AppError } from "../errors.js";

// ponytail: in-process Map with 24h TTL, swept hourly, capped at 10k entries.
// Ceiling: not shared across instances/restarts. Upgrade path: Redis (REDIS_URL)
// with SET key NX EX 86400 when running >1 API instance.
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const seen = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > TTL_MS) seen.delete(k);
}, 60 * 60 * 1000).unref();

export const idempotencyPlugin = fp(async (app: FastifyInstance) => {
  app.addHook("preHandler", async (req) => {
    if (req.method !== "POST") return;
    const key = req.headers["idempotency-key"] as string | undefined;
    if (!key) return;
    const scoped = `${req.userId ?? "anon"}:${req.url}:${key}`;
    if (seen.has(scoped) && Date.now() - (seen.get(scoped) ?? 0) < TTL_MS) {
      throw new AppError(409, "duplicate Idempotency-Key");
    }
    if (seen.size >= MAX_ENTRIES) throw new AppError(429, "idempotency store full");
    seen.set(scoped, Date.now());
  });
});
