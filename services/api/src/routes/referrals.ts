import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { postCreditEntry } from "../lib/credits.js";

// Reward amounts in credits. ponytail: constants, not config — move to a
// referral_programs table when marketing needs to tune without a deploy.
const QUALIFY_REWARD = 100;
// Velocity check: >20 referrals qualifying per referrer per day => flag + hold.
const VELOCITY_LIMIT = 20;
const VELOCITY_WINDOW_MS = 24 * 60 * 60 * 1000;

interface ReferralRow {
  id: string;
  referrer_id: string;
  referred_user_id: string | null;
  code_id: string;
  status: string;
  flagged: boolean;
  flag_reason: string | null;
  created_at: string;
}

// Service-token auth shared with /v1/credits/deduct semantics (step 11):
// internal services qualify referrals after a qualified action fires.
function requireServiceToken(req: FastifyRequest) {
  const expected = process.env.SERVICE_AUTH_TOKEN ?? "";
  const token = req.headers["x-service-token"];
  const ok =
    typeof token === "string" &&
    expected.length > 0 &&
    token.length === expected.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!ok) throw new AppError(401, "invalid service token");
}

// ponytail: admin = user id in ADMIN_USER_IDS env (comma-separated). Ceiling:
// env-only, no role table. Upgrade path: a profiles.is_admin flag or admin
// console RBAC when the ops team outgrows an env var.
function requireAdmin(req: FastifyRequest) {
  const admins = (process.env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!admins.includes(req.userId)) throw new AppError(403, "admin required");
}

// Post the referral reward. Idempotent: the credit_ledger (source,
// reference_id) unique index from step 11 makes a duplicate insert a 23505,
// which we treat as "already rewarded" — a 200 no-op, never a double post.
async function postReward(svc: SupabaseClient, referral: ReferralRow) {
  try {
    await postCreditEntry(svc, {
      userId: referral.referrer_id,
      source: "referral_reward",
      amount: QUALIFY_REWARD,
      referenceType: "referral",
      referenceId: referral.id,
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("23505") || msg.toLowerCase().includes("duplicate") || msg.toLowerCase().includes("unique")) return false;
    throw e;
  }
}

export function referralRoutes(app: FastifyInstance) {
  // Fetch the caller's code, creating one on first use.
  app.get("/referrals/code", async (req) => {
    const svc = app.supabaseFactory();
    const { data: existing } = await svc
      .from("referral_codes")
      .select("*")
      .eq("user_id", req.userId)
      .eq("status", "active")
      .maybeSingle();
    if (existing) return existing;
    const code = `bw-${randomBytes(4).toString("hex")}`;
    const { data, error } = await svc
      .from("referral_codes")
      .insert({ user_id: req.userId, code, status: "active" })
      .select()
      .single();
    if (error) throw new AppError(500, error.message);
    return data;
  });

  app.get("/referrals", async (req) => {
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb.from("referrals").select("*").order("created_at", { ascending: false });
    if (error) throw new AppError(500, error.message);
    return { referrals: data };
  });

  app.get("/referrals/ledger", async (req) => {
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb.from("credit_ledger").select("*").eq("user_id", req.userId).order("created_at", { ascending: false });
    if (error) throw new AppError(500, error.message);
    return { entries: data };
  });

  // Called at signup: attributes the new user to a code. Self-referrals
  // rejected; one referral per referred user (unique index backstop).
  app.post("/referrals/claim", async (req, reply) => {
    const parsed = z.object({ code: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid claim", { issues: parsed.error.issues });
    const svc = app.supabaseFactory();
    const { data: codeRow } = await svc
      .from("referral_codes")
      .select("id,user_id,status")
      .eq("code", parsed.data.code)
      .maybeSingle();
    if (!codeRow) throw new AppError(404, "referral code not found");
    const code = codeRow as { id: string; user_id: string; status: string };
    if (code.status !== "active") throw new AppError(422, "referral code is not active");
    if (code.user_id === req.userId) throw new AppError(422, "cannot refer yourself", undefined, "self_referral");
    const { data: dup } = await svc.from("referrals").select("id").eq("referred_user_id", req.userId).maybeSingle();
    if (dup) return { referral: dup, alreadyAttributed: true };
    const { data, error } = await svc
      .from("referrals")
      .insert({ referrer_id: code.user_id, referred_user_id: req.userId, code_id: code.id, status: "attributed" })
      .select()
      .single();
    if (error) {
      if ((error as { code?: string }).code === "23505") return { alreadyAttributed: true };
      throw new AppError(500, error.message);
    }
    return reply.status(201).send({ referral: data });
  });

  // Internal: a qualified action fired for referredUserId. Anti-fraud:
  // self-referral (backstop), stale codes, referrer velocity. Clean => reward
  // posted now; flagged => status held, no ledger entry until admin review.
  app.post("/referrals/qualify", { config: { serviceAuth: true } }, async (req) => {
    requireServiceToken(req);
    const parsed = z.object({ referredUserId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid qualify request", { issues: parsed.error.issues });
    const svc = app.supabaseFactory();
    const { data: refData } = await svc
      .from("referrals")
      .select("*")
      .eq("referred_user_id", parsed.data.referredUserId)
      .maybeSingle();
    if (!refData) return { qualified: false, reason: "no_attributed_referral" };
    const referral = refData as ReferralRow;
    if (referral.status !== "attributed" && referral.status !== "held") return { qualified: false, duplicate: true, status: referral.status };

    const flags: string[] = [];
    if (referral.referrer_id === referral.referred_user_id) flags.push("self_referral");
    const { data: codeRow } = await svc.from("referral_codes").select("created_at,status").eq("id", referral.code_id).maybeSingle();
    const code = codeRow as { created_at: string; status: string } | null;
    if (!code || code.status !== "active") flags.push("inactive_code");
    // Velocity: referrals by this referrer created in the last 24h.
    const since = new Date(Date.now() - VELOCITY_WINDOW_MS).toISOString();
    const { data: recent } = await svc
      .from("referrals")
      .select("id")
      .eq("referrer_id", referral.referrer_id)
      .gte("created_at", since);
    const recentCount = (recent ?? []).length;
    if (recentCount > VELOCITY_LIMIT) flags.push(`velocity_${recentCount}_per_day`);

    if (flags.length) {
      const { data } = await svc
        .from("referrals")
        .update({ status: "held", flagged: true, flag_reason: flags.join(","), qualified_at: new Date().toISOString() })
        .eq("id", referral.id)
        .select()
        .single();
      return { qualified: true, held: true, flags, referral: data };
    }

    const posted = await postReward(svc, referral);
    const { data } = await svc
      .from("referrals")
      .update({ status: "rewarded", qualified_at: new Date().toISOString() })
      .eq("id", referral.id)
      .select()
      .single();
    return { qualified: true, held: false, rewarded: posted, referral: data };
  });

  // Admin manual review of held referrals. Approve posts the reward (once);
  // reject marks it rejected with no ledger entry.
  app.post("/referrals/:id/review", async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const parsed = z.object({ action: z.enum(["approve", "reject"]) }).safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "action must be approve|reject");
    const svc = app.supabaseFactory();
    const { data: refData } = await svc.from("referrals").select("*").eq("id", id).maybeSingle();
    if (!refData) throw new AppError(404, "referral not found");
    const referral = refData as ReferralRow;
    if (referral.status !== "held") return { referral, alreadyResolved: true };
    if (parsed.data.action === "reject") {
      const { data } = await svc
        .from("referrals")
        .update({ status: "rejected", reviewed_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();
      return { referral: data };
    }
    const posted = await postReward(svc, referral);
    const { data } = await svc
      .from("referrals")
      .update({ status: "rewarded", reviewed_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    return { referral: data, rewarded: posted };
  });

  // Fraud/chargeback: compensating negative entry referencing the original
  // reward (ledger stays append-only). Only rewarded referrals can reverse.
  app.post("/referrals/:id/reverse", async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const svc = app.supabaseFactory();
    const { data: refData } = await svc.from("referrals").select("*").eq("id", id).maybeSingle();
    if (!refData) throw new AppError(404, "referral not found");
    const referral = refData as ReferralRow;
    if (referral.status === "reversed") return { referral, alreadyReversed: true };
    if (referral.status !== "rewarded") throw new AppError(422, "only rewarded referrals can be reversed");
    const { data: original } = await svc
      .from("credit_ledger")
      .select("id,amount")
      .eq("source", "referral_reward")
      .eq("reference_id", id)
      .maybeSingle();
    if (!original) throw new AppError(409, "reward entry not found");
    const orig = original as { id: string | number; amount: number };
    await postCreditEntry(svc, {
      userId: referral.referrer_id,
      source: "reversal",
      amount: -Math.abs(orig.amount),
      referenceType: "referral_reward",
      referenceId: id,
    });
    const { data } = await svc
      .from("referrals")
      .update({ status: "reversed", reviewed_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    return { referral: data, reversedAmount: -Math.abs(orig.amount), originalEntryId: orig.id };
  });
}
