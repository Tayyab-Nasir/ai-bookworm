import { NextResponse, type NextRequest } from "next/server";
import { appOrigin, authError, AuthConfigurationError, createAuthContext } from "../../../../lib/auth/server";
import { sameOrigin } from "../../../../lib/auth/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  let auth: ReturnType<typeof createAuthContext> | undefined;
  try {
    if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request, appOrigin(request))) return authError(403, "Invalid request origin.", "invalid_origin");
    const { path } = await context.params;
    if (path[0] !== "v1" || path.some((part) => !/^[a-zA-Z0-9_-]+$/.test(part)) || ["webhooks", "credits"].includes(path[1])) return authError(404, "API route not available.");
    auth = createAuthContext(request);
    const { data: identity, error } = await auth.supabase.auth.getUser();
    if (error || !identity.user) return auth.finish(authError(401, "Your session has expired. Please sign in.", "unauthenticated"));
    const { data } = await auth.supabase.auth.getSession();
    if (!data.session) return auth.finish(authError(401, "Please sign in.", "unauthenticated"));
    const base = new URL(process.env.API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? "3001"}`);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new AuthConfigurationError("Invalid API_URL configuration.");
    const target = new URL(`${base.pathname.replace(/\/$/, "")}/${path.join("/")}`, base.origin);
    target.search = request.nextUrl.search;
    const headers = new Headers({ authorization: `Bearer ${data.session.access_token}`, accept: "application/json" });
    const idempotencyKey = request.headers.get("idempotency-key");
    if (idempotencyKey && idempotencyKey.length <= 200) headers.set("idempotency-key", idempotencyKey);
    let body: Uint8Array | undefined;
    if (!["GET", "HEAD"].includes(request.method) && request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 1024 * 1024) { await reader.cancel(); return auth.finish(authError(413, "Request exceeds 1 MiB. Use a signed upload for source files.")); }
        chunks.push(chunk.value);
      }
      if (length) {
        if (!request.headers.get("content-type")?.startsWith("application/json")) return auth.finish(authError(415, "Send JSON to this API."));
        body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
        headers.set("content-type", "application/json");
      }
    }
    const upstream = await fetch(target, { method: request.method, headers, body: body as BodyInit | undefined, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(180_000) });
    if (upstream.status >= 300 && upstream.status < 400) return auth.finish(authError(502, "Unexpected API redirect."));
    const contentType = upstream.headers.get("content-type") ?? "application/json";
    const response = new NextResponse(upstream.body, { status: upstream.status, headers: { "content-type": contentType, "cache-control": "private, no-store" } });
    if (contentType.split(";", 1)[0].trim().toLowerCase() === "audio/mpeg" && upstream.headers.get("content-disposition") === 'attachment; filename="chapter.mp3"') {
      response.headers.set("content-disposition", 'attachment; filename="chapter.mp3"');
      const audioQc = upstream.headers.get("x-bookworm-audio-qc");
      if (audioQc && audioQc.length <= 8192) response.headers.set("x-bookworm-audio-qc", audioQc);
      const audioSha256 = upstream.headers.get("x-bookworm-audio-sha256");
      if (audioSha256 && /^[a-f0-9]{64}$/.test(audioSha256)) response.headers.set("x-bookworm-audio-sha256", audioSha256);
      const qcReportId = upstream.headers.get("x-bookworm-audio-qc-report-id");
      if (qcReportId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(qcReportId)) {
        response.headers.set("x-bookworm-audio-qc-report-id", qcReportId);
      }
      if (upstream.headers.get("x-bookworm-audio-qc-history") === "unavailable") {
        response.headers.set("x-bookworm-audio-qc-history", "unavailable");
      }
    }
    const audioArchive = /^attachment; filename="([A-Za-z0-9_-]{1,64}\.zip)"$/u.exec(upstream.headers.get("content-disposition") ?? "");
    if (contentType.split(";", 1)[0].trim().toLowerCase() === "application/zip" && audioArchive
      && upstream.headers.get("x-bookworm-audio-disclosure") === "synthesized-voice-required") {
      response.headers.set("content-disposition", `attachment; filename="${audioArchive[1]}"`);
      response.headers.set("x-bookworm-audio-disclosure", "synthesized-voice-required");
      const contentLength = upstream.headers.get("content-length");
      if (contentLength && /^\d{1,10}$/u.test(contentLength)) response.headers.set("content-length", contentLength);
    }
    return auth.finish(response);
  } catch (error) {
    const response = authError(503, error instanceof AuthConfigurationError ? error.message : "The workspace service is unavailable. Your changes have not been confirmed saved.", "dependency_unavailable");
    return auth ? auth.finish(response) : response;
  }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
