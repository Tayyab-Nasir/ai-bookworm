import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "production";
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_ANON_KEY = "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.QDRANT_URL = "http://localhost:6333";
process.env.LOG_LEVEL = "error";
const { buildApp } = await import("./app.js");
const { savedPrintRender, verifySavedPrintBytes } = await import("./lib/rendered-print.js");
const { requestSavedPdfPage } = await import("./lib/pdf-proof.js");
type Row = Record<string, unknown>;
const USER = "b0000000-0000-4000-8000-000000000001";
const WORKSPACE = "b0000000-0000-4000-8000-000000000002";
const BOOK = "b0000000-0000-4000-8000-000000000003";
const EDITION = "b0000000-0000-4000-8000-000000000004";
const JOB = "b0000000-0000-4000-8000-000000000005";
const ASSET = "b0000000-0000-4000-8000-000000000006";
const COVER = "b0000000-0000-4000-8000-000000000007";
const INPUT_COVER = "b0000000-0000-4000-8000-000000000008";
const OTHER = "b0000000-0000-4000-8000-000000000009";
const rootPath = `/v1/editions/${EDITION}/print-renders`;
const auth = { authorization: "Bearer member" };
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

// A native one-page PDF with a real xref table, not a signature-only placeholder.
function pdf(text: string) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 432 648] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
  let source = "%PDF-1.4\n"; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}
const primaryBytes = pdf("Saved interior"); const coverBytes = pdf("Saved paperback cover");
function store(withCover = true) {
  const descriptors = [{ assetId: ASSET, filename: "book.pdf", type: "rendered_book", role: "rendered_print", bytes: primaryBytes },
    ...(withCover ? [{ assetId: COVER, filename: "cover.pdf", type: "rendered_cover", role: "rendered_cover", bytes: coverBytes }] : [])]
    .map(({ bytes, ...artifact }) => ({ ...artifact, storagePath: `workspaces/${WORKSPACE}/assets/${artifact.assetId}/v1/${artifact.filename}`,
      name: artifact.filename, mimeType: "application/pdf", sizeBytes: bytes.length, checksum: hash(bytes) }));
  return { tables: {
    books: [{ id: BOOK, workspace_id: WORKSPACE }], editions: [{ id: EDITION, book_id: BOOK, type: "print" }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, status: "active", role: "viewer" }],
    publishing_jobs: [{ id: JOB, book_id: BOOK, edition_id: EDITION, channel: "render", status: "succeeded", created_at: "2026-10-13T00:00:00.000Z",
      request_json: { action: "render", editionUpdatedAt: "2026-10-12T00:00:00.000Z", bookModelSha256: "a".repeat(64), imageSha256: "b".repeat(64),
        artworkSnapshot: { schemaVersion: 1, coverAssetId: withCover ? INPUT_COVER : null, illustrationAssetIds: [], assets: withCover ? [{ assetId: INPUT_COVER,
          versionNumber: 1, storagePath: `workspaces/${WORKSPACE}/assets/${INPUT_COVER}/v1/front.png`, checksum: "c".repeat(64), mimeType: "image/png", sizeBytes: 80,
          requiresApproval: false, approvalId: null }] : [] } },
      response_json: { artifacts: descriptors, rendererVersion: "pdf-native-fixture", usage: {} } }],
    assets: descriptors.map(artifact => ({ id: artifact.assetId, workspace_id: WORKSPACE, type: artifact.type, storage_path: artifact.storagePath,
      mime_type: artifact.mimeType, size_bytes: artifact.sizeBytes, checksum: artifact.checksum, deleted_at: null, status: "draft", name: artifact.name })),
    asset_versions: descriptors.map(artifact => ({ asset_id: artifact.assetId, version_number: 1, storage_path: artifact.storagePath,
      mime_type: artifact.mimeType, size_bytes: artifact.sizeBytes, checksum: artifact.checksum, scan_status: "trusted_generated" })),
  } as Record<string, Row[]>, objects: new Map([[descriptors[0].storagePath, Buffer.from(primaryBytes)], ...(withCover ? [[descriptors[1].storagePath, Buffer.from(coverBytes)] as [string, Buffer]] : [])]),
  queries: [] as string[], tokens: [] as (string | undefined)[], downloads: [] as string[], signed: [] as string[], mutations: [] as string[],
  onDownload: null as (() => void) | null, dbError: null as string | null };
}
type Store = ReturnType<typeof store>;
function factory(saved: Store) {
  return (token?: string, _transport?: unknown) => {
    saved.tokens.push(token);
    return { auth: { getUser: async () => ({ data: { user: token === "member" ? { id: USER } : null }, error: null }) },
      from(table: string) {
        saved.queries.push(table); const filters: [string, unknown][] = []; let count = 100;
        const selected = () => saved.tables[table].filter(row => filters.every(([key, value]) => row[key] === value)).slice(0, count);
        const result = () => ({ data: selected(), error: saved.dbError === table ? { message: "private database diagnostic" } : null });
        const builder = { select: () => builder, eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
          is: (key: string, value: unknown) => { filters.push([key, value]); return builder; }, order: () => builder,
          limit: (value: number) => { count = value; return builder; },
          maybeSingle: async () => ({ data: selected()[0] ?? null, error: saved.dbError === table ? { message: "private diagnostic" } : null }),
          then: (resolve: (value: unknown) => unknown) => resolve(result()),
          insert: () => { saved.mutations.push("insert"); throw new Error("no writes"); }, update: () => { saved.mutations.push("update"); throw new Error("no writes"); } };
        return builder;
      },
      storage: { from: (bucket: string) => ({
        download: async (path: string) => { assert.equal(bucket, "book-assets"); saved.downloads.push(path); saved.onDownload?.();
          const bytes = saved.objects.get(path); return { data: bytes ? new Blob([new Uint8Array(bytes)]) : null, error: null }; },
        createSignedUrl: async (path: string, duration: number) => { assert.equal(duration, 300); saved.signed.push(path);
          assert.equal(saved.downloads.length, saved.tables.assets.length, "All artifacts must verify before the first signed link.");
          return { data: { signedUrl: `https://private.example/${saved.signed.length}` }, error: null }; },
        upload: () => { saved.mutations.push("upload"); throw new Error("no writes"); },
      }) }, rpc: () => { saved.mutations.push("rpc"); throw new Error("no writes"); },
    } as never;
  };
}
async function listed(app: Awaited<ReturnType<typeof buildApp>>) {
  const result = await app.inject({ method: "GET", url: rootPath, headers: auth }); assert.equal(result.statusCode, 200);
  return result.json().renders[0] as { source: { sha256: string }; fingerprint: string };
}
const downloadPath = (render: { source: { sha256: string }; fingerprint: string }) => `${rootPath}/${JOB}/download?sha256=${render.source.sha256}&fingerprint=${render.fingerprint}`;

test("saved print history exposes verified source identity without signed links, storage reads, writes or providers", async () => {
  const saved = store(); const app = await buildApp(factory(saved), { renderFetch: async () => { throw new Error("no renderer"); } });
  try {
    const result = await app.inject({ method: "GET", url: rootPath, headers: auth }); assert.equal(result.statusCode, 200);
    const render = result.json().renders[0]; assert.equal(render.jobId, JOB); assert.equal(render.source.sha256, hash(primaryBytes)); assert.equal(render.source.version, 1);
    assert.match(render.fingerprint, /^[a-f0-9]{64}$/u); assert.equal(result.headers["cache-control"], "private, no-store");
    assert.ok(!result.body.includes("storagePath") && !result.body.includes("signedUrl") && !result.body.includes("front.png"));
    assert.deepEqual(saved.downloads, []); assert.deepEqual(saved.signed, []); assert.deepEqual(saved.mutations, []); assert.ok(saved.tokens.every(token => token === "member"));
  } finally { await app.close(); }
});
test("viewer renews exact native interior and cover after manuscript or edition edits, without rendering", async () => {
  const saved = store(); const app = await buildApp(factory(saved));
  try {
    const render = await listed(app); saved.tables.books[0].title = "Changed current manuscript"; saved.tables.editions[0].updated_at = "2026-10-13T10:00:00.000Z";
    const result = await app.inject({ method: "GET", url: downloadPath(render), headers: auth }); assert.equal(result.statusCode, 200);
    assert.equal(result.headers["cache-control"], "private, no-store"); assert.equal(result.json().jobId, JOB);
    assert.deepEqual(result.json().artifacts.map((artifact: { role: string }) => artifact.role), ["rendered_print", "rendered_cover"]);
    assert.equal(saved.downloads.length, 2); assert.equal(saved.signed.length, 2); assert.deepEqual(saved.mutations, []); assert.ok(saved.tokens.every(token => token === "member"));
  } finally { await app.close(); }
});
test("print proof without cover can renew its original interior", async () => {
  const saved = store(false); const app = await buildApp(factory(saved));
  try { const result = await app.inject({ method: "GET", url: downloadPath(await listed(app)), headers: auth }); assert.equal(result.statusCode, 200); assert.equal(result.json().artifacts.length, 1); }
  finally { await app.close(); }
});
test("confirmed generated PNG front cover renews alongside the saved PDF", async () => {
  const saved = store();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64");
  const path = `workspaces/${WORKSPACE}/assets/${COVER}/v1/cover.png`;
  const artifact = ((saved.tables.publishing_jobs[0].response_json as Row).artifacts as Row[])[1];
  Object.assign(artifact, { filename: "cover.png", storagePath: path, mimeType: "image/png", sizeBytes: png.length, checksum: hash(png) });
  for (const row of [saved.tables.assets[1], saved.tables.asset_versions[1]]) Object.assign(row, { storage_path: path, mime_type: "image/png", size_bytes: png.length, checksum: hash(png) });
  saved.objects.set(path, png); const app = await buildApp(factory(saved));
  try { const result = await app.inject({ method: "GET", url: downloadPath(await listed(app)), headers: auth }); assert.equal(result.statusCode, 200); assert.equal(result.json().artifacts[1].asset.mime_type, "image/png"); }
  finally { await app.close(); }
});
for (const [name, mutate, status] of [
  ["revoked membership", (saved: Store) => { saved.tables.workspace_members[0].status = "invited"; }, 403],
  ["foreign workspace", (saved: Store) => { saved.tables.books[0].workspace_id = OTHER; }, 403],
  ["foreign book job", (saved: Store) => { saved.tables.publishing_jobs[0].book_id = OTHER; }, 404],
  ["foreign edition job", (saved: Store) => { saved.tables.publishing_jobs[0].edition_id = OTHER; }, 404],
  ["failed job", (saved: Store) => { saved.tables.publishing_jobs[0].status = "failed"; }, 422],
  ["ebook edition", (saved: Store) => { saved.tables.editions[0].type = "ebook"; }, 422],
  ["deleted interior", (saved: Store) => { saved.tables.assets[0].deleted_at = "2026-10-13"; }, 422],
  ["deleted cover", (saved: Store) => { saved.tables.assets[1].deleted_at = "2026-10-13"; }, 422],
  ["quarantined cover", (saved: Store) => { saved.tables.asset_versions[1].scan_status = "infected"; }, 422],
  ["changed exact version", (saved: Store) => { saved.tables.asset_versions[0].version_number = 2; }, 422],
  ["changed version checksum", (saved: Store) => { saved.tables.asset_versions[1].checksum = "d".repeat(64); }, 422],
  ["foreign canonical version path", (saved: Store) => { saved.tables.asset_versions[1].storage_path = `workspaces/${OTHER}/assets/${COVER}/v1/cover.pdf`; }, 422],
  ["wrong asset MIME", (saved: Store) => { saved.tables.assets[0].mime_type = "text/html"; }, 422],
  ["changed cover bytes", (saved: Store) => { saved.objects.set(String(saved.tables.assets[1].storage_path), pdf("Tampered paperback cover")); }, 422],
  ["corrupt primary bytes", (saved: Store) => { const bytes = Buffer.from(primaryBytes); bytes[60] ^= 1; saved.objects.set(String(saved.tables.assets[0].storage_path), bytes); }, 422],
  ["database outage", (saved: Store) => { saved.dbError = "asset_versions"; }, 503],
] as const) test(`saved print download rejects ${name} before signing or mutations`, async () => {
  const saved = store(); const app = await buildApp(factory(saved));
  try { const render = await listed(app); mutate(saved); const result = await app.inject({ method: "GET", url: downloadPath(render), headers: auth });
    assert.equal(result.statusCode, status); assert.deepEqual(saved.signed, []); assert.deepEqual(saved.mutations, []); assert.ok(!result.body.includes("workspaces/") && !result.body.includes("private diagnostic")); }
  finally { await app.close(); }
});
test("access revoked during byte verification cannot receive a renewed signed link", async () => {
  const saved = store(); const app = await buildApp(factory(saved));
  try { const render = await listed(app); saved.onDownload = () => { saved.tables.workspace_members[0].status = "revoked"; };
    const result = await app.inject({ method: "GET", url: downloadPath(render), headers: auth }); assert.equal(result.statusCode, 403); assert.deepEqual(saved.signed, []); }
  finally { await app.close(); }
});
test("history skips retired and malformed proofs while keeping valid older proofs", async () => {
  const saved = store(); const malformed = structuredClone(saved.tables.publishing_jobs[0]); malformed.id = OTHER; malformed.response_json = { artifacts: [] };
  saved.tables.publishing_jobs.unshift(malformed); const app = await buildApp(factory(saved));
  try { assert.equal((await app.inject({ method: "GET", url: rootPath, headers: auth })).json().renders.length, 1);
    saved.tables.assets[1].deleted_at = "2026-10-13"; assert.deepEqual((await app.inject({ method: "GET", url: rootPath, headers: auth })).json(), { renders: [] }); }
  finally { await app.close(); }
});
test("download requires the complete listed primary/cover/source fingerprint", async () => {
  const saved = store(); const app = await buildApp(factory(saved));
  try { const render = await listed(app); (saved.tables.publishing_jobs[0].request_json as Row).imageSha256 = "d".repeat(64);
    const result = await app.inject({ method: "GET", url: downloadPath(render), headers: auth }); assert.equal(result.statusCode, 409); assert.deepEqual(saved.downloads, []); assert.deepEqual(saved.signed, []); }
  finally { await app.close(); }
});
test("valid checksums cannot disguise a non-PDF artifact", async () => {
  const saved = store(false); const invalid = Buffer.from("not a native PDF file"); const digest = hash(invalid);
  const artifact = ((saved.tables.publishing_jobs[0].response_json as Row).artifacts as Row[])[0];
  Object.assign(artifact, { sizeBytes: invalid.length, checksum: digest });
  for (const row of [saved.tables.assets[0], saved.tables.asset_versions[0]]) Object.assign(row, { size_bytes: invalid.length, checksum: digest });
  saved.objects.set(String(saved.tables.assets[0].storage_path), invalid); const app = await buildApp(factory(saved));
  try { const result = await app.inject({ method: "GET", url: downloadPath(await listed(app)), headers: auth }); assert.equal(result.statusCode, 422); assert.deepEqual(saved.signed, []); }
  finally { await app.close(); }
});
test("source fingerprints include cover descriptors and survive JSONB object key order", async () => {
  const saved = store(); const sb = factory(saved)("member"); const job = saved.tables.publishing_jobs[0];
  const first = await savedPrintRender(sb, WORKSPACE, BOOK, EDITION, job);
  job.request_json = Object.fromEntries(Object.entries(job.request_json as Row).reverse());
  (job.response_json as Row).artifacts = ((job.response_json as Row).artifacts as Row[]).slice().reverse().map(row => Object.fromEntries(Object.entries(row).reverse()));
  const second = await savedPrintRender(sb, WORKSPACE, BOOK, EDITION, job); assert.equal(first.render.fingerprint, second.render.fingerprint);
  (((job.response_json as Row).artifacts as Row[]).find(row => row.role === "rendered_cover")!).name = "Renamed immutable cover descriptor";
  const third = await savedPrintRender(sb, WORKSPACE, BOOK, EDITION, job); assert.notEqual(first.render.fingerprint, third.render.fingerprint);
});
for (const query of ["", "sha256=bad", `sha256=${hash(primaryBytes)}&fingerprint=${"d".repeat(64)}&path=other.pdf`, `sha256=${hash(primaryBytes)}&fingerprint=${"d".repeat(64)}&url=https://other.example`]) {
  test(`saved print rejects unbounded or caller-controlled download query ${query || "missing"}`, async () => {
    const saved = store(); const app = await buildApp(factory(saved));
    try { assert.equal((await app.inject({ method: "GET", url: `${rootPath}/${JOB}/download?${query}`, headers: auth })).statusCode, 422); assert.deepEqual(saved.downloads, []); }
    finally { await app.close(); }
  });
}
test("unauthenticated history and renewal fail before private source reads", async () => {
  const saved = store(); const app = await buildApp(factory(saved));
  try { assert.equal((await app.inject({ method: "GET", url: rootPath })).statusCode, 401); assert.deepEqual(saved.queries, []); }
  finally { await app.close(); }
});
test("print bytes obey an absolute deadline even when storage ignores cancellation", async () => {
  const saved = store(false); const confirmed = await savedPrintRender(factory(saved)("member"), WORKSPACE, BOOK, EDITION, saved.tables.publishing_jobs[0]);
  const sb = { storage: { from: () => ({ download: () => new Promise(() => {}) }) } } as never;
  await assert.rejects(verifySavedPrintBytes(sb, confirmed, AbortSignal.timeout(15), new Set()), /temporarily unavailable/u);
});

const proofPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64");
const pageReply = (content = primaryBytes, page = 1, width = 1080) => ({
  formatVersion: "pdf-proof-1.0.0", sourceSha256: hash(content), sourceSizeBytes: content.length,
  pageNumber: page, pageCount: 2, requestedWidth: width, pageWidthPoints: 432, pageHeightPoints: 648,
  text: "Saved interior <script>literal text only</script>", textTruncated: false,
  image: { mimeType: "image/png", width: 1, height: 1, sizeBytes: proofPng.length, sha256: hash(proofPng), base64: proofPng.toString("base64") },
});
const pagePath = (render: { source: { sha256: string }; fingerprint: string }, assetId = ASSET, page = "1", width = "1080") =>
  `${rootPath}/${JOB}/pages/${page}?sha256=${render.source.sha256}&fingerprint=${render.fingerprint}&assetId=${assetId}&width=${width}`;

async function pageApp(saved: Store, renderFetch: typeof fetch) {
  const previous = process.env.RENDERING_SERVICE_TOKEN;
  process.env.RENDERING_SERVICE_TOKEN = "synthetic-private-rendering-token-only";
  const app = await buildApp(factory(saved), { renderFetch });
  return { app, close: async () => { await app.close(); if (previous === undefined) delete process.env.RENDERING_SERVICE_TOKEN; else process.env.RENDERING_SERVICE_TOKEN = previous; } };
}

test("viewer reads the exact saved PDF page through private binary transport, never signs, renders or writes", async () => {
  const saved = store(); let calls = 0;
  const { app, close } = await pageApp(saved, async (input, init) => {
    calls++; const url = new URL(String(input)); assert.equal(url.pathname, "/pdf/preview");
    assert.equal(url.search, "?page=2&width=720"); assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
    assert(init?.signal instanceof AbortSignal); assert.deepEqual(init?.body, primaryBytes);
    const headers = new Headers(init?.headers); assert.equal(headers.get("x-content-sha256"), hash(primaryBytes));
    assert.equal(headers.get("content-type"), "application/pdf"); assert.equal(headers.get("authorization"), null);
    return Response.json(pageReply(primaryBytes, 2, 720));
  });
  try {
    const render = await listed(app); saved.tables.editions[0].updated_at = "2026-10-24T00:00:00Z";
    const reply = await app.inject({ method: "GET", url: pagePath(render, ASSET, "2", "720"), headers: auth });
    assert.equal(reply.statusCode, 200); assert.equal(reply.headers["cache-control"], "private, no-store");
    assert.equal(reply.json().source.role, "rendered_print"); assert.equal(reply.json().source.sha256, hash(primaryBytes));
    assert.equal(reply.json().image.sha256, hash(proofPng)); assert.equal(reply.json().fingerprint, render.fingerprint);
    assert.equal(calls, 1); assert.equal(saved.downloads.length, 1); assert.deepEqual(saved.signed, []); assert.deepEqual(saved.mutations, []);
    assert(saved.tokens.every(token => token === "member")); assert(!reply.body.includes("storagePath") && !reply.body.includes("private-rendering-token"));
  } finally { await close(); }
});

test("the exact saved full-cover PDF is independently verified and selected", async () => {
  const saved = store(); const { app, close } = await pageApp(saved, async (_input, init) => {
    assert.deepEqual(init?.body, coverBytes); return Response.json(pageReply(coverBytes));
  });
  try { const reply = await app.inject({ method: "GET", url: pagePath(await listed(app), COVER), headers: auth });
    assert.equal(reply.statusCode, 200); assert.equal(reply.json().source.role, "rendered_cover"); assert.equal(reply.json().source.sha256, hash(coverBytes)); }
  finally { await close(); }
});

for (const [name, mutate, status] of [
  ["revoked member", (saved: Store) => { saved.tables.workspace_members[0].status = "revoked"; }, 403],
  ["foreign workspace", (saved: Store) => { saved.tables.books[0].workspace_id = OTHER; }, 403],
  ["foreign job", (saved: Store) => { saved.tables.publishing_jobs[0].edition_id = OTHER; }, 404],
  ["deleted artifact", (saved: Store) => { saved.tables.assets[0].deleted_at = "2026-10-24"; }, 422],
  ["quarantine", (saved: Store) => { saved.tables.asset_versions[0].scan_status = "infected"; }, 422],
  ["changed fingerprint", (saved: Store) => { (saved.tables.publishing_jobs[0].request_json as Row).imageSha256 = "d".repeat(64); }, 409],
  ["corrupt bytes", (saved: Store) => { const content = Buffer.from(primaryBytes); content[50] ^= 1; saved.objects.set(String(saved.tables.assets[0].storage_path), content); }, 503],
] as const) test(`PDF pages reject ${name} before decoder dispatch`, async () => {
  const saved = store(); let calls = 0; const { app, close } = await pageApp(saved, async () => { calls++; return Response.json(pageReply()); });
  try { const render = await listed(app); mutate(saved); const reply = await app.inject({ method: "GET", url: pagePath(render), headers: auth });
    assert.equal(reply.statusCode, status); assert.equal(calls, 0); assert.deepEqual(saved.signed, []); assert.deepEqual(saved.mutations, []); }
  finally { await close(); }
});

for (const during of ["storage", "decoder"]) test(`membership revoked during ${during} cannot receive page pixels or text`, async () => {
  const saved = store(); let calls = 0; const revoke = () => { saved.tables.workspace_members[0].status = "revoked"; };
  const { app, close } = await pageApp(saved, async () => { calls++; if (during === "decoder") revoke(); return Response.json(pageReply()); });
  try { const render = await listed(app); if (during === "storage") saved.onDownload = revoke;
    const reply = await app.inject({ method: "GET", url: pagePath(render), headers: auth }); assert.equal(reply.statusCode, 403);
    assert.equal(calls, during === "decoder" ? 1 : 0); assert(!reply.body.includes(proofPng.toString("base64"))); }
  finally { await close(); }
});

for (const [name, mutate] of [
  ["wrong original hash", (r: ReturnType<typeof pageReply>) => { r.sourceSha256 = "d".repeat(64); }],
  ["wrong original size", (r: ReturnType<typeof pageReply>) => { r.sourceSizeBytes++; }],
  ["wrong page", (r: ReturnType<typeof pageReply>) => { r.pageNumber = 2; }],
  ["impossible page count", (r: ReturnType<typeof pageReply>) => { r.pageCount = 0; }],
  ["wrong resolution", (r: ReturnType<typeof pageReply>) => { r.requestedWidth = 720; }],
  ["wrong PNG hash", (r: ReturnType<typeof pageReply>) => { r.image.sha256 = "d".repeat(64); }],
  ["wrong PNG geometry", (r: ReturnType<typeof pageReply>) => { r.image.width = 2; }],
  ["oversized image", (r: ReturnType<typeof pageReply>) => { r.image.sizeBytes = 7 * 1024 * 1024; }],
  ["noncanonical base64", (r: ReturnType<typeof pageReply>) => { r.image.base64 += "\n"; }],
  ["text controls", (r: ReturnType<typeof pageReply>) => { r.text = "private\u0000text"; }],
] as const) test(`PDF page response rejects ${name} without leaking pixels`, async () => {
  const saved = store(); const { app, close } = await pageApp(saved, async () => { const reply = pageReply(); mutate(reply); return Response.json(reply); });
  try { const reply = await app.inject({ method: "GET", url: pagePath(await listed(app)), headers: auth });
    assert.equal(reply.statusCode, 503); assert(!reply.body.includes(proofPng.toString("base64"))); }
  finally { await close(); }
});

for (const [name, response, status] of [
  ["decoder page rejection", () => Response.json({ detail: "internal native diagnostic" }, { status: 422 }), 422],
  ["decoder outage", () => new Response("private diagnostic", { status: 500 }), 503],
  ["HTML reply", () => new Response("<html>private</html>"), 503],
  ["oversized reply header", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(11 * 1024 * 1024) } }), 503],
] as const) test(`PDF proof handles ${name} opaquely`, async () => {
  const saved = store(); const { app, close } = await pageApp(saved, async () => response());
  try { const reply = await app.inject({ method: "GET", url: pagePath(await listed(app)), headers: auth });
    assert.equal(reply.statusCode, status); assert(!reply.body.includes("diagnostic")); }
  finally { await close(); }
});

test("PDF page route accepts no caller-controlled URLs, paths, invalid pages or foreign assets", async () => {
  const saved = store(); let calls = 0; const { app, close } = await pageApp(saved, async () => { calls++; return Response.json(pageReply()); });
  try { const render = await listed(app);
    for (const url of [pagePath(render) + "&url=https://other.example", pagePath(render, OTHER), pagePath(render, ASSET, "0"),
      pagePath(render, ASSET, "01"), pagePath(render, ASSET, "20001"), pagePath(render, ASSET, "1", "9999")]) {
      assert.equal((await app.inject({ method: "GET", url, headers: auth })).statusCode, 422);
    }
    assert.equal((await app.inject({ method: "GET", url: pagePath(render) })).statusCode, 401); assert.equal(calls, 0);
  } finally { await close(); }
});

test("PDF decoder streaming has an absolute deadline and cancels unread private replies", async () => {
  const previous = process.env.RENDERING_SERVICE_TOKEN; process.env.RENDERING_SERVICE_TOKEN = "synthetic-renderer-only";
  let cancelled = false; const tasks = new Set<Promise<unknown>>(); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25);
  try {
    await assert.rejects(requestSavedPdfPage(primaryBytes, { checksum: hash(primaryBytes), sizeBytes: primaryBytes.length }, 1, 1080,
      controller.signal, tasks, async () => new Response(new ReadableStream({
        start(stream) { stream.enqueue(new TextEncoder().encode("{")); }, cancel() { cancelled = true; },
      }), { headers: { "content-type": "application/json" } })), /temporarily unavailable/);
    await Promise.allSettled([...tasks]); assert(cancelled); assert.equal(tasks.size, 0);
  } finally { clearTimeout(timer); if (previous === undefined) delete process.env.RENDERING_SERVICE_TOKEN; else process.env.RENDERING_SERVICE_TOKEN = previous; }
});
