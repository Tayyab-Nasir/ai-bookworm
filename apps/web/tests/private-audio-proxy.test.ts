import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { NextRequest, type NextResponse } from "next/server";
import { POST } from "../app/api/auth/[action]/route";
import { GET as session } from "../app/api/auth/session/route";
import { GET as backendGet, POST as backendPost, PUT as backendPut, PATCH as backendPatch, DELETE as backendDelete } from "../app/api/backend/[...path]/route";
import { GET as callback } from "../app/auth/callback/route";
import { safeNext, sameOrigin } from "../lib/auth/policy";
import { appOrigin } from "../lib/auth/server";
import { privateAudioSegment } from "../lib/private-audio-proxy";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const user = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "author@example.test", app_metadata: {}, user_metadata: { display_name: "Test author" }, created_at: "2026-01-01T00:00:00Z" };
const token = (expires = 3600) => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + expires, aud: "authenticated" })).toString("base64url")}.fixture-signature`;
const authSession = (expires = 3600) => ({ access_token: token(expires), refresh_token: "fixture-refresh-token", token_type: "bearer", expires_in: expires, expires_at: Math.floor(Date.now() / 1000) + expires, user });
let provider: (url: URL, init?: RequestInit) => Response | Promise<Response>;
const calls: { url: string; headers: Headers }[] = [];

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: "test", APP_URL: "http://localhost:3000", SUPABASE_URL: "http://auth.example.test", SUPABASE_ANON_KEY: "fixture-anon-key", API_URL: "https://api.example.test" });
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  calls.length = 0;
  provider = (url) => {
    if (url.pathname === "/auth/v1/settings") return Response.json({ external: { google: true } });
    if (url.pathname === "/auth/v1/token") return Response.json(authSession());
    if (url.pathname === "/auth/v1/user") return Response.json(user);
    if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    if (url.pathname === "/auth/v1/recover") return Response.json({});
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, headers: new Headers(init?.headers) });
    return provider(url, init);
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

function request(action: string, body: unknown, cookie?: string, origin = "http://localhost:3000") {
  return new NextRequest(`http://localhost:3000/api/auth/${action}`, { method: "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
}
const invoke = (action: string, body: unknown, cookie?: string) => POST(request(action, body, cookie), { params: Promise.resolve({ action }) });
const cookies = (response: NextResponse) => response.cookies.getAll().map(({ name, value }) => `${name}=${value}`).join("; ");
const login = () => invoke("login", { email: user.email, password: "fixture-password" });

test("private audio proxy binds session actor and streams a single range without revealing a Storage URL", async () => {
  const signedIn = await login(), authProvider = provider;
  const target = `https://api.example.test/v1/audiobook-jobs/${user.id}/segments/0/private-audio`;
  provider = (url, init) => url.href === target ? new Response("ID3", {status:206,headers:{"content-type":"audio/mpeg","content-length":"3","content-range":"bytes 0-2/9"}}) : authProvider(url, init);
  const input = new NextRequest(`http://localhost:3000/api/private-audio/${user.id}/segments/${user.id}/0?download=1`, {headers:{cookie:cookies(signedIn),range:"bytes=0-2"}});
  const response = await privateAudioSegment(input, {actor:user.id,projectId:user.id,index:"0"});
  assert.equal(response.status,206); assert.equal(await response.text(),"ID3");
  assert.equal(response.headers.get("content-range"),"bytes 0-2/9"); assert.equal(response.headers.get("content-disposition"),'attachment; filename="narration-part-1.mp3"');
  assert.match(response.headers.get("cache-control")!,/no-store/); assert.equal(response.headers.get("vary"),"Cookie");
  assert.equal(response.headers.get("cross-origin-resource-policy"),"same-origin");
  const forwarded = calls.find(call => call.url === target)!; assert.equal(forwarded.headers.get("x-bookworm-actor"),user.id); assert.equal(forwarded.headers.get("range"),"bytes=0-2");
  assert.equal([...response.headers.values()].some(value => value.includes("token=")),false);
  const badActor = await privateAudioSegment(input, {actor:"22222222-2222-4222-8222-222222222222",projectId:user.id,index:"0"});
  assert.equal(badActor.status,409); assert.equal(calls.filter(call => call.url === target).length,1);
});

test("private audio proxy rejects malformed range and inconsistent upstream range metadata", async () => {
  const signedIn = await login(), authProvider = provider;
  const target = `https://api.example.test/v1/audiobook-jobs/${user.id}/segments/0/private-audio`;
  provider = (url, init) => url.href === target ? new Response("ID3", {status:206,headers:{"content-type":"audio/mpeg","content-length":"3","content-range":"bytes 0-4/9"}}) : authProvider(url, init);
  const params = {actor:user.id,projectId:user.id,index:"0"};
  const input = (range:string) => new NextRequest("http://localhost:3000/api/private-audio/test",{headers:{cookie:cookies(signedIn),range}});
  assert.equal((await privateAudioSegment(input("bytes=0-2,4-5"),params)).status,416);
  assert.equal((await privateAudioSegment(input("bytes=0-2"),params)).status,502);
  provider = (url, init) => url.href === target ? new Response("D3f", {status:206,headers:{"content-type":"audio/mpeg","content-length":"3","content-range":"bytes 1-3/9"}}) : authProvider(url, init);
  assert.equal((await privateAudioSegment(input("bytes=0-2"),params)).status,502);
  provider = (url, init) => url.href === target ? new Response("end", {status:206,headers:{"content-type":"audio/mpeg","content-length":"3","content-range":"bytes 6-8/9"}}) : authProvider(url, init);
  const suffix=await privateAudioSegment(input("bytes=-3"),params); assert.equal(suffix.status,206); assert.equal(await suffix.text(),"end");
});

test("private audio proxy drops an If-Range request when no matching validator exists", async () => {
  const signedIn=await login(), authProvider=provider;
  const target=`https://api.example.test/v1/audiobook-jobs/${user.id}/segments/0/private-audio`;
  provider=(url,init)=>url.href===target ? new Response("ID3whole",{status:200,headers:{"content-type":"audio/mpeg","content-length":"8"}}) : authProvider(url,init);
  const input=new NextRequest("http://localhost:3000/api/private-audio/test",{headers:{cookie:cookies(signedIn),range:"bytes=0-2","if-range":'"old"'}});
  const response=await privateAudioSegment(input,{actor:user.id,projectId:user.id,index:"0"});
  assert.equal(response.status,200); assert.equal(await response.text(),"ID3whole"); assert.equal(calls.find(call=>call.url===target)?.headers.has("range"),false);
});

test("private audio refuses plaintext non-loopback workspace service",async()=>{
  const signedIn=await login(); process.env.API_URL="http://api.example.test";
  const input=new NextRequest("http://localhost:3000/api/private-audio/test",{headers:{cookie:cookies(signedIn)}});
  assert.equal((await privateAudioSegment(input,{actor:user.id,projectId:user.id,index:"0"})).status,503);
  assert.equal(calls.filter(call=>new URL(call.url).hostname==="api.example.test").length,0);
});
