import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.DOCUMENT_SERVICE_URL = "http://document.internal";
process.env.DOCUMENT_SERVICE_TOKEN = "fixture-document-service-token";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { buildApp } = await import("./app.js");

const USER_ID = "11111111-1111-1111-1111-111111111111";
const WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
const BOOK_ID = "33333333-3333-3333-3333-333333333333";
const ASSET_ID = "44444444-4444-4444-4444-444444444444";
const CHAPTER_ID = "55555555-5555-5555-5555-555555555555";
const JOB_ID = "66666666-6666-4666-8666-666666666666";
const STORAGE_PATH = `${WORKSPACE_ID}/manuscripts/${ASSET_ID}/source.txt`;
const SOURCE_BYTES = Buffer.from("A clean manuscript source.", "utf8");
const SOURCE_CHECKSUM = createHash("sha256").update(SOURCE_BYTES).digest("hex");
const AUTH = { authorization: "Bearer good" };

type ScanStatus = "pending" | "clean" | "infected" | "error";

interface QueryCall {
  table: string;
  method: string;
  args: unknown[];
}

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

interface FixtureOptions {
  role?: string;
  scanStatus?: ScanStatus;
  checksum?: string;
  parsedNodes?: Array<Record<string, unknown>>;
  embeddedAssets?: Array<Record<string, unknown>>;
  receipt?: unknown;
  receiptError?: boolean;
}

function parserDocument(nodes: Array<Record<string, unknown>> = [{ id: "paragraph-1", type: "paragraph", text: "Imported chapter text." }]) {
  return {
    bookModel: {
      schemaVersion: "1.0",
      bookId: BOOK_ID,
      metadata: { title: "Imported book", author: "Author", language: "en" },
      styleGuide: { rules: [] },
      bookBible: { entities: [] },
      chapters: [{
        id: CHAPTER_ID,
        order: 0,
        title: "Opening",
        nodes,
      }],
      assets: [],
    },
    report: { warnings: [], confidence: "high" },
  };
}

async function fixture(options: FixtureOptions = {}) {
  const queryCalls: QueryCall[] = [];
  const rpcCalls: RpcCall[] = [];
  const parserCalls: Array<{ url: string; init?: RequestInit }> = [];
  const scannedImages: Buffer[] = [];
  const imageObjects = new Map<string, Buffer>();
  const downloads: string[] = [];
  const role = options.role ?? "editor";
  const scanStatus = options.scanStatus ?? "clean";
  const checksum = options.checksum ?? SOURCE_CHECKSUM;
  const rows: Record<string, { data: unknown; error: unknown }> = {
    manuscript_import_jobs: { data: [{ id: JOB_ID, book_id: BOOK_ID, source_asset_id: ASSET_ID,
      status: "queued", attempts: 0, error_code: null, created_at: new Date().toISOString(),
      available_at: new Date().toISOString(), completed_at: null }], error: null },
    book_import_receipts: { data: options.receipt ?? null, error: options.receiptError ? { message: "offline" } : null },
    books: {
      data: {
        id: BOOK_ID,
        workspace_id: WORKSPACE_ID,
        title: "Imported book",
        author_name: "Author",
        language: "en",
      },
      error: null,
    },
    workspace_members: { data: { role }, error: null },
    assets: {
      data: {
        id: ASSET_ID,
        workspace_id: WORKSPACE_ID,
        name: "source.txt",
        storage_path: STORAGE_PATH,
        size_bytes: SOURCE_BYTES.byteLength,
        checksum,
        deleted_at: null,
      },
      error: null,
    },
    asset_versions: { data: { scan_status: scanStatus }, error: null },
  };

  const supabase = {
    auth: {
      getUser: async (token: string) => token === "good"
        ? { data: { user: { id: USER_ID } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
    },
    from(table: string) {
      const result = rows[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "in", "order", "limit"]) {
        builder[method] = (...args: unknown[]) => {
          queryCalls.push({ table, method, args });
          return builder;
        };
      }
      builder.maybeSingle = async () => ({ ...result, data: Array.isArray(result.data) ? result.data[0] ?? null : result.data });
      builder.single = async () => ({ ...result, data: Array.isArray(result.data) ? result.data[0] ?? null : result.data });
      builder.then = (resolve: (value: unknown) => unknown) => resolve(result);
      return builder;
    },
    storage: {
      from: (_bucket: string) => ({
        download: async (path: string) => { downloads.push(path); return { data: new Blob([Uint8Array.from(imageObjects.get(path) ?? SOURCE_BYTES)]), error: null }; },
        upload: async (path: string, bytes: Buffer) => { imageObjects.set(path, bytes); return { error: null }; },
        remove: async (paths: string[]) => { paths.forEach((path) => imageObjects.delete(path)); return { error: null }; },
      }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (["enqueue_manuscript_import", "retry_manuscript_import"].includes(name)) return { data: (rows.manuscript_import_jobs.data as unknown[])[0], error: null };
      if (name === "complete_manuscript_import") return { data: {
        chapters: [{ id: CHAPTER_ID, title: "Opening" }], sourceAssetId: ASSET_ID,
        assetIds: (args.p_images as Array<{ id: string }>).map((image) => image.id), report: args.p_report,
      }, error: null };
      return name === "create_book_chapters"
        ? { data: [{ id: CHAPTER_ID, title: "Opening" }], error: null }
        : { data: null, error: null };
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    parserCalls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ...parserDocument(options.parsedNodes), embeddedAssets: options.embeddedAssets ?? [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const app = await buildApp(() => supabase as never, { assetScanner: { name: "fixture-scanner", scan: async ({ bytes }) => {
    scannedImages.push(bytes); return { verdict: "clean", signature: "fixture-v1" };
  } } });
  return {
    app,
    parserCalls,
    queryCalls,
    rpcCalls,
    scannedImages,
    downloads,
    close: async () => {
      globalThis.fetch = originalFetch;
      await app.close();
    },
  };
}

test("a clean current source version reaches the parser and persists imported chapters", async () => {
  const ctx = await fixture();
  try {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/v1/books/${BOOK_ID}/import`,
      headers: AUTH,
      payload: { assetId: ASSET_ID },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(ctx.parserCalls.length, 1);
    assert.equal(ctx.parserCalls[0]?.url, "http://document.internal/parse");
    assert.equal(new Headers(ctx.parserCalls[0]?.init?.headers).get("x-service-token"), "fixture-document-service-token");
    const parserPayload = JSON.parse(String(ctx.parserCalls[0]?.init?.body));
    assert.equal(parserPayload.assetId, ASSET_ID);
    assert.equal(Buffer.from(parserPayload.contentBase64, "base64").toString("utf8"), SOURCE_BYTES.toString("utf8"));
    assert.ok(ctx.queryCalls.some((call) => call.table === "asset_versions" && call.method === "eq" && call.args[0] === "storage_path" && call.args[1] === STORAGE_PATH));
    assert.deepEqual(ctx.rpcCalls, [{
      name: "complete_manuscript_import",
      args: {
        p_actor_id: USER_ID,
        p_book_id: BOOK_ID,
        p_chapters: [{
          title: "Opening",
          nodes: [{ id: "paragraph-1", type: "paragraph", text: "Imported chapter text." }],
        }],
        p_source_asset_id: ASSET_ID,
        p_source_checksum: SOURCE_CHECKSUM,
        p_images: [],
        p_report: { warnings: [], confidence: "high", chapterCount: 1, imageCount: 0 },
      },
    }]);
    assert.equal(response.json().sourceAssetId, ASSET_ID);
    assert.equal(response.json().report.chapterCount, 1);
  } finally {
    await ctx.close();
  }
});

test("import preserves formatting and table cells across validation into the atomic chapter write", async () => {
  const nodes = [
    { id: "rich", type: "paragraph", text: "Bold", attributes: { richText: [{ type: "text", text: "Bold", marks: [{ type: "bold" }] }] } },
    { id: "grid", type: "table", text: "Name\tDescription\nElara\tNavigator", rows: [["Name", "Description"], ["Elara", "Navigator"]] },
  ];
  const ctx = await fixture({ parsedNodes: nodes });
  try {
    const response = await ctx.app.inject({ method: "POST", url: `/v1/books/${BOOK_ID}/import`, headers: AUTH, payload: { assetId: ASSET_ID } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(ctx.rpcCalls[0].args.p_chapters, [{ title: "Opening", nodes }]);
  } finally { await ctx.close(); }
});

test("embedded parser images reach scanned private storage and atomic chapter reference remapping", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const ctx = await fixture({ parsedNodes: [
    { id: "text", type: "paragraph", text: "Before the picture" },
    { id: "picture", type: "image", assetId: WORKSPACE_ID, altText: "Harbor" },
  ], embeddedAssets: [{ id: WORKSPACE_ID, filename: "harbor.png", mimeType: "image/png", sizeBytes: png.length,
    checksumSha256: createHash("sha256").update(png).digest("hex"), contentBase64: png.toString("base64") }] });
  try {
    const response = await ctx.app.inject({ method: "POST", url: `/v1/books/${BOOK_ID}/import`, headers: AUTH, payload: { assetId: ASSET_ID } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(ctx.scannedImages, [png]);
    const call = ctx.rpcCalls[0];
    assert.equal(call.name, "complete_manuscript_import");
    assert.equal(call.args.p_actor_id, USER_ID);
    const images = call.args.p_images as Array<{ id: string }>;
    const chapters = call.args.p_chapters as Array<{ nodes: Array<{ assetId?: string }> }>;
    assert.equal(chapters[0].nodes[1].assetId, images[0].id);
    assert.notEqual(images[0].id, WORKSPACE_ID);
    assert.ok(!response.body.includes(png.toString("base64")));
    assert.equal(response.json().report.imageCount, 1);
  } finally { await ctx.close(); }
});

for (const scanStatus of ["pending", "infected", "error"] as const) {
  test(`${scanStatus} current source versions stay quarantined before parser access`, async () => {
    const ctx = await fixture({ scanStatus });
    try {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/v1/books/${BOOK_ID}/import`,
        headers: AUTH,
        payload: { assetId: ASSET_ID },
      });

      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, "conflict");
      assert.equal(ctx.parserCalls.length, 0);
      assert.equal(ctx.rpcCalls.length, 0);
    } finally {
      await ctx.close();
    }
  });
}

test("stored-byte checksum mismatch fails before parser access", async () => {
  const ctx = await fixture({ checksum: "0".repeat(64) });
  try {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/v1/books/${BOOK_ID}/import`,
      headers: AUTH,
      payload: { assetId: ASSET_ID },
    });

    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.message, "Original manuscript checksum verification failed");
    assert.equal(ctx.parserCalls.length, 0);
    assert.equal(ctx.rpcCalls.length, 0);
  } finally {
    await ctx.close();
  }
});

test("a viewer cannot import or reach the document parser", async () => {
  const ctx = await fixture({ role: "viewer" });
  try {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/v1/books/${BOOK_ID}/import`,
      headers: AUTH,
      payload: { assetId: ASSET_ID },
    });

    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error.code, "unauthorized");
    assert.equal(ctx.parserCalls.length, 0);
    assert.equal(ctx.rpcCalls.length, 0);
    assert.equal(ctx.queryCalls.some((call) => call.table === "assets"), false);
  } finally {
    await ctx.close();
  }
});

test("missing document credentials fail before parser calls or chapter writes", async () => {
  const ctx = await fixture();
  const token = process.env.DOCUMENT_SERVICE_TOKEN;
  const fallback = process.env.SERVICE_AUTH_TOKEN;
  delete process.env.DOCUMENT_SERVICE_TOKEN;
  delete process.env.SERVICE_AUTH_TOKEN;
  try {
    const response = await ctx.app.inject({ method: "POST", url: `/v1/books/${BOOK_ID}/import`, headers: AUTH, payload: { assetId: ASSET_ID } });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(ctx.parserCalls.length, 0);
    assert.equal(ctx.rpcCalls.length, 0);
  } finally {
    if (token !== undefined) process.env.DOCUMENT_SERVICE_TOKEN = token;
    if (fallback !== undefined) process.env.SERVICE_AUTH_TOKEN = fallback;
    await ctx.close();
  }
});

const savedImport = { chapters: [{ id: CHAPTER_ID, title: "Saved opening" }], assetIds: [], sourceAssetId: ASSET_ID,
  report: { chapterCount: 1, imageCount: 0, warnings: ["Review imported styles"] } };

test("completed text import replays its receipt without parser configuration, storage or writes", async () => {
  const ctx = await fixture({ receipt: { source_checksum: SOURCE_CHECKSUM, result: savedImport } });
  const url = process.env.DOCUMENT_SERVICE_URL;
  delete process.env.DOCUMENT_SERVICE_URL;
  try {
    const response = await ctx.app.inject({ method: "POST", url: `/v1/books/${BOOK_ID}/import`, headers: AUTH, payload: { assetId: ASSET_ID } });
    assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), savedImport);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.deepEqual(ctx.parserCalls, []); assert.deepEqual(ctx.downloads, []); assert.deepEqual(ctx.rpcCalls, []);
  } finally { if (url !== undefined) process.env.DOCUMENT_SERVICE_URL = url; await ctx.close(); }
});

test("receipt reads are book/source scoped, allow members, and strip private payload fields", async () => {
  const ctx = await fixture({ role: "viewer", receipt: { source_checksum: SOURCE_CHECKSUM, result: {
    ...savedImport, contentBase64: "private", chapters: [{ ...savedImport.chapters[0], content_json: "private" }],
    report: { ...savedImport.report, embeddedAssets: ["private"] },
  } } });
  try {
    const response = await ctx.app.inject({ method: "GET", url: `/v1/books/${BOOK_ID}/imports/${ASSET_ID}`, headers: AUTH });
    assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { import: savedImport });
    assert.equal(response.headers["cache-control"], "private, no-store");
    for (const [field, id] of [["book_id", BOOK_ID], ["source_asset_id", ASSET_ID]]) {
      assert.ok(ctx.queryCalls.some((call) => call.table === "book_import_receipts" && call.method === "eq" && call.args[0] === field && call.args[1] === id));
    }
    assert.deepEqual(ctx.parserCalls, []); assert.deepEqual(ctx.rpcCalls, []);
  } finally { await ctx.close(); }
});

test("missing receipt is explicit; anonymous and invalid-ID receipt reads are rejected", async () => {
  const ctx = await fixture();
  try {
    const path = `/v1/books/${BOOK_ID}/imports/${ASSET_ID}`;
    assert.deepEqual((await ctx.app.inject({ method: "GET", url: path, headers: AUTH })).json(), { import: null });
    assert.equal((await ctx.app.inject({ method: "GET", url: path })).statusCode, 401);
    assert.equal((await ctx.app.inject({ method: "GET", url: `/v1/books/${BOOK_ID}/imports/invalid`, headers: AUTH })).statusCode, 422);
  } finally { await ctx.close(); }
});

test("changed, corrupt and unavailable receipts fail closed before parser access", async () => {
  for (const [options, status] of [
    [{ receipt: { source_checksum: "f".repeat(64), result: savedImport } }, 409],
    [{ receipt: { source_checksum: SOURCE_CHECKSUM, result: { ...savedImport, sourceAssetId: BOOK_ID } } }, 503],
    [{ receiptError: true }, 503],
  ] as const) {
    const ctx = await fixture(options);
    try {
      const response = await ctx.app.inject({ method: "POST", url: `/v1/books/${BOOK_ID}/import`, headers: AUTH, payload: { assetId: ASSET_ID } });
      assert.equal(response.statusCode, status, response.body); assert.deepEqual(ctx.parserCalls, []); assert.deepEqual(ctx.downloads, []);
    } finally { await ctx.close(); }
  }
});

test("a receipt cannot bypass the current source's quarantine on import replay", async () => {
  const ctx = await fixture({ scanStatus: "infected", receipt: { source_checksum: SOURCE_CHECKSUM, result: savedImport } });
  try {
    const response = await ctx.app.inject({ method: "POST", url: `/v1/books/${BOOK_ID}/import`, headers: AUTH, payload: { assetId: ASSET_ID } });
    assert.equal(response.statusCode, 409); assert.deepEqual(ctx.parserCalls, []);
  } finally { await ctx.close(); }
});

test("an editor queues one durable import without exposing worker secrets", async () => {
  const ctx = await fixture();
  try {
    const response = await ctx.app.inject({ method: "POST", url: `/v1/books/${BOOK_ID}/import-jobs`, headers: AUTH,
      payload: { assetId: ASSET_ID } });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.json().job.status, "queued");
    assert.equal(response.json().job.source_checksum, undefined);
    assert.equal(response.json().job.lease_token, undefined);
    assert.ok(ctx.rpcCalls.some((call) => call.name === "enqueue_manuscript_import"
      && call.args.p_actor_id === USER_ID && call.args.p_book_id === BOOK_ID && call.args.p_source_asset_id === ASSET_ID));
    assert.equal(ctx.parserCalls.length, 0);
  } finally { await ctx.close(); }
});

test("members list bounded import status while invalid and anonymous requests fail", async () => {
  const ctx = await fixture({ role: "viewer" });
  try {
    const response = await ctx.app.inject({ method: "GET", url: `/v1/books/${BOOK_ID}/import-jobs`, headers: AUTH });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().jobs[0].id, JOB_ID);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.json().jobs[0].source_checksum, undefined);
    assert.equal((await ctx.app.inject({ method: "GET", url: "/v1/books/not-a-uuid/import-jobs", headers: AUTH })).statusCode, 422);
    assert.equal((await ctx.app.inject({ method: "GET", url: `/v1/books/${BOOK_ID}/import-jobs` })).statusCode, 401);
  } finally { await ctx.close(); }
});

test("failed import retry is scoped to the authorized book and audited through RPC", async () => {
  const ctx = await fixture();
  try {
    const response = await ctx.app.inject({ method: "POST", url: `/v1/books/${BOOK_ID}/import-jobs/${JOB_ID}/retry`, headers: AUTH,
      payload: {} });
    assert.equal(response.statusCode, 202, response.body);
    assert.ok(ctx.rpcCalls.some((call) => call.name === "retry_manuscript_import"
      && call.args.p_job_id === JOB_ID && call.args.p_actor_id === USER_ID));
    assert.ok(ctx.queryCalls.some((call) => call.table === "manuscript_import_jobs" && call.method === "eq"
      && call.args[0] === "book_id" && call.args[1] === BOOK_ID));
    assert.equal((await ctx.app.inject({ method: "POST", url: `/v1/books/${BOOK_ID}/import-jobs/not-a-uuid/retry`, headers: AUTH,
      payload: {} })).statusCode, 422);
  } finally { await ctx.close(); }
});
