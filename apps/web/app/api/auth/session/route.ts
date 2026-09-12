import { NextResponse, type NextRequest } from "next/server";
import { authError, AuthConfigurationError, createAuthContext } from "../../../../lib/auth/server";
import { publicUser } from "../../../../lib/auth/policy";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const auth = createAuthContext(request);
    const { data, error } = await auth.supabase.auth.getUser();
    if (error || !data.user) return auth.finish(authError(401, "Sign in to continue."));
    return auth.finish(NextResponse.json({ user: publicUser(data.user) }));
  } catch (error) {
    return authError(503, error instanceof AuthConfigurationError ? error.message : "Session verification is unavailable.");
  }
}
