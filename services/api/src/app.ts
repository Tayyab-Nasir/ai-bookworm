import Fastify, { type FastifyInstance } from "fastify";
import { loadEnv } from "@bookworm/config";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { makeAuthPlugin } from "./plugins/auth.js";
import { idempotencyPlugin } from "./plugins/idempotency.js";
import { defaultSupabaseFactory, type SupabaseFactory } from "./lib/supabase.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { bookRoutes } from "./routes/books.js";
import { chapterRoutes } from "./routes/chapters.js";
import { assetRoutes } from "./routes/assets.js";

export async function buildApp(supabaseFactory: SupabaseFactory = defaultSupabaseFactory): Promise<FastifyInstance> {
  const env = loadEnv();
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(async (v1) => {
    await v1.register(errorHandlerPlugin);
    await v1.register(makeAuthPlugin(supabaseFactory));
    await v1.register(idempotencyPlugin);
    workspaceRoutes(v1);
    bookRoutes(v1);
    chapterRoutes(v1);
    assetRoutes(v1);
  }, { prefix: "/v1" });

  return app;
}
