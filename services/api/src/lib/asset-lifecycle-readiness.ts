import { boundedSupabaseFetch, type SupabaseFactory } from "./supabase.js";

// A hung adapter occupies one slot per factory until it actually settles. This
// avoids launching unlimited background requests when a transport ignores abort.
const inflight = new WeakMap<SupabaseFactory, Promise<boolean>>();

/** Probe database capability before advertising or using lifecycle routes.
 * The mutation must repeat enforcement checks in its own transaction.
 * Success is not cached. Deployments need shared request-rate and database
 * statement limits for repeated probes across requests and API instances. */
export function assetLifecycleReady(factory: SupabaseFactory): Promise<boolean> {
  const existing = inflight.get(factory);
  if (existing) return existing;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = Promise.resolve().then(() => factory(undefined, boundedSupabaseFetch(controller.signal))
    .rpc("asset_lifecycle_readiness"));
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Asset readiness timed out")); }, 3000);
  });
  const result = Promise.race([attempt, deadline]).then(
    ({ data, error }) => !controller.signal.aborted && error === null && data === "asset-lifecycle-v1",
    () => false,
  ).finally(() => { if (timer) clearTimeout(timer); controller.abort(); });
  inflight.set(factory, result);
  void attempt.then(() => { if (inflight.get(factory) === result) inflight.delete(factory); },
    () => { if (inflight.get(factory) === result) inflight.delete(factory); });
  return result;
}
