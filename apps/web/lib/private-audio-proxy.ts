import { NextResponse, type NextRequest } from "next/server";
import { appOrigin, authError, AuthConfigurationError, createAuthContext } from "./auth/server";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
function matchesRange(requested: string, returned: RegExpExecArray) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(requested);
  if (!match || (!match[1] && !match[2])) return false;
  const start = Number(returned[1]), end = Number(returned[2]), total = Number(returned[3]);
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
  if (![start,end,total].every(Number.isSafeInteger) || (first !== null && !Number.isSafeInteger(first))
    || (last !== null && !Number.isSafeInteger(last)) || total < 1) return false;
  if (first === null) return last !== null && last > 0 && start === Math.max(0,total-last) && end === total-1;
  return first < total && (last === null || last >= first) && start === first && end === Math.min(last ?? total-1,total-1);
}

/** Bind browser media requests to the original account without exposing Storage URLs. */
export async function privateAudioSegment(request: NextRequest, params: { actor: string; projectId: string; index: string }) {
  let auth: ReturnType<typeof createAuthContext> | undefined;
  try {
    if (!uuid.test(params.actor) || !uuid.test(params.projectId) || !/^(0|[1-9][0-9]{0,2})$/u.test(params.index) || Number(params.index) >= 250)
      return authError(404, "Narration segment not found.");
    if ([...request.nextUrl.searchParams.keys()].some(key => key !== "download") || request.nextUrl.searchParams.getAll("download").length > 1
      || (request.nextUrl.searchParams.has("download") && request.nextUrl.searchParams.get("download") !== "1")) return authError(400, "Invalid audio request.");
    const range = request.headers.get("range");
    if (range && !/^bytes=\d*-\d*$/u.test(range)) return authError(416, "Unsupported audio range.");
    const forwardRange = request.headers.has("if-range") ? null : range;
    auth = createAuthContext(request);
    const { data: identity, error } = await auth.supabase.auth.getUser();
    const { data: session } = await auth.supabase.auth.getSession();
    if (error || !identity.user || !session.session) return auth.finish(authError(401, "Your session has expired. Please sign in."));
    if (identity.user.id !== params.actor || session.session.user.id !== params.actor) return auth.finish(authError(409, "Your account changed. Reload the audio."));
    if (process.env.NODE_ENV === "production" && !process.env.API_URL) throw new AuthConfigurationError("The workspace service is not configured.");
    const base = new URL(process.env.API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? "3001"}`);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new AuthConfigurationError("Invalid API_URL configuration.");
    const web = new URL(appOrigin(request));
    const loopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (base.protocol !== "https:" && !loopback(base)) throw new AuthConfigurationError("Private audio requires HTTPS to the workspace service.");
    const port = (url: URL) => url.port || (url.protocol === "https:" ? "443" : "80");
    if (base.origin === web.origin || (loopback(base) && loopback(web) && port(base) === port(web))) throw new AuthConfigurationError("The workspace service must use a separate API server.");
    const target = new URL(`${base.pathname.replace(/\/$/, "")}/v1/audiobook-jobs/${params.projectId}/segments/${params.index}/private-audio`, base.origin);
    const headers = new Headers({ authorization: `Bearer ${session.session.access_token}`, "x-bookworm-actor": params.actor, accept: "audio/mpeg" });
    if (forwardRange) headers.set("range", forwardRange);
    const upstream = await fetch(target, { headers, cache: "no-store", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]) });
    if (upstream.status === 416) {
      const value = upstream.headers.get("content-range");
      const response = authError(416, "Audio range is unavailable.");
      if (value && /^bytes \*\/\d+$/u.test(value)) response.headers.set("content-range", value);
      return auth.finish(response);
    }
    if (![200, 206].includes(upstream.status)) return auth.finish(authError([401, 403, 404, 409].includes(upstream.status) ? upstream.status : 503, "Audio is unavailable. Reload and try again."));
    const length = upstream.headers.get("content-length"), contentRange = upstream.headers.get("content-range");
    const parsedRange = contentRange && /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(contentRange);
    if (upstream.headers.get("content-type")?.split(";",1)[0].trim().toLowerCase() !== "audio/mpeg"
      || !length || !/^\d{1,8}$/u.test(length) || Number(length) < 1 || Number(length) > 50 * 1024 * 1024
      || (upstream.status === 206 && (!forwardRange || !parsedRange || Number(parsedRange[1]) > Number(parsedRange[2])
        || Number(parsedRange[2]) >= Number(parsedRange[3]) || Number(parsedRange[3]) > 50 * 1024 * 1024
        || Number(parsedRange[2]) - Number(parsedRange[1]) + 1 !== Number(length) || !matchesRange(forwardRange, parsedRange)))
      || (upstream.status === 200 && forwardRange) || (upstream.status === 200 && contentRange)) {
      await upstream.body?.cancel().catch(() => {}); return auth.finish(authError(502, "Audio response could not be verified."));
    }
    const response = new NextResponse(upstream.body, { status: upstream.status, headers: {
      "content-type": "audio/mpeg", "content-length": length, "accept-ranges": "bytes", "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin", "content-disposition": `${request.nextUrl.searchParams.has("download") ? "attachment" : "inline"}; filename="narration-part-${Number(params.index) + 1}.mp3"`,
    } });
    if (contentRange) response.headers.set("content-range", contentRange);
    return auth.finish(response);
  } catch (error) {
    const response = authError(503, error instanceof AuthConfigurationError ? error.message : "Audio service is unavailable.");
    return auth ? auth.finish(response) : response;
  }
}
