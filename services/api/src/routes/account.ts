import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";

const uuid = z.string().uuid();
const ticketInput = z
  .object({
    category: z.enum([
      "general",
      "technical",
      "billing",
      "publishing",
      "account",
      "privacy",
    ]),
    subject: z.string().trim().min(3).max(160),
    body: z.string().trim().min(10).max(5_000),
  })
  .strict();
const requestInput = z
  .object({
    type: z.enum(["export", "delete"]),
    reason: z.string().trim().max(2_000).optional(),
    confirmation: z.string().max(40).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === "delete" && value.confirmation !== "DELETE MY ACCOUNT") {
      ctx.addIssue({
        code: "custom",
        path: ["confirmation"],
        message: "Type DELETE MY ACCOUNT to submit this request.",
      });
    }
  });

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(422, "Check the submitted fields.", {
      issues: result.error.issues,
    });
  return result.data;
}
export function accountRoutes(app: FastifyInstance) {
  app.get("/support/tickets", async (req) => {
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb
      .from("support_tickets")
      .select("*")
      .eq("user_id", req.userId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new AppError(500, "Could not load support requests.");
    return { viewerId: req.userId, tickets: data ?? [] };
  });

  app.post("/support/tickets", async (req, reply) => {
    const input = parse(ticketInput, req.body);
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb
      .from("support_tickets")
      .insert({
        user_id: req.userId,
        organization_id: null,
        category: input.category,
        subject: input.subject,
        body: input.body,
        status: "open",
        priority: "normal",
      })
      .select("*")
      .single();
    if (error || !data)
      throw new AppError(500, "Could not create the support request.");
    return reply.status(201).send({ viewerId: req.userId, ticket: data });
  });

  app.get("/account/data-requests", async (req) => {
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb
      .from("data_rights_requests")
      .select("*")
      .eq("user_id", req.userId)
      .order("requested_at", { ascending: false })
      .limit(50);
    if (error) throw new AppError(500, "Could not load data requests.");
    return { viewerId: req.userId, requests: data ?? [] };
  });

  app.post("/account/data-requests", async (req, reply) => {
    const input = parse(requestInput, req.body);
    const sb = app.supabaseFactory(req.userToken);
    // Delete intake is mediated by an authenticated database RPC that checks
    // confirmation itself. No fallback to the old direct INSERT is safe.
    const { data, error } = input.type === "delete"
      ? await sb.rpc("submit_delete_data_rights_request", {
          p_confirmation: input.confirmation,
          p_reason: input.reason || null,
        })
      : await sb.from("data_rights_requests").insert({
          user_id: req.userId,
          request_type: "export",
          status: "submitted",
          reason: input.reason || null,
        }).select("*").single();
    if (error?.code === "23505")
      throw new AppError(409, `An active ${input.type} request already exists.`);
    if (error?.code === "42883" || error?.code === "PGRST202")
      throw new AppError(503, "Data-request migration is not installed.");
    if (error?.code === "22023") throw new AppError(422, "Check the submitted fields.");
    const request = Array.isArray(data) ? data[0] : data;
    if (error || !request || request.user_id !== req.userId || request.request_type !== input.type || request.status !== "submitted")
      throw new AppError(500, "Could not confirm the data request. Check your requests before trying again.");
    return reply.status(201).send({ viewerId: req.userId, request });
  });

  app.delete("/account/data-requests/:requestId", async (req) => {
    const requestId = parse(
      uuid,
      (req.params as { requestId: string }).requestId,
    );
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb.rpc("cancel_data_rights_request", {
      p_request_id: requestId,
    });
    if (error?.code === "P0002")
      throw new AppError(404, "Data request not found.");
    if (error?.code === "22023")
      throw new AppError(409, "Only submitted requests can be cancelled.");
    if (error?.code === "42883" || error?.code === "PGRST202")
      throw new AppError(503, "Data-request migration is not installed.");
    if (error) throw new AppError(500, "Could not cancel the data request.");
    return { viewerId: req.userId, request: Array.isArray(data) ? data[0] : data };
  });
}
