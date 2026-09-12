import { NextResponse, type NextRequest } from "next/server";
import { appOrigin, createAuthContext } from "../../../lib/auth/server";
import { safeNext } from "../../../lib/auth/policy";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const failure = () => NextResponse.redirect(new URL("/login?error=confirmation", request.nextUrl.origin));
  try {
    const auth = createAuthContext(request);
    const code = request.nextUrl.searchParams.get("code");
    const tokenHash = request.nextUrl.searchParams.get("token_hash");
    const type = request.nextUrl.searchParams.get("type");
    let error: unknown = true;
    if (code) ({ error } = await auth.supabase.auth.exchangeCodeForSession(code));
    else if (tokenHash && (type === "signup" || type === "recovery" || type === "email")) {
      ({ error } = await auth.supabase.auth.verifyOtp({ token_hash: tokenHash, type }));
    }
    if (error) return auth.finish(failure());
    const next = type === "recovery" ? "/settings/password" : safeNext(request.nextUrl.searchParams.get("next"));
    return auth.finish(NextResponse.redirect(new URL(next, appOrigin(request))));
  } catch { return failure(); }
}
