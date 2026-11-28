/** Explicit preparation composition. This factory is not registered by the API
 * entrypoint: queue/service readiness must be established before activation.
 * Configuration is trusted operator input, never supplied by a request.
 */
import { customerAiPreparation } from "./customer-ai-prepare.js";
import type { SupabaseFactory } from "./supabase.js";

export function customerAiRuntimePreparation(
  source: Readonly<Record<string, string | undefined>>,
  factory: SupabaseFactory,
  fetcher?: typeof fetch,
) {
  const enabled = source.CUSTOMER_AI_PREPARATION_ENABLED;
  if (enabled === undefined || enabled === "false") return undefined;
  const invalid = () => new Error("Customer AI preparation configuration is invalid.");
  if (enabled !== "true") throw invalid();
  const serviceUrl = source.CUSTOMER_AI_PRIVATE_SERVICE_URL;
  const serviceToken = source.CUSTOMER_AI_PRIVATE_SERVICE_TOKEN;
  const loopback = source.CUSTOMER_AI_ALLOW_LOOPBACK_HTTP;
  if (loopback !== undefined && loopback !== "false" && loopback !== "true") throw invalid();
  if (loopback === "true" && !["development", "test"].includes(source.NODE_ENV ?? "")) throw invalid();
  if (typeof serviceUrl !== "string" || serviceUrl !== serviceUrl.trim()
    || typeof serviceToken !== "string" || serviceToken !== serviceToken.trim()) throw invalid();
  try {
    return customerAiPreparation(factory, {
      serviceUrl, serviceToken, allowLoopbackHttp: loopback === "true", ...(fetcher ? { fetcher } : {}),
    });
  } catch {
    // Do not surface operator input or errors that could include credentials.
    throw invalid();
  }
}
