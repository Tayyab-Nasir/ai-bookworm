import { z } from "zod";
import { boundedServiceText } from "./bounded-service-response.js";
import type { SupabaseClient } from "./supabase.js";

const email = z.string().max(254).email();
const dispatchSchema = z.object({ package_job_id: z.string().uuid(), dispatch_id: z.string().uuid(), recipient_email: email });
const providerReceipt = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });

export async function sendOnePublicationEmail(
  db: SupabaseClient,
  config: { apiKey: string; from: string },
  send: typeof fetch = fetch,
) {
  if (!config.apiKey.trim() || !email.safeParse(config.from).success) throw new Error("Email sender configuration is invalid.");
  const { data, error } = await db.rpc("claim_managed_publication_notification");
  const parsed = z.array(dispatchSchema).max(1).safeParse(data);
  if (error || !parsed.success) throw new Error("Email dispatch could not be verified.");
  const dispatch = parsed.data[0];
  if (!dispatch) return "idle";
  let status = "unconfirmed";
  let receipt: string | null = null;
  try {
    const response = await send("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json",
        "idempotency-key": `bookworm/publication/${dispatch.dispatch_id}` },
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        from: config.from,
        to: [dispatch.recipient_email],
        subject: "Your Bookworm publication was confirmed",
        text: "Your publishing operator confirmed your publication. Sign in to Bookworm and open Publishing Studio to see the retailer listing.",
      }),
    });
    if (response.ok) {
      const result = providerReceipt.safeParse(JSON.parse(await boundedServiceText(response, 16_384, "Email receipt is unavailable.")));
      if (result.success) {
        status = "accepted";
        receipt = result.data.id;
      }
    } else {
      await response.body?.cancel().catch(() => {});
      if ([400, 401, 403, 422].includes(response.status)) status = "rejected";
    }
  } catch { /* A possibly accepted dispatch must not be sent again. */ }

  const settled = await db.rpc("settle_managed_publication_notification", {
    p_job_id: dispatch.package_job_id,
    p_dispatch_id: dispatch.dispatch_id,
    p_status: status,
    p_receipt: receipt,
  });
  if (settled.error || settled.data !== true) throw new Error("Email dispatch settlement could not be verified.");
  return status;
}
