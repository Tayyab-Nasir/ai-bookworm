import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  orgName: z.string().trim().min(1).max(160).optional(),
  slug: z.string().max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).optional(),
}).strict();

export function workspaceRoutes(app: FastifyInstance) {
  // RLS-aware client: only workspaces visible to the user come back.
  app.get("/workspaces", async (req) => {
    const { data, error } = await app.supabaseFactory(req.userToken).from("workspaces").select("*");
    if (error) throw new AppError(500, error.message);
    return { workspaces: data };
  });

  // A single database transaction creates the org/workspace AND both owner
  // memberships. User-scoped RPC derives auth.uid(); no trusted owner id or
  // service role is exposed to this flow. Failure leaves no partial tenant.
  app.post("/workspaces", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid request", { issues: parsed.error.issues });
    const { data, error } = await app.supabaseFactory(req.userToken)
      .rpc("create_workspace_with_owner", {
        p_name: parsed.data.name,
        p_org_name: parsed.data.orgName ?? null,
        p_slug: parsed.data.slug ?? null,
      }).single();
    if (error) {
      if (error.code === "23505") throw new AppError(409, "workspace already exists");
      if (error.code === "42501") throw new AppError(403, "workspace creation not permitted");
      if (error.code === "22023") throw new AppError(422, "invalid workspace details");
      if (error.code === "PGRST202" || error.code === "42883") {
        throw new AppError(503, "workspace onboarding is not installed; apply the pending database migrations");
      }
      req.log.error({ code: error.code }, "workspace transaction failed");
      throw new AppError(500, "workspace could not be created; no partial workspace was saved");
    }
    if (!data) throw new AppError(500, "workspace creation returned no result");
    return reply.status(201).send(data);
  });
}
