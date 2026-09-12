import Fastify, { type FastifyInstance } from "fastify";
import { loadEnv } from "@bookworm/config";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { makeAuthPlugin } from "./plugins/auth.js";
import { idempotencyPlugin } from "./plugins/idempotency.js";
import { defaultSupabaseFactory, type SupabaseFactory } from "./lib/supabase.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { bookRoutes } from "./routes/books.js";
import { chapterRoutes } from "./routes/chapters.js";
import { bookMemoryRoutes } from "./routes/book-memory.js";
import { assetRoutes } from "./routes/assets.js";
import { folderRoutes } from "./routes/folders.js";
import { collabRoutes } from "./routes/collab.js";
import { teamRoutes } from "./routes/team.js";
import { billingRoutes, stripeWebhookRoutes } from "./routes/billing.js";
import { communityRoutes } from "./routes/community.js";
import { referralRoutes } from "./routes/referrals.js";
import { adminRoutes } from "./routes/admin.js";
import { healthRoutes } from "./routes/health.js";
import { aiRoutes } from "./routes/ai.js";
import { editionRoutes } from "./routes/editions.js";
import { publishingRoutes } from "./routes/publishing.js";
import { accountRoutes } from "./routes/account.js";
import { metadataGenerationRoutes } from "./routes/metadata-generation.js";
import { audiobookRoutes } from "./routes/audiobooks.js";
import { translationRoutes } from "./routes/translations.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { salesRoutes } from "./routes/sales.js";
import { adminPlugin } from "./plugins/admin.js";
import { redactObject } from "./lib/redact.js";
import type { StripeFactory } from "./lib/stripe.js";
import type { ImageGenerator } from "./lib/image-generation.js";
import type { AssetMalwareScanner } from "./lib/asset-scanner.js";

export async function buildApp(
  supabaseFactory: SupabaseFactory = defaultSupabaseFactory,
  opts: { stripeFactory?: StripeFactory; aiFetch?: typeof fetch; renderFetch?: typeof fetch; publishingFetch?: typeof fetch; imageGenerator?: ImageGenerator; assetScanner?: AssetMalwareScanner } = {},
): Promise<FastifyInstance> {
  const env = loadEnv();
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  // Scrub logs (MASTER-BUILD-SPEC 17): never log manuscript text, tokens,
  // secrets, signed URLs. Applies to Fastify's own req/res log lines.
  app.addHook("onSend", async (req) => {
    req.log.info({ req: redactObject({ method: req.method, url: req.url, headers: req.headers }) }, "request");
  });

  healthRoutes(app, supabaseFactory);

  await app.register(async (v1) => {
    await v1.register(errorHandlerPlugin);
    await v1.register(makeAuthPlugin(supabaseFactory));
    await v1.register(idempotencyPlugin);
    await v1.register(adminPlugin);
    workspaceRoutes(v1);
    dashboardRoutes(v1);
    salesRoutes(v1);
    bookRoutes(v1, { assetScanner: opts.assetScanner });
    chapterRoutes(v1);
    bookMemoryRoutes(v1);
    metadataGenerationRoutes(v1, { fetcher: opts.aiFetch });
    aiRoutes(v1, { fetcher: opts.aiFetch });
    audiobookRoutes(v1);
    translationRoutes(v1);
    assetRoutes(v1, { imageGenerator: opts.imageGenerator, assetScanner: opts.assetScanner });
    editionRoutes(v1, { fetcher: opts.renderFetch });
    publishingRoutes(v1, { renderFetcher: opts.renderFetch, publishingFetcher: opts.publishingFetch });
    folderRoutes(v1);
    collabRoutes(v1);
    teamRoutes(v1);
    billingRoutes(v1, opts);
    communityRoutes(v1);
    referralRoutes(v1);
    accountRoutes(v1);
    adminRoutes(v1);
    stripeWebhookRoutes(v1); // own JSON parser keeps raw body for sig check
  }, { prefix: "/v1" });

  return app;
}
