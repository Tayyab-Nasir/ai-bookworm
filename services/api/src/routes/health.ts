import type { FastifyInstance } from "fastify";
import net from "node:net";
import { loadEnv } from "@bookworm/config";
import type { SupabaseFactory } from "../lib/supabase.js";

// /health: liveness, no dependencies (orchestrator restart signal).
// /ready: Supabase + Redis reachability, 503 if any down (traffic gate).

function redisReachable(url: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let host = "localhost";
    let port = 6379;
    try {
      const u = new URL(url);
      host = u.hostname;
      port = Number(u.port) || 6379;
    } catch {
      /* malformed URL -> default, will fail connect if down */
    }
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => { sock.destroy(); resolve(false); });
  });
}

// Registered at root scope, where the supabaseFactory decoration (added in
// the /v1 scope) is not visible — take the factory as a parameter instead.
export function healthRoutes(app: FastifyInstance, supabaseFactory: SupabaseFactory) {
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (req, reply) => {
    const env = loadEnv();
    const checks: Record<string, boolean> = {};
    try {
      const { error } = await supabaseFactory().from("profiles").select("id").limit(1);
      checks.supabase = !error;
    } catch {
      checks.supabase = false;
    }
    checks.redis = await redisReachable(env.REDIS_URL);
    const ready = Object.values(checks).every(Boolean);
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks });
  });
}
