import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireAdmin } from "../lib/admin.js";
import { transitionReferral } from "../lib/referrals.js";

function requireServiceToken(req: FastifyRequest) {
  const expected = Buffer.from(process.env.SERVICE_AUTH_TOKEN ?? "");
  const header = req.headers["x-service-token"];
  const token = Buffer.from(typeof header === "string" ? header : "");
  if (!expected.length || token.length !== expected.length || !timingSafeEqual(token, expected)) {
    throw new AppError(401, "invalid service token");
  }
}

function referralId(req: FastifyRequest) {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!parsed.success) throw new AppError(422, "invalid referral id");
  return parsed.data.id;
}

export function referralRoutes(app: FastifyInstance) {
  app.get("/referrals/code", async (req) => {
    const { data, error } = await app.supabaseFactory().rpc("get_or_create_referral_code", { p_user_id: req.userId });
    if (error) throw new AppError(500, error.message);
    return data;
  });

  app.get("/referrals", async (req) => {
    const { data, error } = await app.supabaseFactory(req.userToken).from("referrals")
      .select("*").eq("referrer_id", req.userId).order("created_at", { ascending: false })
      .order("id", { ascending: false }).limit(100);
    if (error) throw new AppError(500, error.message);
    return { referrals: data };
  });

  app.get("/referrals/ledger", async (req) => {
    const sb = app.supabaseFactory(req.userToken);
    const [entries, summary] = await Promise.all([
      sb.from("credit_ledger").select("*").eq("user_id", req.userId)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(100),
      sb.rpc("referral_credit_summary", { p_user_id: req.userId }),
    ]);
    if (entries.error || summary.error) throw new AppError(500, (entries.error ?? summary.error)!.message);
    return { entries: entries.data, summary: summary.data };
  });

  app.post("/referrals/claim", async (req, reply) => {
    const parsed = z.object({ code: z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z0-9-]+$/) }).strict().safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid claim", { issues: parsed.error.issues });
    const svc = app.supabaseFactory();
    const { data: code, error: codeError } = await svc.from("referral_codes")
      .select("id,user_id,status").eq("code", parsed.data.code).maybeSingle();
    if (codeError) throw new AppError(500, codeError.message);
    if (!code) throw new AppError(404, "referral code not found");
    if (code.status !== "active") throw new AppError(422, "referral code is not active");
    if (code.user_id === req.userId) throw new AppError(422, "cannot refer yourself", undefined, "self_referral");
    const existing = () => svc.from("referrals").select("*").eq("referred_user_id", req.userId).maybeSingle();
    const { data: dup, error: readError } = await existing();
    if (readError) throw new AppError(500, readError.message);
    if (dup) return { referral: dup, alreadyAttributed: true };
    const { data, error } = await svc.from("referrals")
      .insert({ referrer_id: code.user_id, referred_user_id: req.userId, code_id: code.id, status: "attributed" })
      .select().single();
    if (error) {
      if (error.code === "23505") {
        const winner = await existing();
        if (winner.error) throw new AppError(500, winner.error.message);
        if (winner.data) return { referral: winner.data, alreadyAttributed: true };
      }
      throw new AppError(500, error.message);
    }
    return reply.status(201).send({ referral: data });
  });

  app.post("/referrals/qualify", { config: { serviceAuth: true } }, async (req) => {
    requireServiceToken(req);
    const parsed = z.object({ referredUserId: z.string().uuid() }).strict().safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid qualify request", { issues: parsed.error.issues });
    return transitionReferral(app.supabaseFactory(), "qualify", parsed.data.referredUserId);
  });

  app.post("/referrals/:id/review", async (req) => {
    requireAdmin(req);
    const parsed = z.object({ action: z.enum(["approve", "reject"]) }).strict().safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "action must be approve|reject");
    return transitionReferral(app.supabaseFactory(), parsed.data.action, referralId(req));
  });

  app.post("/referrals/:id/reverse", async (req) => {
    requireAdmin(req);
    return transitionReferral(app.supabaseFactory(), "reverse", referralId(req));
  });
}
