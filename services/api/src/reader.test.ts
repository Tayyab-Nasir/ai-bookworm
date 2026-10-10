import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

// The test never loads the operator's local environment or opens a real service.
process.env.NODE_ENV = "production";
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_ANON_KEY = "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.QDRANT_URL = "http://localhost:6333";
process.env.LOG_LEVEL = "error";
process.env.RENDERING_SERVICE_TOKEN = "test-preview-token";
const { buildApp } = await import("./app.js");
const { previewSupabaseFetch, withinReaderDeadline, withPreviewAdmission, requestEpubPreview, validateEpubPreview, MAX_SAVED_EPUB_BYTES } = await import("./lib/rendered-epub.js");

type Row = Record<string, unknown>;
const USER = "a0000000-0000-4000-8000-000000000001";
const WORKSPACE = "a0000000-0000-4000-8000-000000000002";
const BOOK = "a0000000-0000-4000-8000-000000000003";
const EDITION = "a0000000-0000-4000-8000-000000000004";
const JOB = "a0000000-0000-4000-8000-000000000005";
const ASSET = "a0000000-0000-4000-8000-000000000006";
const OTHER = "a0000000-0000-4000-8000-000000000007";
const bytes = Buffer.from("PK\u0003\u0004saved immutable epub");
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const checksum = hash(bytes);
const path = `workspaces/${WORKSPACE}/assets/${ASSET}/v1/book.epub`;
const rootPath = `/v1/editions/${EDITION}/renders`;
const auth = { authorization: "Bearer member" };

function store() {
  return { tables: {
    books: [{ id: BOOK, workspace_id: WORKSPACE }],
    editions: [{ id: EDITION, book_id: BOOK, type: "ebook" }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, status: "active", role: "viewer" }],
    publishing_jobs: [{ id: JOB, book_id: BOOK, edition_id: EDITION, channel: "render", status: "succeeded", created_at: "2026-10-10T00:00:00.000Z",
      request_json: { action: "render" }, response_json: { artifacts: [{ assetId: ASSET, storagePath: path, filename: "book.epub", type: "rendered_book", role: "rendered_ebook", name: "Saved book", mimeType: "application/epub+zip", sizeBytes: bytes.length, checksum }], rendererVersion: "epub-test", usage: {} } }],
    assets: [{ id: ASSET, workspace_id: WORKSPACE, type: "rendered_book", storage_path: path, mime_type: "application/epub+zip", size_bytes: bytes.length, checksum, deleted_at: null, status: "draft" }],
    asset_versions: [{ asset_id: ASSET, version_number: 1, storage_path: path, mime_type: "application/epub+zip", size_bytes: bytes.length, checksum, scan_status: "trusted_generated" }],
  } as Record<string, Row[]>, object: Buffer.from(bytes), queries: [] as string[], factoryTokens: [] as (string | undefined)[], downloads: [] as string[], transports: [] as unknown[], mutations: [] as string[] };
}
type Store = ReturnType<typeof store>;
function factory(saved: Store) {
  return (token?: string, transport?: unknown) => {
    saved.factoryTokens.push(token); saved.transports.push(transport);
    return {
      auth: { getUser: async () => ({ data: { user: token === "member" ? { id: USER } : null }, error: null }) },
      from(table: string) {
        saved.queries.push(table);
        const filters: [string, unknown][] = [];
        let count = 100;
        const selected = () => saved.tables[table].filter(row => filters.every(([key, value]) => row[key] === value)).slice(0, count);
        const result = () => ({ data: selected(), error: null });
        const builder = {
          select: () => builder,
          eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
          is: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
          order: () => builder,
          limit: (value: number) => { count = value; return builder; },
          maybeSingle: async () => ({ data: selected()[0] ?? null, error: null }),
          then: (resolve: (value: unknown) => unknown) => resolve(result()),
          insert: () => { saved.mutations.push("insert"); throw new Error("no writes"); },
          update: () => { saved.mutations.push("update"); throw new Error("no writes"); },
        };
        return builder;
      },
      storage: { from: (bucket: string) => ({ download: async (objectPath: string) => {
        assert.equal(bucket, "book-assets"); saved.downloads.push(objectPath);
        return { data: new Blob([new Uint8Array(saved.object)]), error: null };
      }, upload: () => { saved.mutations.push("upload"); throw new Error("no writes"); } }) },
      rpc: () => { saved.mutations.push("rpc"); throw new Error("no writes"); },
    } as never;
  };
}
function documentResult() {
  return { formatVersion: "epub-reader-1.0.0", sourceSha256: checksum, sourceSizeBytes: bytes.length, layout: "reflowable",
    spine: [{ index: 0, title: "Opening", layout: "reflowable" }],
    document: { index: 0, title: "Opening", layout: "reflowable", direction: "ltr", html: "<section><h1>Opening</h1><p>Saved text.</p></section>", resources: [] }, warnings: [] };
}
function renderer(calls: { input: string; init?: RequestInit }[], output: unknown = documentResult()) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify(output), { headers: { "content-type": "application/json" } });
  };
}
function assertPreviewWire(init: RequestInit | undefined, immutable: Buffer, digest: string, selected: { spineIndex: number } | { resourceIndex: number }) {
  assert.equal(init?.method, "POST");
  assert.ok(init?.body instanceof Uint8Array, "Private preview must send the verified EPUB bytes, not base64/JSON.");
  assert.deepEqual(Buffer.from(init.body), immutable);
  assert.equal(hash(init.body), digest);
  const headers = new Headers(init.headers);
  assert.equal(headers.get("content-type"), "application/epub+zip");
  assert.equal(headers.get("x-epub-sha256"), digest);
  assert.equal(headers.get("x-service-token"), "test-preview-token");
  assert.equal(headers.get("x-epub-spine-index"), "spineIndex" in selected ? String(selected.spineIndex) : null);
  assert.equal(headers.get("x-epub-resource-index"), "resourceIndex" in selected ? String(selected.resourceIndex) : null);
  assert.equal(init.redirect, "error"); assert.ok(init.signal instanceof AbortSignal);
}

test("saved EPUB history is a member read with immutable source identity and no spend", async () => {
  const saved = store(); const calls: { input: string; init?: RequestInit }[] = [];
  const app = await buildApp(factory(saved), { renderFetch: renderer(calls) });
  try {
    const reply = await app.inject({ method: "GET", url: rootPath, headers: auth });
    assert.equal(reply.statusCode, 200);
    assert.deepEqual(reply.json(), { renders: [{ jobId: JOB, createdAt: "2026-10-10T00:00:00.000Z", source: { bookId: BOOK, editionId: EDITION, jobId: JOB, assetId: ASSET, version: 1, sha256: checksum, sizeBytes: bytes.length } }] });
    assert.equal(reply.headers["cache-control"], "private, no-store");
    assert.deepEqual(saved.downloads, []); assert.deepEqual(calls, []); assert.deepEqual(saved.mutations, []);
    assert.ok(saved.factoryTokens.every(token => token === "member"));
  } finally { await app.close(); }
});

test("saved EPUB section verifies exact private bytes and calls preview, never render", async () => {
  const saved = store(); const calls: { input: string; init?: RequestInit }[] = [];
  const app = await buildApp(factory(saved), { renderFetch: renderer(calls) });
  try {
    const before = JSON.stringify(saved.tables);
    for (let n = 0; n < 2; n++) {
      const reply = await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader?spine=0&sha256=${checksum}`, headers: auth });
      assert.equal(reply.statusCode, 200); assert.equal(reply.json().source.sha256, checksum);
      assert.equal(reply.json().document.html, documentResult().document.html);
    }
    assert.equal(calls.length, 2); assert.ok(calls.every(call => call.input.endsWith("/epub/preview")));
    for (const call of calls) assertPreviewWire(call.init, bytes, checksum, { spineIndex: 0 });
    assert.equal(new Headers(calls[0].init?.headers).get("x-service-token"), "test-preview-token");
    assert.equal(calls[0].init?.redirect, "error"); assert.ok(calls[0].init?.signal instanceof AbortSignal);
    assert.ok(saved.transports.slice(1).some(value => typeof value === "function"));
    assert.ok(saved.factoryTokens.every(token => token === "member"));
    assert.equal(JSON.stringify(saved.tables), before); assert.deepEqual(saved.mutations, []);
  } finally { await app.close(); }
});

for (const [name, mutate, status] of [
  ["inactive membership", (saved: Store) => { saved.tables.workspace_members[0].status = "invited"; }, 403],
  ["foreign edition job", (saved: Store) => { saved.tables.publishing_jobs[0].edition_id = OTHER; }, 404],
  ["foreign book job", (saved: Store) => { saved.tables.publishing_jobs[0].book_id = OTHER; }, 404],
  ["failed render", (saved: Store) => { saved.tables.publishing_jobs[0].status = "failed"; }, 422],
  ["package job", (saved: Store) => { saved.tables.publishing_jobs[0].channel = "kdp"; }, 422],
  ["non-render action", (saved: Store) => { saved.tables.publishing_jobs[0].request_json = { action: "export_package" }; }, 422],
  ["deleted asset", (saved: Store) => { saved.tables.assets[0].deleted_at = "2026-10-10"; }, 422],
  ["foreign workspace asset", (saved: Store) => { saved.tables.assets[0].workspace_id = OTHER; }, 422],
  ["quarantined version", (saved: Store) => { saved.tables.asset_versions[0].scan_status = "pending"; }, 422],
  ["changed version", (saved: Store) => { saved.tables.asset_versions[0].version_number = 2; }, 422],
  ["changed version checksum", (saved: Store) => { saved.tables.asset_versions[0].checksum = "a".repeat(64); }, 422],
  ["changed private bytes", (saved: Store) => { saved.object = Buffer.from("tampered private epub"); }, 422],
] as const) test(`saved EPUB rejects ${name} without preview or writes`, async () => {
  const saved = store(); mutate(saved); const calls: { input: string; init?: RequestInit }[] = [];
  const app = await buildApp(factory(saved), { renderFetch: renderer(calls) });
  try {
    const reply = await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader?spine=0&sha256=${checksum}`, headers: auth });
    assert.equal(reply.statusCode, status); assert.equal(calls.length, 0); assert.deepEqual(saved.mutations, []);
    assert.ok(!reply.body.includes(path)); assert.ok(!reply.body.includes("test-preview-token"));
  } finally { await app.close(); }
});

for (const query of ["spine=-1", "spine=1.2", "spine=0&path=book.xhtml", "spine=0&sha256=bad", "spine=0&url=https%3A%2F%2Fevil.test"]) test(`saved EPUB rejects caller-controlled preview query ${query}`, async () => {
  const saved = store(); const app = await buildApp(factory(saved));
  try { assert.equal((await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader?${query}`, headers: auth })).statusCode, 422); assert.deepEqual(saved.downloads, []); }
  finally { await app.close(); }
});

test("saved EPUB requires the listed source digest on every read", async () => {
  const saved = store(); const calls: { input: string; init?: RequestInit }[] = [];
  const app = await buildApp(factory(saved), { renderFetch: renderer(calls) });
  try {
    const reply = await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader?spine=0&sha256=${"a".repeat(64)}`, headers: auth });
    assert.equal(reply.statusCode, 409); assert.deepEqual(saved.downloads, []); assert.deepEqual(calls, []);
  } finally { await app.close(); }
});

for (const [name, mutate] of [
  ["wrong source hash", (value: ReturnType<typeof documentResult>) => { value.sourceSha256 = "a".repeat(64); }],
  ["wrong source size", (value: ReturnType<typeof documentResult>) => { value.sourceSizeBytes++; }],
  ["wrong section index", (value: ReturnType<typeof documentResult>) => { value.document.index = 1; }],
  ["script element", (value: ReturnType<typeof documentResult>) => { value.document.html = "<script>alert(1)</script>"; }],
  ["event handler", (value: ReturnType<typeof documentResult>) => { value.document.html = '<p onclick="alert(1)">text</p>'; }],
  ["external image", (value: ReturnType<typeof documentResult>) => { value.document.html = '<img src="https://evil.test/a.png">'; }],
  ["raw CSS", (value: ReturnType<typeof documentResult>) => { value.document.html = '<p style="position:fixed">text</p>'; }],
] as const) test(`saved EPUB rejects renderer ${name} without exposing its response`, async () => {
  const saved = store(); const output = documentResult(); mutate(output);
  const app = await buildApp(factory(saved), { renderFetch: renderer([], output) });
  try {
    const reply = await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader?spine=0&sha256=${checksum}`, headers: auth });
    assert.equal(reply.statusCode, 503); assert.ok(!reply.body.includes("evil.test")); assert.ok(!reply.body.includes("alert(1)")); assert.deepEqual(saved.mutations, []);
  } finally { await app.close(); }
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6UAAAAASUVORK5CYII=", "base64");
function resourceResult() {
  return { formatVersion: "epub-reader-1.0.0", sourceSha256: checksum, sourceSizeBytes: bytes.length, warnings: [],
    resource: { index: 0, mimeType: "image/png", sha256: hash(png), sizeBytes: png.length, width: 1, height: 1, base64: png.toString("base64") } };
}
function expectedSource() { return { bookId: BOOK, editionId: EDITION, jobId: JOB, assetId: ASSET, version: 1 as const, sha256: checksum, sizeBytes: bytes.length }; }

test("reader validates the parser's full inert markup contract and stable image markers", () => {
  const { base64: _base64, ...resource } = resourceResult().resource;
  const output = documentResult();
  const value = { ...output, document: { ...output.document, resources: [resource], html:
    '<div dir="auto" id="saved-id" lang="en"><h1>Saved &amp; exact</h1><ol start="-2"><li value="3">Text</li></ol><table><thead><tr><th scope="col">Column</th></tr></thead><tbody><tr><td colspan="2" rowspan="1">Cell</td></tr></tbody></table><figure class="cover caption"><img alt="&quot;Saved&quot;\nimage" data-reader-resource="0" data-reader-width-percent="70" width="1" height="1"><figcaption>Saved art</figcaption></figure><hr class="page-break"><a>Inert link</a></div>' }, warnings: ["links-disabled"] };
  assert.equal((validateEpubPreview(value, expectedSource(), { spineIndex: 0 }) as { document: { html: string } }).document.html, value.document.html);
});

test("reader preserves a saved fixed raster and its exact viewport, with per-spine nav layout", () => {
  const { base64: _base64, ...resource } = resourceResult().resource;
  const value = { ...documentResult(), layout: "pre-paginated", spine: [{ index: 0, title: "Opening", layout: "pre-paginated" }, { index: 1, title: "Contents", layout: "reflowable" }],
    document: { ...documentResult().document, layout: "pre-paginated", width: 1, height: 1, resources: [resource], html: '<div><img alt="Saved page" data-reader-resource="0" height="1" width="1"></div>' } };
  const result = validateEpubPreview(value, expectedSource(), { spineIndex: 0 }) as { document: { width: number }; spine: { layout: string }[] };
  assert.equal(result.document.width, 1); assert.equal(result.spine[1].layout, "reflowable");
  for (const change of [
    { ...value, document: { ...value.document, width: 2 } },
    { ...value, document: { ...value.document, resources: [] } },
    { ...value, document: { ...value.document, html: '<div><p>Reconstructed text</p></div>' } },
    { ...value, document: { ...value.document, html: '<div><img data-reader-resource="0" width="2" height="1"></div>' } },
  ]) assert.throws(() => validateEpubPreview(change, expectedSource(), { spineIndex: 0 }));
});

test("reader rejects unknown/duplicate warnings, nonsequential spine and undeclared image indices", () => {
  const value = documentResult();
  for (const changed of [
    { ...value, warnings: ["private-path"] }, { ...value, warnings: ["links-disabled", "links-disabled"] },
    { ...value, spine: [{ ...value.spine[0], index: 1 }] },
    { ...value, document: { ...value.document, html: '<img data-reader-resource="0">' } },
    { ...value, document: { ...value.document, html: '<p data-unknown="1">Text</p>' } },
    { ...value, document: { ...value.document, html: '<p>Text</div>' } },
  ]) assert.throws(() => validateEpubPreview(changed, expectedSource(), { spineIndex: 0 }));
});

test("reader rejects malformed dependency markup with bounded linear scanning", () => {
  for (const html of ["<p", "<p><<span></span></p>", "<p>Saved</p><", "<img alt=\"<\" data-reader-resource=\"0\">"]) {
    const value = documentResult(); value.document.html = html;
    assert.throws(() => validateEpubPreview(value, expectedSource(), { spineIndex: 0 }));
  }
  // Run this malformed 64 KiB response in an isolated child with a hard bound,
  // so a regressed quadratic scanner cannot hang the API test process.
  const module = new URL("./lib/rendered-epub.ts", import.meta.url).href;
  const value = documentResult();
  const code = `import { validateEpubPreview } from ${JSON.stringify(module)};
const value = ${JSON.stringify(value)};
for (const html of ["<".repeat(65_536), "<p" + " ".repeat(65_536) + "=>"]) {
  value.document.html = html;
  try { validateEpubPreview(value, ${JSON.stringify(expectedSource())}, { spineIndex: 0 }); process.exitCode = 1; }
  catch (error) { if (error.status !== 503) throw error; }
}`;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => ["path", "systemroot", "windir", "comspec", "pathext", "temp", "tmp", "localappdata", "programfiles", "programfiles(x86)", "allusersprofile"].includes(name.toLowerCase())));
  environment.NODE_ENV = "production"; environment.NODE_OPTIONS = "";
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: environment, encoding: "utf8", windowsHide: true, timeout: 2_000, maxBuffer: 16_384 });
  assert.equal(result.error, undefined, "Malformed markup rejection must complete within the isolated two-second safety bound.");
  assert.equal(result.status, 0, result.stderr.slice(-1000));
});

test("saved EPUB raster endpoint returns verified opaque resource, never caller ZIP paths", async () => {
  const saved = store(); const calls: { input: string; init?: RequestInit }[] = [];
  const app = await buildApp(factory(saved), { renderFetch: renderer(calls, resourceResult()) });
  try {
    const reply = await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader/resources/0?sha256=${checksum}`, headers: auth });
    assert.equal(reply.statusCode, 200); assert.deepEqual(reply.json(), { source: expectedSource(), resource: resourceResult().resource });
    assertPreviewWire(calls[0].init, bytes, checksum, { resourceIndex: 0 });
    assert.equal(reply.headers["cache-control"], "private, no-store"); assert.deepEqual(saved.mutations, []);
  } finally { await app.close(); }
});

for (const [name, mutate] of [
  ["wrong raster index", (value: ReturnType<typeof resourceResult>) => { value.resource.index = 1; }],
  ["wrong raster digest", (value: ReturnType<typeof resourceResult>) => { value.resource.sha256 = "a".repeat(64); }],
  ["wrong raster byte size", (value: ReturnType<typeof resourceResult>) => { value.resource.sizeBytes++; }],
  ["wrong raster dimensions", (value: ReturnType<typeof resourceResult>) => { value.resource.width = 2; }],
  ["noncanonical base64", (value: ReturnType<typeof resourceResult>) => { value.resource.base64 += "\n"; }],
  ["wrong raster signature", (value: ReturnType<typeof resourceResult>) => { const bad = Buffer.alloc(png.length); value.resource.base64 = bad.toString("base64"); value.resource.sha256 = hash(bad); }],
] as const) test(`saved EPUB rejects ${name}`, async () => {
  const saved = store(); const output = resourceResult(); mutate(output);
  const app = await buildApp(factory(saved), { renderFetch: renderer([], output) });
  try { assert.equal((await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader/resources/0?sha256=${checksum}`, headers: auth })).statusCode, 503); assert.deepEqual(saved.mutations, []); }
  finally { await app.close(); }
});

for (const [name, mutate] of [
  ["duplicate primary artifacts", (saved: Store) => { const response = saved.tables.publishing_jobs[0].response_json as { artifacts: Row[] }; response.artifacts.push({ ...response.artifacts[0] }); }],
  ["caller path traversal in descriptor", (saved: Store) => { (saved.tables.publishing_jobs[0].response_json as { artifacts: Row[] }).artifacts[0].storagePath = `workspaces/${WORKSPACE}/assets/${ASSET}/v1/../book.epub`; }],
  ["print descriptor masquerading as ebook", (saved: Store) => { (saved.tables.publishing_jobs[0].response_json as { artifacts: Row[] }).artifacts[0].mimeType = "application/pdf"; }],
  ["changed asset checksum", (saved: Store) => { saved.tables.assets[0].checksum = "a".repeat(64); }],
  ["archived asset", (saved: Store) => { saved.tables.assets[0].status = "archived"; }],
  ["wrong version MIME", (saved: Store) => { saved.tables.asset_versions[0].mime_type = "application/pdf"; }],
  ["wrong version size", (saved: Store) => { saved.tables.asset_versions[0].size_bytes = bytes.length + 1; }],
] as const) test(`saved EPUB rejects ${name} before private bytes`, async () => {
  const saved = store(); mutate(saved); const calls: { input: string; init?: RequestInit }[] = [];
  const app = await buildApp(factory(saved), { renderFetch: renderer(calls) });
  try {
    const reply = await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader?spine=0&sha256=${checksum}`, headers: auth });
    assert.equal(reply.statusCode, 422); assert.deepEqual(saved.downloads, []); assert.deepEqual(calls, []); assert.deepEqual(saved.mutations, []);
  } finally { await app.close(); }
});

test("saved EPUB history excludes malformed and unverified jobs without revealing descriptors", async () => {
  const saved = store(); const valid = structuredClone(saved.tables.publishing_jobs[0]);
  saved.tables.publishing_jobs.push({ ...valid, id: OTHER, response_json: { artifacts: [] } });
  const app = await buildApp(factory(saved));
  try {
    const reply = await app.inject({ method: "GET", url: rootPath, headers: auth });
    assert.equal(reply.statusCode, 200); assert.equal(reply.json().renders.length, 1);
    assert.ok(!reply.body.includes("storagePath")); assert.deepEqual(saved.downloads, []); assert.deepEqual(saved.mutations, []);
  } finally { await app.close(); }
});

test("saved EPUB viewer access never requires editor role, plan, catalog or credits", async () => {
  const saved = store(); const app = await buildApp(factory(saved), { renderFetch: renderer([]) });
  try {
    assert.equal((await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader?sha256=${checksum}`, headers: auth })).statusCode, 200);
    assert.ok(saved.queries.every(table => ["editions", "books", "workspace_members", "publishing_jobs", "assets", "asset_versions"].includes(table)));
    assert.ok(saved.factoryTokens.every(token => token === "member")); assert.deepEqual(saved.mutations, []);
  } finally { await app.close(); }
});

test("API admits one byte-reading preview, excludes history, and releases after success/error", async () => {
  const saved = store(); let entered: () => void = () => {}; let release: () => void = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const app = await buildApp(factory(saved), { renderFetch: async () => { calls++; entered(); await held; return new Response(JSON.stringify(documentResult()), { headers: { "content-type": "application/json" } }); } });
  try {
    const first = app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader?sha256=${checksum}`, headers: auth });
    await started;
    const second = await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader/resources/0?sha256=${checksum}`, headers: auth });
    assert.equal(second.statusCode, 503); assert.match(second.json().error.message, /busy/u); assert.equal(saved.downloads.length, 1); assert.equal(calls, 1);
    assert.equal((await app.inject({ method: "GET", url: rootPath, headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader?sha256=${checksum}` })).statusCode, 401);
    release(); assert.equal((await first).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader?sha256=${checksum}`, headers: auth })).statusCode, 200);
    assert.equal(calls, 2);
  } finally { release(); await app.close(); }
  const failedApp = await buildApp(factory(store()), { renderFetch: async () => { throw new Error("private reader dependency failure"); } });
  try { assert.equal((await failedApp.inject({ method: "GET", url: `${rootPath}/${JOB}/reader?sha256=${checksum}`, headers: auth })).statusCode, 503); }
  finally { await failedApp.close(); }
  assert.equal(await withPreviewAdmission(new AbortController().signal, async () => "slot released"), "slot released");
});

test("reader admission timeout returns promptly but releases only after owned fetch settles", async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20);
  let finish: (value: Response) => void = () => {};
  const held = new Promise<Response>(resolve => { finish = resolve; });
  try {
    await assert.rejects(withPreviewAdmission(controller.signal, tasks => requestEpubPreview(async () => held, bytes, expectedSource(), { spineIndex: 0 }, controller.signal, tasks)));
    await assert.rejects(withPreviewAdmission(new AbortController().signal, async () => "should remain busy"), error => /busy/u.test((error as Error).message));
    finish(new Response(JSON.stringify(documentResult()), { headers: { "content-type": "application/json" } }));
    // The tracked fetch resolves, its now-expired body is canceled, then the slot is released.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await withPreviewAdmission(new AbortController().signal, async () => "released after owned settlement"), "released after owned settlement");
  } finally { clearTimeout(timer); finish(new Response("")); }
});

test("reader admission waits for streamed cancellation settlement after its deadline", async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20);
  let completeCancel: () => void = () => {}; let cancellationStarted = false;
  const cancelled = new Promise<void>(resolve => { completeCancel = resolve; });
  const body = new ReadableStream<Uint8Array>({ cancel() { cancellationStarted = true; return cancelled; } });
  try {
    await assert.rejects(withPreviewAdmission(controller.signal, tasks => requestEpubPreview(async () => new Response(body, { headers: { "content-type": "application/json" } }), bytes, expectedSource(), { spineIndex: 0 }, controller.signal, tasks)));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(cancellationStarted, true);
    await assert.rejects(withPreviewAdmission(new AbortController().signal, async () => "should remain busy"));
    completeCancel(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(await withPreviewAdmission(new AbortController().signal, async () => "released"), "released");
  } finally { clearTimeout(timer); completeCancel(); }
});

test("reader admission owns the Supabase streamed pump until cancellation settles", async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20);
  let finish: () => void = () => {}; let cancelCalled = false;
  const cancellation = new Promise<void>(resolve => { finish = resolve; });
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelCalled = true; return cancellation; } });
  try {
    await assert.rejects(withPreviewAdmission(controller.signal, async tasks => {
      const transport = previewSupabaseFetch(controller.signal, async () => new Response(body), tasks);
      const response = await transport("https://private.test/rest/v1/asset_versions");
      return response.text();
    }));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelCalled, true);
    await assert.rejects(withPreviewAdmission(new AbortController().signal, async () => "still owned"));
    finish(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(await withPreviewAdmission(new AbortController().signal, async () => "settled"), "settled");
  } finally { clearTimeout(timer); finish(); }
});

test("saved EPUB requires member authentication", async () => {
  const saved = store(); const app = await buildApp(factory(saved));
  try { assert.equal((await app.inject({ method: "GET", url: rootPath })).statusCode, 401); assert.deepEqual(saved.queries, []); }
  finally { await app.close(); }
});

test("preview-specific Storage transport accepts 13 MiB without relaxing DB or worker caps", async () => {
  const value = new Uint8Array(13 * 1024 * 1024);
  const transport = previewSupabaseFetch(new AbortController().signal, async (_input, init) => {
    assert.equal(init?.redirect, "error"); return new Response(value, { headers: { "content-length": String(value.length) } });
  });
  const reply = await transport("https://private.test/storage/v1/object/book-assets/saved.epub");
  assert.equal((await reply.arrayBuffer()).byteLength, value.length);
  await assert.rejects(transport("https://private.test/rest/v1/publishing_jobs"), error => (error as { status?: number }).status === 503);
});

test("preview transport rejects declared Storage sizes over 150 MiB without buffering", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const transport = previewSupabaseFetch(new AbortController().signal, async () => new Response(body, { headers: { "content-length": String(MAX_SAVED_EPUB_BYTES + 1) } }));
  await assert.rejects(transport("https://private.test/storage/v1/object/book-assets/saved.epub"));
  assert.equal(cancelled, true);
});

test("preview transport enforces streamed DB and Storage caps even without content-length", async () => {
  for (const [url, chunkSize, count] of [["https://private.test/rest/v1/assets", 3 * 1024 * 1024, 2], ["https://private.test/storage/v1/object/book-assets/saved.epub", 12 * 1024 * 1024, 13]] as const) {
    const chunk = new Uint8Array(chunkSize); let sent = 0;
    const transport = previewSupabaseFetch(new AbortController().signal, async () => new Response(new ReadableStream({ pull(controller) {
      if (sent++ < count) controller.enqueue(chunk); else controller.close();
    } })));
    const response = await transport(url); const reader = response.body!.getReader();
    await assert.rejects(async () => { while (!(await reader.read()).done) { /* Discard chunks, never allocate the whole over-limit body. */ } });
    reader.releaseLock();
  }
});

test("reader absolute deadline terminates hanging DB work and a fetcher ignoring cancellation", async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20); const started = performance.now();
  try {
    await assert.rejects(withinReaderDeadline(controller.signal, () => new Promise(() => {})), error => (error as { status?: number }).status === 503);
    assert.ok(performance.now() - started < 1000);
    let calls = 0;
    const transport = previewSupabaseFetch(controller.signal, async () => { calls++; return new Promise(() => {}); });
    await assert.rejects(transport("https://private.test/rest/v1/assets")); assert.equal(calls, 0);
  } finally { clearTimeout(timer); }
  const fetchDeadline = new AbortController(); const fetchTimer = setTimeout(() => fetchDeadline.abort(), 20);
  try { await assert.rejects(previewSupabaseFetch(fetchDeadline.signal, async () => new Promise(() => {}))("https://private.test/rest/v1/assets")); }
  finally { clearTimeout(fetchTimer); }
});

test("reader streamed preview body shares its absolute deadline and cancels stalled streams", async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  try {
    await assert.rejects(requestEpubPreview(async () => new Response(body, { headers: { "content-type": "application/json" } }), bytes, expectedSource(), { spineIndex: 0 }, controller.signal), error => (error as { status?: number }).status === 503);
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
});

for (const [name, response] of [
  ["private error body", () => new Response("private/path and token must not escape", { status: 500 })],
  ["non JSON", () => new Response("private response", { headers: { "content-type": "text/html" } })],
  ["malformed JSON", () => new Response("{private", { headers: { "content-type": "application/json" } })],
  ["oversized declaration", () => new Response("private", { headers: { "content-type": "application/json", "content-length": String(41 * 1024 * 1024) } })],
] as const) test(`saved EPUB rejects ${name} with opaque errors`, async () => {
  const saved = store(); const app = await buildApp(factory(saved), { renderFetch: async () => response() });
  try {
    const reply = await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader?sha256=${checksum}`, headers: auth });
    assert.equal(reply.statusCode, 503); assert.ok(!reply.body.includes("private/path")); assert.ok(!reply.body.includes("{private")); assert.deepEqual(saved.mutations, []);
  } finally { await app.close(); }
});

test("real saved reflowable and fixed EPUB bytes round-trip through private ASGI preview and member API without regeneration", async () => {
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  // The immutable-candidate verifier already supplies this local test runtime.
  const python = process.env.BOOKWORM_PYTHON ?? fileURLToPath(new URL("../../../.venv/Scripts/python.exe", import.meta.url));
  const fixture = `import base64, copy, hashlib, io, json, os, sys, zipfile
from pathlib import Path
sys.path.insert(0, str(Path("services/rendering").resolve()))
from PIL import Image
from editions import EbookEdition
from epub_renderer import render_epub
from epub_preview import preview_epub
from fastapi.testclient import TestClient
from main import app
os.environ["RENDERING_SERVICE_TOKEN"] = "test-preview-token"
client = TestClient(app, raise_server_exceptions=False)
def private_preview(data, spine_index=None, resource_index=None):
    headers = {"content-type": "application/epub+zip", "x-service-token": "test-preview-token", "x-epub-sha256": hashlib.sha256(data).hexdigest()}
    if resource_index is None:
        headers["x-epub-spine-index"] = str(0 if spine_index is None else spine_index)
    else:
        headers["x-epub-resource-index"] = str(resource_index)
    response = client.post("/epub/preview", headers=headers, content=data)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    actual = response.json()
    expected = preview_epub(data, spine_index=0 if spine_index is None else spine_index, resource_index=resource_index)
    assert actual == expected
    return actual
book = json.loads(Path("tests/fixtures/books/valid_book.json").read_text(encoding="utf-8"))
book["bookId"] = "${BOOK}"
book["chapters"][0]["nodes"][1]["text"] = "Saved & exact <words> must survive, never reconstructed."
art_id = "33333333-3333-4333-8333-333333333333"
image = io.BytesIO()
Image.new("RGB", (120, 180), "#234567").save(image, "PNG")
art = image.getvalue()
output = {}
for flow in ("reflowable", "fixed"):
    data = render_epub(copy.deepcopy(book), EbookEdition(flow=flow, include_title_page=True, navigation="toc+landmarks", cover={"asset_id": art_id}), cover_bytes=art, image_bytes={art_id: art})[0]
    first = private_preview(data)
    sections = [private_preview(data, spine_index=item["index"]) for item in first["spine"]]
    resource_indices = sorted({resource["index"] for section in sections for resource in section["document"]["resources"]})
    output[flow] = {"bytesBase64": base64.b64encode(data).decode("ascii"), "sha256": hashlib.sha256(data).hexdigest(), "sections": sections, "resources": [private_preview(data, resource_index=index) for index in resource_indices]}
    if flow == "reflowable":
        jpeg_stream = io.BytesIO()
        Image.new("RGB", (120, 180), "#234567").save(jpeg_stream, "JPEG")
        jpeg = jpeg_stream.getvalue()
        saved = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(data)) as original, zipfile.ZipFile(saved, "w") as changed:
            for item in original.infolist():
                name = item.filename
                content = original.read(item)
                if name.endswith(art_id + ".png"):
                    name = name.removesuffix(".png") + ".jpg"
                    content = jpeg
                elif name.endswith((".opf", ".xhtml")):
                    content = content.replace((art_id + ".png").encode(), (art_id + ".jpg").encode()).replace(b'media-type="image/png"', b'media-type="image/jpeg"')
                changed.writestr(name, content, compress_type=zipfile.ZIP_STORED if name == "mimetype" else zipfile.ZIP_DEFLATED)
        jpeg_data = saved.getvalue()
        jpeg_first = private_preview(jpeg_data)
        jpeg_sections = [private_preview(jpeg_data, spine_index=item["index"]) for item in jpeg_first["spine"]]
        jpeg_indices = sorted({resource["index"] for section in jpeg_sections for resource in section["document"]["resources"]})
        output["reflowable-jpeg"] = {"bytesBase64": base64.b64encode(jpeg_data).decode("ascii"), "sha256": hashlib.sha256(jpeg_data).hexdigest(), "sections": jpeg_sections, "resources": [private_preview(jpeg_data, resource_index=index) for index in jpeg_indices]}
client.close()
print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
`;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => ["path", "systemroot", "windir", "comspec", "pathext", "temp", "tmp", "localappdata", "programfiles", "programfiles(x86)", "allusersprofile"].includes(name.toLowerCase())));
  environment.PYTHONUTF8 = "1"; environment.PYTHONDONTWRITEBYTECODE = "1";
  const result = spawnSync(python, ["-c", fixture], { cwd: repository, env: environment, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined, "Local saved-EPUB fixture subprocess must complete.");
  assert.equal(result.status, 0, `Local saved-EPUB fixture failed: ${result.stderr.slice(-1000)}`);
  type NativeSection = ReturnType<typeof documentResult>;
  type NativeRaster = ReturnType<typeof resourceResult>;
  const actual = JSON.parse(result.stdout) as Record<string, { bytesBase64: string; sha256: string; sections: NativeSection[]; resources: NativeRaster[] }>;
  assert.deepEqual(Object.keys(actual).sort(), ["fixed", "reflowable", "reflowable-jpeg"]);
  for (const [flow, artifact] of Object.entries(actual)) {
    const saved = store(); const immutable = Buffer.from(artifact.bytesBase64, "base64");
    assert.equal(hash(immutable), artifact.sha256); saved.object = immutable;
    for (const row of [saved.tables.assets[0], saved.tables.asset_versions[0]]) { row.checksum = artifact.sha256; row.size_bytes = immutable.length; }
    const descriptor = (saved.tables.publishing_jobs[0].response_json as { artifacts: Row[] }).artifacts[0];
    descriptor.checksum = artifact.sha256; descriptor.sizeBytes = immutable.length;
    const original = JSON.stringify(saved.tables); let calls = 0;
    const app = await buildApp(factory(saved), { renderFetch: async (input, init) => {
      assert.ok(String(input).endsWith("/epub/preview")); assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      const resourceIndex = headers.get("x-epub-resource-index");
      const selected = resourceIndex === null ? { spineIndex: Number(headers.get("x-epub-spine-index")) } : { resourceIndex: Number(resourceIndex) };
      assertPreviewWire(init, immutable, artifact.sha256, selected);
      const response = "spineIndex" in selected
        ? artifact.sections.find(section => section.document.index === selected.spineIndex)
        : artifact.resources.find(resource => resource.resource.index === selected.resourceIndex);
      assert.ok(response, "Only the actual parser's selected saved section/resource may be returned."); calls++;
      return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
    } });
    try {
      const history = await app.inject({ method: "GET", url: rootPath, headers: auth });
      assert.equal(history.statusCode, 200); assert.equal(history.json().renders[0].source.sha256, artifact.sha256);
      for (const section of artifact.sections) {
        const reply = await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader?spine=${section.document.index}&sha256=${artifact.sha256}`, headers: auth });
        assert.equal(reply.statusCode, 200, `${flow} saved section must satisfy API's independent validator.`);
        assert.deepEqual(reply.json().document, section.document); assert.deepEqual(reply.json().spine, section.spine);
        assert.deepEqual(reply.json().warnings, section.warnings); assert.equal(reply.json().source.sizeBytes, immutable.length);
      }
      for (const resource of artifact.resources) {
        const reply = await app.inject({ method: "GET", url: `${rootPath}/${JOB}/reader/resources/${resource.resource.index}?sha256=${artifact.sha256}`, headers: auth });
        assert.equal(reply.statusCode, 200); assert.deepEqual(reply.json().resource, resource.resource);
        assert.equal(hash(Buffer.from(reply.json().resource.base64, "base64")), resource.resource.sha256);
      }
      assert.equal(calls, artifact.sections.length + artifact.resources.length);
      assert.equal(JSON.stringify(saved.tables), original); assert.deepEqual(saved.mutations, []);
      if (flow.startsWith("reflowable")) {
        assert.ok(artifact.sections.some(section => section.document.html.includes("Saved &amp; exact &lt;words&gt;")));
        if (flow === "reflowable-jpeg") assert.ok(artifact.resources.some(resource => resource.resource.mimeType === "image/jpeg"));
      }
      else { assert.ok(artifact.sections.some(section => section.document.layout === "pre-paginated")); assert.ok(artifact.sections.some(section => section.document.layout === "reflowable")); }
    } finally { await app.close(); }
  }
});
