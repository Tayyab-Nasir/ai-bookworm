import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../lib/admin.js";

// Register inside the /v1 scope (after auth sets req.userId), then wrap
// admin routes: adminRoutes(app) — every route in it requires ADMIN_USER_IDS.
export const adminPlugin = fp(async (app: FastifyInstance) => {
  app.decorate("adminRoutes", (register: (a: FastifyInstance) => void) => {
    app.register(async (scope) => {
      scope.addHook("preHandler", async (req) => requireAdmin(req));
      register(scope);
    });
  });
});

declare module "fastify" {
  interface FastifyInstance {
    adminRoutes: (register: (a: FastifyInstance) => void) => void;
  }
}
