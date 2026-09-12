import { NextResponse, type NextRequest } from "next/server";
import { appOrigin, createAuthContext } from "./lib/auth/server";

export async function middleware(request: NextRequest) {
  // Invitation tokens live in the URL fragment (never sent to the server).
  // Let this landing page render so it can preserve the token through sign-in;
  // the acceptance API itself still requires a verified session.
  if (request.nextUrl.pathname === "/team/accept") return NextResponse.next();
  try {
    const auth = createAuthContext(request);
    const { data, error } = await auth.supabase.auth.getUser();
    if (error || !data.user) {
      const login = new URL("/login", appOrigin(request));
      login.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
      return auth.finish(NextResponse.redirect(login));
    }
    return auth.finish(NextResponse.next({ request }));
  } catch {
    const login = new URL("/login?error=configuration", request.url);
    return NextResponse.redirect(login);
  }
}

export const config = { matcher: [
  "/dashboard/:path*", "/books/:path*", "/assets/:path*", "/community/:path*",
  "/settings/:path*", "/billing/:path*", "/team/:path*", "/tasks/:path*",
  "/approvals/:path*", "/referrals/:path*", "/admin/:path*",
] };
