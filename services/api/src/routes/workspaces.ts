import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { boundedSupabaseFetch } from "../lib/supabase.js";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  orgName: z.string().trim().min(1).max(160).optional(),
  slug: z.string().max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).optional(),
}).strict();
const operationId = z.guid().transform(value => value.toLowerCase());
const onboardingSchema = createSchema.extend({ operationId }).strict();
const receiptInput = z.object({ operationId }).strict();
const receiptResult = z.object({ operationId, status: z.enum(["not_found", "pending", "created", "closed"]), workspaceId: z.guid().nullable() }).strict();
const returnedWorkspace = z.object({ id: z.guid(), created_by: z.guid() }).passthrough();

function verifiedActor(req: FastifyRequest) {
  if (req.headers["x-bookworm-actor"] !== req.userId) throw new AppError(422, "The current account identity is required.");
}

function onboardingError(error: { code?: string } | null) {
  if (!error) return;
  if (error.code === "PT409") throw new AppError(409, "This workspace request is closed or has different details. Check its saved status.");
  if (error.code === "42501") throw new AppError(403, "Workspace creation is not permitted.");
  if (error.code === "22023") throw new AppError(422, "Check the workspace details.");
  throw new AppError(503, "Workspace creation could not be confirmed. Check the original request before trying again.");
}

export function workspaceRoutes(app: FastifyInstance) {
  // RLS-aware client: only workspaces visible to the user come back.
  app.get("/workspaces", async (req) => {
    const { data, error } = await app.supabaseFactory(req.userToken).from("workspaces").select("*");
    if (error) throw new AppError(500, error.message);
    return { workspaces: data };
  });

  // New onboarding requests use their own durable operation identity. The
  // existing /workspaces contract and its legacy idempotency behavior remain.
  const durable = { config: { durableIdempotency: true } };
  app.post("/workspaces/onboarding", durable, async (req, reply) => {
    verifiedActor(req);
    const parsed = onboardingSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Check the workspace details.");
    try {
      const { data, error } = await app.supabaseFactory(req.userToken, boundedSupabaseFetch(AbortSignal.timeout(12_000)))
        .rpc("create_workspace_with_receipt", { p_operation_id: parsed.data.operationId, p_name: parsed.data.name,
          p_org_name: parsed.data.orgName ?? null, p_slug: parsed.data.slug ?? null }).single();
      onboardingError(error);
      const workspace = returnedWorkspace.safeParse(data);
      if (!workspace.success || workspace.data.created_by.toLowerCase() !== req.userId.toLowerCase()) {
        throw new AppError(503, "Workspace creation could not be confirmed. Check the original request before trying again.");
      }
      return reply.status(201).header("cache-control", "no-store").send({ viewerId: req.userId, operationId: parsed.data.operationId, workspace: workspace.data });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, "Workspace creation could not be confirmed. Check the original request before trying again.");
    }
  });

  for (const action of ["check", "close"] as const) app.post(`/workspaces/onboarding/${action}`, durable, async (req, reply) => {
    verifiedActor(req);
    const input = receiptInput.safeParse(req.body);
    if (!input.success) throw new AppError(422, "Check the workspace request.");
    try {
      const { data, error } = await app.supabaseFactory(req.userToken, boundedSupabaseFetch(AbortSignal.timeout(12_000)))
        .rpc("workspace_creation_receipt", { p_operation_id: input.data.operationId, p_close: action === "close" });
      onboardingError(error);
      const result = receiptResult.safeParse(data);
      if (!result.success || result.data.operationId !== input.data.operationId
        || (result.data.status === "created") !== (result.data.workspaceId !== null)
        || (action === "close" && result.data.status === "not_found")) {
        throw new AppError(503, "Workspace request status could not be verified.");
      }
      return reply.header("cache-control", "no-store").send({ viewerId: req.userId, receipt: result.data });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, "Workspace request status is unavailable. Check again before starting another request.");
    }
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
