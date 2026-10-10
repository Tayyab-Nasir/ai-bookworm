import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { boundedSupabaseFetch, type SupabaseClient, type SupabaseFactory } from "../lib/supabase.js";
import { AppError } from "../errors.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
    userToken: string;
  }
  interface FastifyInstance {
    supabaseFactory: SupabaseFactory;
  }
}

// Verifies Supabase JWT (Authorization: Bearer) via getUser; attaches request.userId.
export function makeAuthPlugin(supabaseFactory: SupabaseFactory) {
  return fp(async (app: FastifyInstance) => {
    app.decorate("supabaseFactory", supabaseFactory);
    app.addHook("preHandler", async (req) => {
      // Webhook (Stripe-signed) and service-token routes do their own auth.
      if (req.url.startsWith("/v1/webhooks/") || (req.routeOptions.config as { serviceAuth?: boolean } | undefined)?.serviceAuth) return;
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) throw new AppError(401, "missing bearer token");
      const token = header.slice(7);
      if (!token.trim()) throw new AppError(401, "invalid token");
      // One absolute deadline covers the remote identity check and its body.
      // Native fetch/stream cancellation is required; no local JWT shortcut or
      // promise race that abandons an unowned, abort-ignoring dependency.
      const signal = AbortSignal.timeout(12_000);
      const unavailable = () => new AppError(503, "Authentication service is temporarily unavailable.");
      let verified: Awaited<ReturnType<SupabaseClient["auth"]["getUser"]>>;
      try {
        verified = await supabaseFactory(token, boundedSupabaseFetch(signal)).auth.getUser(token);
      } catch {
        // Do not forward/log upstream messages, which may contain credentials.
        throw unavailable();
      }
      const { data, error } = verified;
      if (signal.aborted || (error && (error.name === "AuthRetryableFetchError" || error.name === "AuthUnknownError"
        || error.status === 0 || error.status === 429 || (typeof error.status === "number" && error.status >= 500)))) throw unavailable();
      if (error || !data.user) throw new AppError(401, "invalid token");
      if (typeof data.user.id !== "string" || !data.user.id.trim()) throw unavailable();
      req.userId = data.user.id;
      req.userToken = token;
    });
  });
}
