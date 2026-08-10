import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { SupabaseFactory } from "../lib/supabase.js";
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
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) throw new AppError(401, "missing bearer token");
      const token = header.slice(7);
      const { data, error } = await supabaseFactory(token).auth.getUser(token);
      if (error || !data.user) throw new AppError(401, "invalid token");
      req.userId = data.user.id;
      req.userToken = token;
    });
  });
}
