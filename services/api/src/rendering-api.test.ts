import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { buildApp } = await import("./app.js");

type Row = Record<string, unknown>;
interface Store {
  tables: Record<string, Row[]>;
  objects: Map<string, Buffer>;
  downloads?: string[];
  signedPaths?: string[];
  queryErrors?: Record<string, { code: string }>;
  signError?: boolean;
  downloadBarrier?: () => Promise<void>;
  rpcError?: { code: string; message?: string; details?: string };
}

function fakeSupabase(store: Store) {
  return {
    auth: { getUser: async (token: string) => token === "good"
      ? { data: { user: { id: USER } }, error: null }
      : { data: { user: null }, error: { message: "bad" } } },
    storage: { from: () => ({
      upload: async (path: string, bytes: Buffer) => {
        if (store.objects.has(path)) return { data: null, error: { message: "exists" } };
        store.objects.set(path, Buffer.from(bytes));
        return { data: { path }, error: null };
      },
      download: async (path: string) => {
        const barrier = store.downloadBarrier; store.downloadBarrier = undefined; await barrier?.();
        store.downloads?.push(path);
        const bytes = store.objects.get(path);
        return bytes
          ? { data: new Blob([new Uint8Array(bytes)]), error: null }
          : { data: null, error: { message: "missing" } };
      },
      createSignedUrl: async (path: string, seconds: number) => {
        store.signedPaths?.push(path);
        if (store.signError) return { data: null, error: { message: "private signing diagnostic" } };
        return { data: { signedUrl: `signed:${seconds}:${path}` }, error: null };
      },
      remove: async (paths: string[]) => { paths.forEach((path) => store.objects.delete(path)); return { data: paths, error: null }; },
    }) },
    from: (table: string) => {
      const rows = (store.tables[table] ??= []);
      const filters: [string, unknown][] = [];
      let limit: number | null = null;
      let descending = false;
      let pendingInsert: Row | null = null;
      let pendingUpdate: Row | null = null;
      let insertError: { code: string } | null = null;
      const selected = () => {
        let result = rows.filter((row) => filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
        if (descending) result = [...result].reverse();
        return limit == null ? result : result.slice(0, limit);
      };
      const mutate = () => {
        if (pendingInsert) {
          if (table === "publishing_jobs" && rows.some((row) => row.idempotency_key === pendingInsert?.idempotency_key)) {
            pendingInsert = null;
            insertError = { code: "23505" };
            return [];
          }
          const row = { created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...pendingInsert };
          rows.push(row); pendingInsert = null; return [row];
        }
        if (pendingUpdate) {
          const result = selected();
          result.forEach((row) => Object.assign(row, pendingUpdate));
          pendingUpdate = null; return result;
        }
        return selected();
      };
      const result = () => { const data = mutate(); return { data, error: store.queryErrors?.[table] ?? insertError }; };
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (key: string, value: unknown) => { filters.push([key, value]); return builder; };
      builder.in = (key: string, value: unknown[]) => { filters.push([key, value]); return builder; };
      builder.is = (key: string, value: unknown) => { filters.push([key, value]); return builder; };
      builder.gte = () => builder;
      builder.order = (_key: string, options?: { ascending?: boolean }) => { descending ||= options?.ascending === false; return builder; };
      builder.limit = (value: number) => { limit = value; return builder; };
      builder.insert = (row: Row) => { pendingInsert = row; return builder; };
      builder.update = (row: Row) => { pendingUpdate = row; return builder; };
      builder.single = async () => { const value = result(); return { data: value.data[0] ?? null, error: value.error }; };
      builder.maybeSingle = async () => { const value = result(); return { data: value.data[0] ?? null, error: value.error }; };
      builder.then = (resolve: (value: unknown) => unknown) => resolve(result());
      return builder;
    },
    rpc: async (name: string, args: Row) => {
      if (name === "complete_publishing_package_job") {
        if (store.rpcError) return { data: null, error: store.rpcError };
        const job = store.tables.publishing_jobs.find((row) => row.id === args.p_job_id);
        if (!job) return { data: null, error: { code: "P0002" } };
        const artifact = args.p_artifact as Row;
        store.tables.assets.push({
          id: artifact.assetId, workspace_id: WORKSPACE, type: artifact.type, name: artifact.name,
          storage_path: artifact.storagePath, mime_type: artifact.mimeType, size_bytes: artifact.sizeBytes,
          checksum: artifact.checksum, status: "draft", deleted_at: null, created_by: USER,
        });
        store.tables.asset_versions.push({ asset_id: artifact.assetId, version_number: 1, storage_path: artifact.storagePath,
          checksum: artifact.checksum, mime_type: artifact.mimeType, size_bytes: artifact.sizeBytes, scan_status: "trusted_generated" });
        store.tables.asset_links.push({ asset_id: artifact.assetId, entity_type: "edition", entity_id: EDITION, usage_role: artifact.role });
        store.tables.usage_events.push({ publishing_job_id: job.id, organization_id: ORG, workspace_id: WORKSPACE, user_id: USER, meter: "publishing", quantity: 1 });
        Object.assign(job, {
          status: "succeeded", response_json: {
            artifact, ruleVersion: args.p_rule_version, sourceRenderJobId: args.p_source_render_job_id,
            sourcePreflightJobId: args.p_source_preflight_job_id, submissionMode: "manual",
          }, completed_at: new Date().toISOString(),
        });
        return { data: job, error: null };
      }
      if (name === "complete_preflight_job") {
        if (store.rpcError) return { data: null, error: store.rpcError };
        const job = store.tables.publishing_jobs.find((row) => row.id === args.p_job_id);
        if (!job) return { data: null, error: { code: "P0002" } };
        const result = args.p_result as { findings: Row[] } & Row;
        for (const finding of result.findings) {
          store.tables.publishing_validations.push({
            publishing_job_id: job.id, rule_version: finding.rule_version, severity: finding.severity,
            code: finding.code, message: finding.message, location_json: { path: finding.location },
          });
        }
        Object.assign(job, { status: "succeeded", response_json: result, completed_at: new Date().toISOString() });
        return { data: job, error: null };
      }
      if (name !== "complete_render_job") return { data: null, error: { code: "42883" } };
      if (store.rpcError) return { data: null, error: store.rpcError };
      const job = store.tables.publishing_jobs.find((row) => row.id === args.p_job_id);
      if (!job) return { data: null, error: { code: "P0002" } };
      for (const artifact of args.p_artifacts as Row[]) {
        store.tables.assets.push({
          id: artifact.assetId, workspace_id: WORKSPACE, type: artifact.type, name: artifact.name,
          storage_path: artifact.storagePath, mime_type: artifact.mimeType, size_bytes: artifact.sizeBytes,
          checksum: artifact.checksum, status: "draft", deleted_at: null, created_by: USER,
        });
        store.tables.asset_versions.push({ asset_id: artifact.assetId, version_number: 1, storage_path: artifact.storagePath, checksum: artifact.checksum });
        store.tables.asset_links.push({ asset_id: artifact.assetId, entity_type: "book", entity_id: BOOK, usage_role: artifact.role });
      }
      store.tables.usage_events.push({ publishing_job_id: job.id, organization_id: ORG, workspace_id: WORKSPACE, user_id: USER, meter: "rendering", quantity: 1 });
      Object.assign(job, {
        status: "succeeded", response_json: { artifacts: args.p_artifacts, rendererVersion: args.p_renderer_version, usage: args.p_usage },
        completed_at: new Date().toISOString(),
      });
      return { data: job, error: null };
    },
  } as never;
}

const USER = "d0000000-0000-4000-8000-000000000001";
const ORG = "d0000000-0000-4000-8000-000000000002";
const WORKSPACE = "d0000000-0000-4000-8000-000000000003";
const BOOK = "d0000000-0000-4000-8000-000000000004";
const EDITION = "d0000000-0000-4000-8000-000000000005";
const CHAPTER = "d0000000-0000-4000-8000-000000000006";
const COVER = "d0000000-0000-4000-8000-000000000007";
const ILLUSTRATION = "d0000000-0000-4000-8000-000000000008";
const auth = { authorization: "Bearer good" };

function sha(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }

function baseStore(role = "editor"): Store {
  const cover = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
  const illustration = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]);
  const coverPath = `workspaces/${WORKSPACE}/assets/${COVER}/v1/cover.png`;
  const illustrationPath = `workspaces/${WORKSPACE}/assets/${ILLUSTRATION}/v1/scene.png`;
  return {
    objects: new Map([[coverPath, cover], [illustrationPath, illustration]]),
    tables: {
      workspaces: [{ id: WORKSPACE, organization_id: ORG }],
      workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, role, status: "active" }],
      books: [{ id: BOOK, workspace_id: WORKSPACE, title: "River Moon", subtitle: null, author_name: "A. Writer", genre: "fantasy", language: "en" }],
      editions: [{ id: EDITION, book_id: BOOK, type: "ebook", updated_at: "2026-09-03T00:00:00.000Z", edition_metadata_json: { kind: "ebook", cover: { asset_id: COVER } } }],
      chapters: [{ id: CHAPTER, book_id: BOOK, title: "The Bridge", order_index: 0 }],
      document_versions: [{ id: crypto.randomUUID(), chapter_id: CHAPTER, version_number: 1, content_json: { schemaVersion: "1.0", nodes: [
        { id: "p1", type: "paragraph", text: "Mira crossed the moonlit bridge." },
        { id: "i1", type: "image", assetId: ILLUSTRATION },
      ] } }],
      assets: [
        { id: COVER, workspace_id: WORKSPACE, storage_path: coverPath, mime_type: "image/png", size_bytes: cover.length, checksum: sha(cover), status: "approved", deleted_at: null },
        { id: ILLUSTRATION, workspace_id: WORKSPACE, storage_path: illustrationPath, mime_type: "image/png", size_bytes: illustration.length, checksum: sha(illustration), status: "approved", deleted_at: null },
      ],
      book_metadata: [], style_guides: [], book_bible_items: [], subscriptions: [], plans: [],
      publishing_jobs: [], publishing_validations: [], asset_versions: [
        { asset_id: COVER, version_number: 1, storage_path: coverPath, checksum: sha(cover), scan_status: "clean", mime_type: "image/png", size_bytes: cover.length },
        { asset_id: ILLUSTRATION, version_number: 1, storage_path: illustrationPath, checksum: sha(illustration), scan_status: "clean", mime_type: "image/png", size_bytes: illustration.length },
      ], asset_links: [], usage_events: [], activity_events: [],
    },
  };
}

function successfulRenderer(requests: unknown[], coverRendererVersion: string | null = "cover-test") {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const artifact = Buffer.from("PK\u0003\u0004deterministic-epub");
    const cover = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]);
    return new Response(JSON.stringify({
      format: "epub", artifactBase64: artifact.toString("base64"), sha256: sha(artifact), rendererVersion: "epub-test",
      coverArtifactBase64: cover.toString("base64"), coverSha256: sha(cover), coverRendererVersion,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function enableRetailerPackages(store: Store) {
  const planId = "d0000000-0000-4000-8000-000000000009";
  store.tables.subscriptions.push({ id: crypto.randomUUID(), organization_id: ORG, plan_id: planId, status: "active", created_at: "2026-09-04T00:00:00Z", current_period_end: null });
  store.tables.plans.push({ id: planId, name: "team", entitlements_json: { publishing_channels: ["export", "kdp", "apple_books", "barnes_noble", "lulu", "google_play"] } });
}

function successfulRenderAndPreflight(requests: unknown[], channel = "kdp", coverRendererVersion = "cover-test") {
  return async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    if (String(input).endsWith("/preflight")) {
      return new Response(JSON.stringify({
        ruleVersion: `core-test+${channel}-test`, channel, errors: 0, warnings: 1, findings: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return successfulRenderer([], coverRendererVersion)(input, init);
  };
}

function successfulPackager(requests: unknown[], channel = "kdp") {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const packageBytes = Buffer.from("PK\u0003\u0004deterministic-channel-package");
    return new Response(JSON.stringify({
      channel, ruleVersion: `core-test+${channel}-test`, errors: 0,
      packages: [{ path: `${channel}-export.zip`, sha256: sha(packageBytes), dataBase64: packageBytes.toString("base64") }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function createReadySources(app: Awaited<ReturnType<typeof buildApp>>, channel = "kdp") {
  const render = await app.inject({ method: "POST", url: `/v1/editions/${EDITION}/render`, headers: auth, payload: { idempotencyKey: crypto.randomUUID() } });
  assert.equal(render.statusCode, 201, render.body);
  const preflight = await app.inject({ method: "POST", url: "/v1/publishing/validate", headers: auth, payload: {
    bookId: BOOK, editionId: EDITION, channel, idempotencyKey: crypto.randomUUID(),
  } });
  assert.equal(preflight.statusCode, 201, preflight.body);
  return { renderJobId: render.json().jobId as string, preflightJobId: preflight.json().jobId as string };
}

test("invalid publication-date overrides fail before edition creation or replacement", async (t) => {
  const store = baseStore();
  let dispatches = 0;
  const forbidden = async () => { dispatches++; throw new Error("Saving metadata must not dispatch processing"); };
  const app = await buildApp(() => fakeSupabase(store), { renderFetch: forbidden, publishingFetch: forbidden });
  t.after(() => app.close());
  const saved = structuredClone(store.tables.editions);
  for (const publicationDate of ["0000-01-01", "2026-02-30", "1900-02-29", "2026-1-01", "", "2026-01-01T00:00:00Z", null]) {
    const config = { kind: "ebook", metadata_overrides: { publicationDate } };
    const created = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/editions`, headers: auth, payload: { config } });
    assert.equal(created.statusCode, 422, created.body);
    const updated = await app.inject({ method: "PATCH", url: `/v1/editions/${EDITION}`, headers: auth,
      payload: { expectedUpdatedAt: saved[0].updated_at, config } });
    assert.equal(updated.statusCode, 422, updated.body);
    assert.deepEqual(store.tables.editions, saved, "invalid override mutated editions");
  }
  assert.equal(store.tables.activity_events.length, 0);
  assert.equal(store.tables.publishing_jobs.length, 0);
  assert.equal(store.tables.usage_events.length, 0);
  assert.equal(store.objects.size, 2);
  assert.equal(dispatches, 0);
  const overrides = { publicationDate: "2024-02-29", title: "Edition title", customNote: "Generic text remains supported" };
  const updated = await app.inject({ method: "PATCH", url: `/v1/editions/${EDITION}`, headers: auth,
    payload: { expectedUpdatedAt: saved[0].updated_at, config: { kind: "ebook", metadata_overrides: overrides } } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json().edition_metadata_json.metadata_overrides, overrides);
  assert.equal(dispatches, 0);
});

test("editor renders the saved edition into private durable artifacts and one usage event", async () => {
  const store = baseStore();
  store.tables.editions[0].language = "ar";
  const requests: unknown[] = [];
  const app = await buildApp(() => fakeSupabase(store), { renderFetch: successfulRenderer(requests) });
  const response = await app.inject({ method: "POST", url: `/v1/editions/${EDITION}/render`, headers: auth, payload: { idempotencyKey: "render-request-0001" } });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json();
  assert.equal(body.status, "succeeded");
  assert.equal(body.artifacts.length, 2);
  assert.ok(body.artifacts.every((item: Row) => String((item.download as Row).url).startsWith("signed:300:")));
  assert.equal(store.tables.usage_events.length, 1);
  assert.equal(store.tables.asset_versions.length, 4);
  assert.equal(store.tables.asset_links.length, 2);
  assert.equal(store.objects.size, 4);
  const request = requests[0] as { bookModel: { metadata: { title: string; language: string }; assets: Row[] }; coverBase64: string; assetImagesBase64: Record<string, string> };
  assert.equal(request.bookModel.metadata.title, "River Moon");
  assert.equal(request.bookModel.metadata.language, "ar");
  assert.equal(request.bookModel.assets[0].id, ILLUSTRATION);
  assert.ok(request.coverBase64);
  assert.ok(request.assetImagesBase64[ILLUSTRATION]);
  assert.equal(response.body.includes("Mira crossed"), false);
  await app.close();
});

test("render and preflight preserve saved illustration pins and reject a later revision before dispatch", async () => {
  for (const action of ["render", "validate"] as const) {
    const store = baseStore();
    const document = store.tables.document_versions[0].content_json as { nodes: Row[] };
    document.nodes[1].assetVersionNumber = 1;
    const requests: unknown[] = [];
    const app = await buildApp(() => fakeSupabase(store), { renderFetch: successfulRenderAndPreflight(requests) });
    try {
      const request = () => app.inject({ method: "POST", headers: auth,
        url: action === "render" ? `/v1/editions/${EDITION}/render` : "/v1/publishing/validate",
        payload: { idempotencyKey: crypto.randomUUID(), ...(action === "validate" ? { bookId: BOOK, editionId: EDITION, channel: "kdp" } : {}) },
      });
      const good = await request();
      assert.equal(good.statusCode, 201, good.body);
      const sent = (requests[0] as { body: { assetImagesBase64: Record<string, string> } }).body;
      assert.equal(sent.assetImagesBase64[ILLUSTRATION], store.objects.get(String(store.tables.assets[1].storage_path))!.toString("base64"));
      const jobs = store.tables.publishing_jobs.length;
      const usage = store.tables.usage_events.length;
      const calls = requests.length;
      store.tables.asset_versions.find(row => row.asset_id === ILLUSTRATION)!.version_number = 2;
      const stale = await request();
      assert.equal(stale.statusCode, 422, stale.body);
      assert.match(stale.body, /placed illustration version has changed/u);
      assert.equal(requests.length, calls, "stale placement must not dispatch rendering");
      assert.equal(store.tables.publishing_jobs.length, jobs);
      assert.equal(store.tables.usage_events.length, usage);
    } finally { await app.close(); }
  }
});

test("quarantine during render, preflight or packaging prevents completion and charges", async () => {
  for (const action of ["render", "validate", "export_package"] as const) {
    const store = baseStore();
    enableRetailerPackages(store);
    const app = await buildApp(() => fakeSupabase(store), {
      renderFetch: action === "export_package" ? successfulRenderAndPreflight([]) : async (url, init) => {
        store.tables.asset_versions[0].scan_status = "infected";
        return successfulRenderAndPreflight([])(url, init);
      },
      publishingFetch: async (url, init) => {
        store.tables.asset_versions[0].scan_status = "infected";
        return successfulPackager([])(url, init);
      },
    });
    try {
      const ready = action === "export_package" ? await createReadySources(app) : null;
      const usage = store.tables.usage_events.length;
      const objects = store.objects.size;
      const response = await app.inject({ method: "POST", headers: auth,
        url: action === "render" ? `/v1/editions/${EDITION}/render` : action === "validate" ? "/v1/publishing/validate" : "/v1/publishing/jobs",
        payload: { idempotencyKey: crypto.randomUUID(), ...(action === "render" ? {} : { bookId: BOOK, editionId: EDITION, channel: "kdp" }), ...ready },
      });
      assert.equal(response.statusCode, 422, response.body);
      assert.match(response.body, /clean.*confirmed current version/u);
      assert.equal(store.tables.usage_events.length, usage);
      assert.equal(store.objects.size, objects, "failed proof must remove only new attempt artifacts");
      assert.equal(store.tables.publishing_jobs.at(-1)?.status, "failed");
    } finally { await app.close(); }
  }
});

test("changed cover bytes invalidate stored render/preflight before package dispatch", async () => {
  const store = baseStore();
  enableRetailerPackages(store);
  const requests: unknown[] = [];
  const app = await buildApp(() => fakeSupabase(store), { renderFetch: successfulRenderAndPreflight([]), publishingFetch: successfulPackager(requests) });
  try {
    const ready = await createReadySources(app);
    const cover = store.tables.assets.find(asset => asset.id === COVER)!;
    const revised = Buffer.from([0x89, 0x50, 0x4e, 0x47, 25]);
    const path = String(cover.storage_path).replace("/v1/", "/v2/");
    Object.assign(cover, { storage_path: path, checksum: sha(revised), size_bytes: revised.length });
    store.objects.set(path, revised);
    store.tables.asset_versions.push({ asset_id: COVER, version_number: 2, storage_path: path, checksum: sha(revised), mime_type: "image/png", size_bytes: revised.length, scan_status: "clean" });
    const usage = store.tables.usage_events.length;
    const response = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth,
      payload: { bookId: BOOK, editionId: EDITION, channel: "kdp", idempotencyKey: crypto.randomUUID(), ...ready } });
    assert.equal(response.statusCode, 422, response.body);
    assert.match(response.body, /fresh successful render/u);
    assert.equal(requests.length, 0);
    assert.equal(store.tables.usage_events.length, usage);
  } finally { await app.close(); }
});

test("viewer cannot render or call the renderer", async () => {
  const store = baseStore("viewer");
  const requests: unknown[] = [];
  const app = await buildApp(() => fakeSupabase(store), { renderFetch: successfulRenderer(requests) });
  const response = await app.inject({ method: "POST", url: `/v1/editions/${EDITION}/render`, headers: auth, payload: { idempotencyKey: "render-request-0002" } });
  assert.equal(response.statusCode, 403);
  assert.equal(requests.length, 0);
  assert.equal(store.tables.publishing_jobs.length, 0);
  await app.close();
});

test("renderer failure records failure without artifacts or rendering usage", async () => {
  const store = baseStore();
  const originalObjects = store.objects.size;
  const app = await buildApp(() => fakeSupabase(store), { renderFetch: async () => new Response("provider detail", { status: 500 }) });
  const response = await app.inject({ method: "POST", url: `/v1/editions/${EDITION}/render`, headers: auth, payload: { idempotencyKey: "render-request-0003" } });
  assert.equal(response.statusCode, 503);
  assert.equal(store.tables.publishing_jobs[0].status, "failed");
  assert.equal(store.tables.usage_events.length, 0);
  assert.equal(store.objects.size, originalObjects);
  assert.equal(response.body.includes("provider detail"), false);
  await app.close();
});

test("renderer typography rejection remains actionable and never creates artifacts or usage", async () => {
  const store = baseStore();
  const originalObjects = store.objects.size;
  const app = await buildApp(() => fakeSupabase(store), { renderFetch: async () => new Response("renderer detail", { status: 422 }) });
  const response = await app.inject({ method: "POST", url: `/v1/editions/${EDITION}/render`, headers: auth, payload: { idempotencyKey: "render-request-rtl-422" } });
  assert.equal(response.statusCode, 422, response.body);
  assert.match(response.body, /Run preflight/u);
  assert.equal(response.body.includes("renderer detail"), false);
  assert.equal(store.tables.publishing_jobs[0].status, "failed");
  assert.equal(store.tables.usage_events.length, 0);
  assert.equal(store.objects.size, originalObjects);
  await app.close();
});

test("database completion failure compensates uploaded objects and does not charge", async () => {
  const store = baseStore();
  store.rpcError = { code: "42883" };
  const originalObjects = store.objects.size;
  const app = await buildApp(() => fakeSupabase(store), { renderFetch: successfulRenderer([]) });
  const response = await app.inject({ method: "POST", url: `/v1/editions/${EDITION}/render`, headers: auth, payload: { idempotencyKey: "render-request-0004" } });
  assert.equal(response.statusCode, 503);
  assert.equal(store.tables.publishing_jobs[0].status, "failed");
  assert.equal(store.tables.usage_events.length, 0);
  assert.equal(store.objects.size, originalObjects);
  await app.close();
});

test("atomic completion refusals are actionable, private and leave no new artifact or charge", async () => {
  for (const action of ["render", "validate", "export_package"] as const) {
    for (const code of ["40001", "22023", "42501"]) {
      const store = baseStore();
      enableRetailerPackages(store);
      const requests: unknown[] = [];
      const app = await buildApp(() => fakeSupabase(store), {
        renderFetch: successfulRenderAndPreflight(requests), publishingFetch: successfulPackager(requests),
      });
      try {
        const sources = action === "export_package" ? await createReadySources(app) : {};
        const counts = [store.objects.size, store.tables.assets.length, store.tables.usage_events.length, store.tables.publishing_validations.length];
        store.rpcError = { code, message: "private SQL detail", details: "bookworm_publishing_snapshot_changed" };
        const response = await app.inject({ method: "POST", headers: auth,
          url: action === "render" ? `/v1/editions/${EDITION}/render` : action === "validate" ? "/v1/publishing/validate" : "/v1/publishing/jobs",
          payload: { idempotencyKey: crypto.randomUUID(), ...(action === "render" ? {} : { bookId: BOOK, editionId: EDITION, channel: "kdp" }), ...sources },
        });
        assert.equal(response.statusCode, code === "42501" ? 403 : 422, `${action}/${code}: ${response.body}`);
        assert.match(response.body, code === "42501" ? /permission|access/iu : /again/iu);
        assert.equal(response.body.includes("private SQL detail"), false);
        assert.equal(response.body.includes("bookworm_publishing_snapshot_changed"), false);
        assert.deepEqual([store.objects.size, store.tables.assets.length, store.tables.usage_events.length, store.tables.publishing_validations.length], counts);
        const failed = store.tables.publishing_jobs.at(-1)!;
        assert.equal(failed.status, "failed");
        const snapshot = (failed.request_json as Row).artworkSnapshot as Row;
        assert.equal(snapshot.schemaVersion, 1);
        assert.equal((snapshot.assets as Row[]).length, 2);
        for (const sent of requests) {
          const request = sent as Row;
          assert.equal(((request.body as Row | undefined) ?? request).artworkSnapshot, undefined);
        }
      } finally { await app.close(); }
    }
  }
});

test("preflight validates saved content and persists deterministic findings", async () => {
  const store = baseStore();
  store.tables.editions[0].language = "he";
  const requests: unknown[] = [];
  const preflightFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      ruleVersion: "core-1.0.0+kdp-1.1.0",
      channel: "kdp",
      errors: 1,
      warnings: 0,
      findings: [{
        code: "NO_ALT_TEXT", message: "image lacks alt text", location: `chapter:${CHAPTER} node:i1`, severity: "error",
        category: "accessibility", rule_id: "CORE-A11Y-001", rule_version: "core-1.0.0+kdp-1.1.0",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const app = await buildApp(() => fakeSupabase(store), { renderFetch: preflightFetch });
  const response = await app.inject({ method: "POST", url: "/v1/publishing/validate", headers: auth, payload: {
    bookId: BOOK, editionId: EDITION, channel: "kdp", idempotencyKey: "preflight-request-0001",
  } });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json();
  assert.equal(body.requestedChannel, "kdp");
  assert.equal(body.errors, 1);
  assert.equal(store.tables.publishing_validations.length, 1);
  assert.equal(store.tables.publishing_jobs[0].status, "succeeded");
  const request = requests[0] as { channel: string; bookModel: { metadata: { title: string; language: string } } };
  assert.equal(request.channel, "kdp");
  assert.equal(request.bookModel.metadata.title, "River Moon");
  assert.equal(request.bookModel.metadata.language, "he");
  await app.close();
});

test("preflight rejects a validator response for another channel", async () => {
  const store = baseStore();
  const app = await buildApp(() => fakeSupabase(store), { renderFetch: async () => new Response(JSON.stringify({
    ruleVersion: "core-1.0.0", channel: "apple", errors: 0, warnings: 0, findings: [],
  }), { status: 200 }) });
  const response = await app.inject({ method: "POST", url: "/v1/publishing/validate", headers: auth, payload: {
    bookId: BOOK, editionId: EDITION, channel: "kdp", idempotencyKey: "preflight-request-0002",
  } });
  assert.equal(response.statusCode, 503);
  assert.equal(store.tables.publishing_jobs[0].status, "failed");
  assert.equal(store.tables.publishing_validations.length, 0);
  await app.close();
});

test("editor creates a durable private retailer package and can list, read, and replay it", async () => {
  const store = baseStore();
  store.tables.editions[0].language = "fa";
  enableRetailerPackages(store);
  const renderRequests: unknown[] = [];
  const packageRequests: unknown[] = [];
  const app = await buildApp(() => fakeSupabase(store), {
    renderFetch: successfulRenderAndPreflight(renderRequests), publishingFetch: successfulPackager(packageRequests),
  });
  const sources = await createReadySources(app);
  const payload = { bookId: BOOK, editionId: EDITION, channel: "kdp", ...sources, idempotencyKey: "package-request-0001" };
  const created = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth, payload });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json();
  assert.equal(body.status, "succeeded");
  assert.equal(body.submissionMode, "manual");
  assert.equal(body.package.asset.mime_type, "application/zip");
  assert.match(body.package.download.url, /^signed:300:/u);
  assert.equal(store.tables.usage_events.filter((row) => row.meter === "publishing").length, 1);
  assert.equal(store.objects.size, 5);
  const sent = packageRequests[0] as { channel: string; artifactsBase64: Record<string, string>; bookModel: { metadata: { title: string; language: string } } };
  assert.equal(sent.channel, "kdp");
  assert.equal(Buffer.from(sent.artifactsBase64["book.epub"], "base64").subarray(0, 2).toString(), "PK");
  assert.equal(sent.bookModel.metadata.title, "River Moon");
  assert.equal(sent.bookModel.metadata.language, "fa");
  assert.equal(created.body.includes("Mira crossed"), false);

  const listed = await app.inject({ method: "GET", url: `/v1/publishing/jobs?bookId=${BOOK}`, headers: auth });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().jobs.length, 1);
  assert.equal(listed.json().jobs[0].id, body.id);
  const detail = await app.inject({ method: "GET", url: `/v1/publishing/jobs/${body.id}`, headers: auth });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().package.asset.id, body.package.asset.id);

  const replay = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth, payload });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().id, body.id);
  assert.equal(packageRequests.length, 1);
  assert.equal(store.tables.usage_events.filter((row) => row.meter === "publishing").length, 1);
  await app.close();
});

test("package request recovery survives changed sources and plan loss without a second export", async () => {
  const store = baseStore(); enableRetailerPackages(store);
  const sent: unknown[] = [];
  const app = await buildApp(() => fakeSupabase(store), { renderFetch: successfulRenderAndPreflight([]), publishingFetch: successfulPackager(sent) });
  try {
    const sources = await createReadySources(app);
    const payload = { bookId: BOOK, editionId: EDITION, channel: "kdp", ...sources, idempotencyKey: crypto.randomUUID() };
    const headers = { ...auth, "idempotency-key": payload.idempotencyKey };
    const created = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers, payload });
    assert.equal(created.statusCode, 201, created.body);
    const original = created.json();
    store.tables.books[0].title = "Changed after accepted export";
    store.tables.subscriptions.length = 0;
    const recovered = await app.inject({ method: "GET", url: `/v1/publishing/requests/${payload.idempotencyKey}?bookId=${BOOK}`, headers: auth });
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(recovered.json().job.id, original.id);
    assert.equal(recovered.headers["cache-control"], "private, no-store");
    const replay = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers, payload });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().id, original.id);
    const mismatch = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers,
      payload: { ...payload, renderJobId: crypto.randomUUID() } });
    assert.equal(mismatch.statusCode, 409, mismatch.body);
    const closed = await app.inject({ method: "POST", url: "/v1/publishing/requests/close", headers, payload });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().job.id, original.id);
    assert.equal(closed.json().job.status, "succeeded");
    assert.equal(sent.length, 1);
    assert.equal(store.tables.usage_events.filter(row => row.meter === "publishing").length, 1);
    store.tables.publishing_jobs.find(row => row.id === original.id)!.created_by = crypto.randomUUID();
    const foreign = await app.inject({ method: "GET", url: `/v1/publishing/requests/${payload.idempotencyKey}?bookId=${BOOK}`, headers: auth });
    assert.equal(foreign.statusCode, 200); assert.equal(foreign.json().job, null);
  } finally { await app.close(); }
});

test("closing an unaccepted package request blocks delayed dispatch and never changes accepted work", async () => {
  const store = baseStore(); enableRetailerPackages(store);
  const sent: unknown[] = [];
  const app = await buildApp(() => fakeSupabase(store), { renderFetch: successfulRenderAndPreflight([]), publishingFetch: successfulPackager(sent) });
  try {
    const sources = await createReadySources(app);
    const payload = { bookId: BOOK, editionId: EDITION, channel: "kdp", ...sources, idempotencyKey: crypto.randomUUID() };
    const url = `/v1/publishing/requests/${payload.idempotencyKey}?bookId=${BOOK}`;
    for (const route of [{ method: "GET" as const, url }, { method: "POST" as const, url: "/v1/publishing/jobs", payload }, { method: "POST" as const, url: "/v1/publishing/requests/close", payload }]) {
      const changedActor = await app.inject({ ...route, headers: { ...auth, "x-bookworm-actor": crypto.randomUUID() } });
      assert.equal(changedActor.statusCode, 409);
    }
    const missing = await app.inject({ method: "GET", url, headers: auth });
    assert.equal(missing.statusCode, 200); assert.equal(missing.json().job, null);
    const count = store.tables.publishing_jobs.length;
    const closed = await app.inject({ method: "POST", url: "/v1/publishing/requests/close", headers: auth, payload });
    assert.equal(closed.statusCode, 200, closed.body); assert.equal(closed.json().job.status, "cancelled");
    const late = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth, payload });
    assert.equal(late.statusCode, 409, late.body);
    const again = await app.inject({ method: "POST", url: "/v1/publishing/requests/close", headers: auth, payload });
    assert.equal(again.json().job.id, closed.json().job.id);
    assert.equal(store.tables.publishing_jobs.length, count + 1);
    assert.equal((await app.inject({ method: "GET", url, headers: auth })).json().job.status, "cancelled");
    assert.equal(sent.length, 0);
    assert.equal(store.tables.usage_events.filter(row => row.meter === "publishing").length, 0);
    store.tables.workspace_members[0].role = "viewer";
    assert.equal((await app.inject({ method: "GET", url, headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/v1/publishing/requests/close", headers: auth, payload })).statusCode, 403);
  } finally { await app.close(); }
});

test("package closure wins a create already validating sources without dispatch or usage", async () => {
  const store = baseStore(); enableRetailerPackages(store); const sent: unknown[] = [];
  const app = await buildApp(() => fakeSupabase(store), { renderFetch: successfulRenderAndPreflight([]), publishingFetch: successfulPackager(sent) });
  let release!: () => void, entered!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const sources = await createReadySources(app);
    const payload = { bookId: BOOK, editionId: EDITION, channel: "kdp", ...sources, idempotencyKey: crypto.randomUUID() };
    store.downloadBarrier = async () => { entered(); await gate; };
    const creating = app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth, payload }).then(result => result);
    await arrived;
    const closed = await app.inject({ method: "POST", url: "/v1/publishing/requests/close", headers: auth, payload });
    assert.equal(closed.statusCode, 200, closed.body); assert.equal(closed.json().job.status, "cancelled");
    release();
    const late = await creating; assert.equal(late.statusCode, 409, late.body);
    assert.equal(sent.length, 0); assert.equal(store.tables.usage_events.filter(row => row.meter === "publishing").length, 0);
    assert.equal(store.tables.publishing_jobs.filter(row => row.idempotency_key === payload.idempotencyKey).length, 1);
  } finally { release?.(); await app.close(); }
});

test("package history and replay never renew deleted, foreign, changed or quarantined ZIPs", async () => {
  const cases: [string, (asset: Row, version: Row, descriptor: Row) => void][] = [
    ["deleted", asset => { asset.deleted_at = "2026-10-17T00:00:00Z"; }],
    ["archived", asset => { asset.status = "archived"; }],
    ["foreign workspace", asset => { asset.workspace_id = crypto.randomUUID(); }],
    ["changed path", asset => { asset.storage_path = "another/private/file.zip"; }],
    ["changed checksum", asset => { asset.checksum = "0".repeat(64); }],
    ["changed size", asset => { asset.size_bytes = Number(asset.size_bytes) + 1; }],
    ["wrong type", asset => { asset.type = "manuscript"; }],
    ["wrong MIME", asset => { asset.mime_type = "text/html"; }],
    ["quarantined version", (_asset, version) => { version.scan_status = "infected"; }],
    ["changed version checksum", (_asset, version) => { version.checksum = "0".repeat(64); }],
    ["changed version path", (_asset, version) => { version.storage_path = "another/private/file.zip"; }],
    ["unscanned version", (_asset, version) => { version.scan_status = "pending"; }],
    ["changed version MIME", (_asset, version) => { version.mime_type = "text/html"; }],
    ["changed version size", (_asset, version) => { version.size_bytes = Number(version.size_bytes) + 1; }],
    ["missing asset", asset => { asset.id = crypto.randomUUID(); }],
    ["missing original version", (_asset, version) => { version.version_number = 2; }],
    ["invalid descriptor ID", (_asset, _version, descriptor) => { descriptor.assetId = "invalid"; }],
    ["invalid descriptor hash", (_asset, _version, descriptor) => { descriptor.checksum = "invalid"; }],
    ["wrong descriptor channel", (_asset, _version, descriptor) => { descriptor.filename = "apple-export.zip"; }],
    ["wrong descriptor path", (_asset, _version, descriptor) => { descriptor.storagePath = "another/private/file.zip"; }],
  ];
  for (const [label, mutate] of cases) {
    const store = baseStore(); enableRetailerPackages(store);
    const requests: unknown[] = [];
    const app = await buildApp(() => fakeSupabase(store), { renderFetch: successfulRenderAndPreflight([]), publishingFetch: successfulPackager(requests) });
    try {
      const sources = await createReadySources(app);
      const payload = { bookId: BOOK, editionId: EDITION, channel: "kdp", ...sources, idempotencyKey: crypto.randomUUID() };
      const created = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth, payload });
      assert.equal(created.statusCode, 201, created.body);
      const job = created.json();
      const asset = store.tables.assets.find(value => value.id === job.package.asset.id)!;
      const version = store.tables.asset_versions.find(value => value.asset_id === asset.id)!;
      const descriptor = (store.tables.publishing_jobs.find(value => value.id === job.id)!.response_json as { artifact: Row }).artifact;
      const originalAsset = { ...asset }, originalVersion = { ...version }, originalDescriptor = { ...descriptor };
      mutate(asset, version, descriptor); store.signedPaths = [];
      const history = structuredClone(store.tables.publishing_jobs);
      const usage = structuredClone(store.tables.usage_events);
      for (const request of [
        { method: "GET" as const, url: `/v1/publishing/jobs?bookId=${BOOK}` },
        { method: "GET" as const, url: `/v1/publishing/jobs/${job.id}` },
        { method: "POST" as const, url: "/v1/publishing/jobs", payload },
      ]) {
        const response = await app.inject({ ...request, headers: auth });
        assert.equal(response.statusCode, 200, `${label}: ${response.body}`);
        const result = response.json().jobs?.[0] ?? response.json();
        assert.equal(result.id, job.id); assert.equal(result.status, "succeeded");
        assert.equal(result.package, null, `${label}: unavailable snapshot must have no download link`);
        assert.equal(response.headers["cache-control"], "private, no-store");
      }
      assert.deepEqual(store.signedPaths, [], `${label}: private signing must not run`);
      assert.deepEqual(store.tables.publishing_jobs, history); assert.deepEqual(store.tables.usage_events, usage);
      assert.equal(requests.length, 1, "recovery must not rebuild or charge for the package");
      Object.assign(asset, originalAsset); Object.assign(version, originalVersion); Object.assign(descriptor, originalDescriptor);
      const restored = await app.inject({ method: "GET", url: `/v1/publishing/jobs/${job.id}`, headers: auth });
      assert.equal(restored.statusCode, 200, restored.body);
      assert.equal(restored.json().package.asset.id, asset.id);
    } finally { await app.close(); }
  }
});

test("package history fails closed on availability or signing outages without changing the saved job", async () => {
  for (const unavailable of ["assets", "asset_versions", "signing"]) {
    const store = baseStore(); enableRetailerPackages(store);
    const requests: unknown[] = [];
    const app = await buildApp(() => fakeSupabase(store), { renderFetch: successfulRenderAndPreflight([]), publishingFetch: successfulPackager(requests) });
    try {
      const sources = await createReadySources(app);
      const created = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth,
        payload: { bookId: BOOK, editionId: EDITION, channel: "kdp", ...sources, idempotencyKey: crypto.randomUUID() } });
      assert.equal(created.statusCode, 201, created.body);
      const job = created.json(), history = structuredClone(store.tables.publishing_jobs), usage = structuredClone(store.tables.usage_events);
      store.signedPaths = [];
      if (unavailable === "signing") store.signError = true;
      else store.queryErrors = { [unavailable]: { code: "08006" } };
      for (const url of [`/v1/publishing/jobs?bookId=${BOOK}`, `/v1/publishing/jobs/${job.id}`]) {
        const response = await app.inject({ method: "GET", url, headers: auth });
        assert.equal(response.statusCode, 503, response.body);
        assert.equal(response.headers["cache-control"], "private, no-store");
        assert.equal(response.body.includes("signed:300:"), false);
        assert.equal(response.body.includes("private signing diagnostic"), false);
      }
      if (unavailable !== "signing") assert.deepEqual(store.signedPaths, []);
      assert.deepEqual(store.tables.publishing_jobs, history); assert.deepEqual(store.tables.usage_events, usage);
      assert.equal(requests.length, 1);
    } finally { await app.close(); }
  }
});

test("Google Play ebook preflight and private package remain manual and plan-gated", async () => {
  const store = baseStore();
  const packageRequests: unknown[] = [];
  const app = await buildApp(() => fakeSupabase(store), {
    renderFetch: successfulRenderAndPreflight([], "googleplay"),
    publishingFetch: successfulPackager(packageRequests, "googleplay"),
  });
  const sources = await createReadySources(app, "googleplay");
  const payload = { bookId: BOOK, editionId: EDITION, channel: "googleplay", ...sources,
    idempotencyKey: "google-play-package-0001" };
  const denied = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth, payload });
  assert.equal(denied.statusCode, 422, denied.body);
  assert.equal(packageRequests.length, 0);
  enableRetailerPackages(store);
  const created = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth, payload });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().submissionMode, "manual");
  assert.equal(created.json().channel, "googleplay");
  assert.equal((packageRequests[0] as Row).channel, "googleplay");
  assert.equal(store.tables.usage_events.filter(row => row.meter === "publishing").length, 1);
  await app.close();
});

test("package creation requires a plan channel and fresh matching manuscript fingerprints", async () => {
  const store = baseStore();
  const packageRequests: unknown[] = [];
  const app = await buildApp(() => fakeSupabase(store), {
    renderFetch: successfulRenderAndPreflight([]), publishingFetch: successfulPackager(packageRequests),
  });
  const sources = await createReadySources(app);
  const payload = { bookId: BOOK, editionId: EDITION, channel: "kdp", ...sources, idempotencyKey: "package-request-0002" };
  const blockedPlan = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth, payload });
  assert.equal(blockedPlan.statusCode, 422, blockedPlan.body);
  assert.equal(packageRequests.length, 0);

  enableRetailerPackages(store);
  const version = store.tables.document_versions[0];
  version.content_json = { schemaVersion: "1.0", nodes: [{ id: "p1", type: "paragraph", text: "The manuscript changed." }] };
  const stale = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth, payload: { ...payload, idempotencyKey: "package-request-0003" } });
  assert.equal(stale.statusCode, 422, stale.body);
  assert.match(stale.body, /fresh successful render/u);
  assert.equal(packageRequests.length, 0);
  await app.close();
});

test("package persistence failure removes the uploaded ZIP and records no publishing usage", async () => {
  const store = baseStore();
  enableRetailerPackages(store);
  const app = await buildApp(() => fakeSupabase(store), {
    renderFetch: successfulRenderAndPreflight([]), publishingFetch: successfulPackager([]),
  });
  const sources = await createReadySources(app);
  const objectCount = store.objects.size;
  store.rpcError = { code: "42883" };
  const response = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth, payload: {
    bookId: BOOK, editionId: EDITION, channel: "kdp", ...sources, idempotencyKey: "package-request-0004",
  } });
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(store.objects.size, objectCount);
  assert.equal(store.tables.usage_events.filter((row) => row.meter === "publishing").length, 0);
  assert.equal(store.tables.publishing_jobs.at(-1)?.status, "failed");
  await app.close();
});

test("synchronous ebook rendering retains verified cover policy and rejects unsupported completion versions", async (t) => {
  for (const coverRendererVersion of ["cover-1.4.0", "cover-1.3.0", null]) {
    const store = baseStore();
    store.tables.editions[0].edition_metadata_json = { kind: "ebook", cover: { asset_id: COVER }, metadata_overrides: { title: "" } };
    const app = await buildApp(() => fakeSupabase(store), { renderFetch: successfulRenderer([], coverRendererVersion) });
    t.after(() => app.close());
    const initialObjects = store.objects.size;
    const response = await app.inject({ method: "POST", url: `/v1/editions/${EDITION}/render`, headers: auth,
      payload: { idempotencyKey: crypto.randomUUID() } });
    if (coverRendererVersion === "cover-1.4.0") {
      assert.equal(response.statusCode, 201, response.body);
      const usage = (store.tables.publishing_jobs[0].response_json as Row).usage as Row;
      assert.equal(usage.coverRendererVersion, coverRendererVersion);
      assert.equal(usage.coverMetadataPolicy, "effective-ebook-metadata-v1");
      assert.equal(store.tables.usage_events.length, 1);
    } else {
      assert.equal(response.statusCode, 503, response.body);
      assert.match(response.body, /cover metadata.*render again/iu);
      assert.equal(store.objects.size, initialObjects);
      assert.equal(store.tables.usage_events.length, 0);
      assert.equal(store.tables.publishing_jobs[0].status, "failed");
    }
  }
});

test("saved ebook cover policy blocks package dispatch and private bytes without rewriting history", async (t) => {
  const store = baseStore();
  store.tables.editions[0].edition_metadata_json = { kind: "ebook", cover: { asset_id: COVER }, metadata_overrides: { author: "" } };
  enableRetailerPackages(store);
  const packageRequests: unknown[] = [];
  const app = await buildApp(() => fakeSupabase(store), {
    renderFetch: successfulRenderAndPreflight([], "kdp", "cover-1.4.0"), publishingFetch: successfulPackager(packageRequests),
  });
  t.after(() => app.close());
  const sources = await createReadySources(app);
  const sourceJob = store.tables.publishing_jobs.find(row => row.id === sources.renderJobId)!;
  const sourceResponse = sourceJob.response_json as Row;
  const originalUsage = sourceResponse.usage as Row;
  // A synthetic reviewed receipt isolates package enforcement from completion retention.
  sourceResponse.usage = { ...originalUsage, coverRendererVersion: "cover-1.4.0", coverMetadataPolicy: "effective-ebook-metadata-v1" };
  const good = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth, payload: {
    bookId: BOOK, editionId: EDITION, channel: "kdp", ...sources, idempotencyKey: crypto.randomUUID(),
  } });
  assert.equal(good.statusCode, 201, good.body);
  const packageId = good.json().id;
  const sent = packageRequests[0] as { artifactsBase64: Record<string, string> };
  const coverDescriptor = (sourceResponse.artifacts as Row[]).find(artifact => artifact.role === "rendered_cover")!;
  assert.equal(sent.artifactsBase64["cover.png"], store.objects.get(String(coverDescriptor.storagePath))!.toString("base64"));
  const legacyUsage = { ...originalUsage };
  delete legacyUsage.coverRendererVersion;
  delete legacyUsage.coverMetadataPolicy;
  for (const usage of [legacyUsage, { ...originalUsage, coverRendererVersion: "cover-1.3.0", coverMetadataPolicy: "effective-ebook-metadata-v1" },
    { ...originalUsage, coverRendererVersion: "cover-1.4.0", coverMetadataPolicy: "old-policy" }]) {
    sourceResponse.usage = usage;
    store.downloads = [];
    const history = structuredClone(store.tables.publishing_jobs);
    const objects = [...store.objects].map(([path, value]) => [path, value.toString("base64")]);
    const calls = packageRequests.length;
    const response = await app.inject({ method: "POST", url: "/v1/publishing/jobs", headers: auth, payload: {
      bookId: BOOK, editionId: EDITION, channel: "kdp", ...sources, idempotencyKey: crypto.randomUUID(),
    } });
    assert.equal(response.statusCode, 422, response.body);
    assert.match(response.body, /cover metadata.*render again/iu);
    assert.deepEqual(store.downloads, [], "an unsupported saved cover must fail before any private byte read");
    assert.equal(packageRequests.length, calls);
    assert.deepEqual(store.tables.publishing_jobs, history);
    assert.deepEqual([...store.objects].map(([path, value]) => [path, value.toString("base64")]), objects);
    const historicalPackage = await app.inject({ method: "GET", url: `/v1/publishing/jobs/${packageId}`, headers: auth });
    assert.equal(historicalPackage.statusCode, 200, historicalPackage.body);
    assert.equal(historicalPackage.json().id, packageId, "existing package recovery must remain available");
  }
});
