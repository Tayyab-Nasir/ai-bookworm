import type { FastifyInstance } from "fastify";
import { loadEnv } from "@bookworm/config";
import { boundedSupabaseFetch, type SupabaseFactory } from "../lib/supabase.js";
import { redisReady } from "../lib/redis-readiness.js";

// /health: liveness, no dependencies (orchestrator restart signal).
// /ready: bounded Supabase + authenticated Redis PING; 503 if either fails.

// Registered at root scope, where the supabaseFactory decoration (added in
// the /v1 scope) is not visible — take the factory as a parameter instead.
export function healthRoutes(app: FastifyInstance, supabaseFactory: SupabaseFactory) {
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (req, reply) => {
    const env = loadEnv();
    const checks: Record<string, boolean> = {};
    try {
      // One deadline covers headers and streamed bodies. Supplying the private
      // transport also disables SDK retries, including unbounded Retry-After.
      const signal = AbortSignal.timeout(1_000);
      const { error } = await supabaseFactory(undefined, boundedSupabaseFetch(signal)).from("profiles").select("id").limit(1);
      checks.supabase = !error;
    } catch {
      checks.supabase = false;
    }
    checks.redis = await redisReady(env.REDIS_URL);
    const ready = Object.values(checks).every(Boolean);
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks });
  });
}
