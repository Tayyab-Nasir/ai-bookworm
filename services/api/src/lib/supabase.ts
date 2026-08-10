import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "@bookworm/config";

export type { SupabaseClient };
// Injectable seam: tests pass a fake factory, no real Supabase needed.
export type SupabaseFactory = (token?: string) => SupabaseClient;

export const defaultSupabaseFactory: SupabaseFactory = (token) => {
  const env = loadEnv();
  if (token) {
    // User-scoped client: RLS applies via the user's JWT.
    return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
};
