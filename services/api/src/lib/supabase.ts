import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "@bookworm/config";

export type { SupabaseClient };
// Injectable seam: tests pass a fake factory, no real Supabase needed.
export type SupabaseFactory = (token?: string, fetcher?: typeof fetch) => SupabaseClient;

/** Private worker transport: one bounded attempt, including streamed bodies. */
export function boundedSupabaseFetch(shutdown: AbortSignal, fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(60_000), ...(callerSignal ? [callerSignal] : [])]);
    signal.throwIfAborted();
    const response = await fetcher(input, { ...init, signal, redirect: "error" });
    if (signal.aborted) { await response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
    if (!response.body) return response;
    const url = new URL(input instanceof Request ? input.url : String(input));
    const limit = (url.pathname.startsWith("/storage/v1/object/") ? 12 : 16) * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body.cancel().catch(() => {});
      throw new Error("Private service response exceeds the worker byte limit.");
    }
    let size = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > limit) throw new Error("Private service response exceeds the worker byte limit.");
        controller.enqueue(chunk);
      },
    }), { signal });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export const defaultSupabaseFactory: SupabaseFactory = (token, fetcher) => {
  const env = loadEnv();
  // The bounded private worker owns recovery. SDK read retries reset its
  // per-attempt deadline and can sleep beyond a lease on Retry-After.
  const transport = fetcher ? { db: { retry: false }, global: { fetch: fetcher } } : {};
  if (token) {
    // User-scoped client: RLS applies via the user's JWT.
    return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      ...transport, global: { headers: { Authorization: `Bearer ${token}` }, ...(fetcher ? { fetch: fetcher } : {}) },
    });
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, transport);
};
