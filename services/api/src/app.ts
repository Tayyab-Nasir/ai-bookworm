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
import { folderRoutes } from "./routes/folders.js";
import { collabRoutes } from "./routes/collab.js";
import { teamRoutes } from "./routes/team.js";
import { billingRoutes, stripeWebhookRoutes } from "./routes/billing.js";
import type { StripeFactory } from "./lib/stripe.js";

export async function buildApp(
  supabaseFactory: SupabaseFactory = defaultSupabaseFactory,
  opts: { stripeFactory?: StripeFactory } = {},
): Promise<FastifyInstance> {
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
    folderRoutes(v1);
    collabRoutes(v1);
    teamRoutes(v1);
    billingRoutes(v1, opts);
    stripeWebhookRoutes(v1); // own JSON parser keeps raw body for sig check
  }, { prefix: "/v1" });

  return app;
}
