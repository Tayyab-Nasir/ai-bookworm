import type { SupabaseClient } from "./supabase.js";
import { AppError } from "../errors.js";

export async function transitionReferral(
  svc: SupabaseClient, action: "qualify" | "approve" | "reject" | "reverse", id: string,
) {
  const { data, error } = await svc.rpc("transition_referral", {
    p_action: action,
    ...(action === "qualify" ? { p_referred_user_id: id } : { p_referral_id: id }),
  });
  if (error) {
    const status = error.code === "P0002" ? 404 : error.code === "22023" ? 422 : error.code === "55000" ? 409 : 500;
    throw new AppError(status, error.message);
  }
  return data;
}
