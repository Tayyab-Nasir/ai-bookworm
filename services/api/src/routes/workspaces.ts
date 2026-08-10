import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";

const createSchema = z.object({
  name: z.string().min(1),
  orgName: z.string().min(1).optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
});

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "workspace";

export function workspaceRoutes(app: FastifyInstance) {
  // RLS-aware client: only workspaces visible to the user come back.
  app.get("/workspaces", async (req) => {
    const { data, error } = await app.supabaseFactory(req.userToken).from("workspaces").select("*");
    if (error) throw new AppError(500, error.message);
    return { workspaces: data };
  });

  // Create = org + workspace + member via service role (RLS would block org insert).
  // Checks are explicit; ordered inserts are the compensation strategy (ponytail:
  // no multi-statement tx via PostgREST — upgrade path is an RPC function).
  app.post("/workspaces", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid request", { issues: parsed.error.issues });
    const { name, orgName, slug } = parsed.data;
    const sb = app.supabaseFactory(); // service role

    const wsSlug = slug ?? slugify(name);
    const org = await sb.from("organizations")
      .insert({ name: orgName ?? `${name} Org`, slug: `${slugify(orgName ?? name)}-${Date.now().toString(36)}`, owner_user_id: req.userId })
      .select().single();
    if (org.error) throw new AppError(422, org.error.message);

    const ws = await sb.from("workspaces")
      .insert({ organization_id: org.data.id, name, slug: wsSlug, created_by: req.userId })
      .select().single();
    if (ws.error) {
      await sb.from("organizations").delete().eq("id", org.data.id); // compensate
      if (ws.error.code === "23505") throw new AppError(409, "workspace slug already exists");
      throw new AppError(422, ws.error.message);
    }

    const member = await sb.from("workspace_members")
      .insert({ workspace_id: ws.data.id, user_id: req.userId, role: "owner", status: "active" });
    if (member.error) {
      await sb.from("workspaces").delete().eq("id", ws.data.id);
      await sb.from("organizations").delete().eq("id", org.data.id);
      throw new AppError(500, member.error.message);
    }

    return reply.status(201).send(ws.data);
  });
}
