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
  rpcError?: { code: string };
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
        const bytes = store.objects.get(path);
        return bytes
          ? { data: new Blob([new Uint8Array(bytes)]), error: null }
          : { data: null, error: { message: "missing" } };
      },
      createSignedUrl: async (path: string, seconds: number) => ({ data: { signedUrl: `signed:${seconds}:${path}` }, error: null }),
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
      const result = () => { const data = mutate(); return { data, error: insertError }; };
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
        store.tables.asset_versions.push({ asset_id: artifact.assetId, version_number: 1, storage_path: artifact.storagePath, checksum: artifact.checksum });
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
        { asset_id: COVER, version_number: 1, storage_path: coverPath, checksum: sha(cover), scan_status: "clean" },
        { asset_id: ILLUSTRATION, version_number: 1, storage_path: illustrationPath, checksum: sha(illustration), scan_status: "clean" },
      ], asset_links: [], usage_events: [], activity_events: [],
    },
  };
}

function successfulRenderer(requests: unknown[]) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const artifact = Buffer.from("PK\u0003\u0004deterministic-epub");
    const cover = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]);
    return new Response(JSON.stringify({
      format: "epub", artifactBase64: artifact.toString("base64"), sha256: sha(artifact), rendererVersion: "epub-test",
      coverArtifactBase64: cover.toString("base64"), coverSha256: sha(cover), coverRendererVersion: "cover-test",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function enableRetailerPackages(store: Store) {
  const planId = "d0000000-0000-4000-8000-000000000009";
  store.tables.subscriptions.push({ id: crypto.randomUUID(), organization_id: ORG, plan_id: planId, status: "active", created_at: "2026-09-04T00:00:00Z", current_period_end: null });
  store.tables.plans.push({ id: planId, name: "team", entitlements_json: { publishing_channels: ["export", "kdp", "apple_books", "barnes_noble", "lulu"] } });
}

function successfulRenderAndPreflight(requests: unknown[]) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    if (String(input).endsWith("/preflight")) {
      return new Response(JSON.stringify({
        ruleVersion: "core-test+kdp-test", channel: "kdp", errors: 0, warnings: 1, findings: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return successfulRenderer([])(input, init);
  };
}

function successfulPackager(requests: unknown[]) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const packageBytes = Buffer.from("PK\u0003\u0004deterministic-channel-package");
    return new Response(JSON.stringify({
      channel: "kdp", ruleVersion: "core-test+kdp-test", errors: 0,
      packages: [{ path: "kdp-export.zip", sha256: sha(packageBytes), dataBase64: packageBytes.toString("base64") }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function createReadySources(app: Awaited<ReturnType<typeof buildApp>>) {
  const render = await app.inject({ method: "POST", url: `/v1/editions/${EDITION}/render`, headers: auth, payload: { idempotencyKey: crypto.randomUUID() } });
  assert.equal(render.statusCode, 201, render.body);
  const preflight = await app.inject({ method: "POST", url: "/v1/publishing/validate", headers: auth, payload: {
    bookId: BOOK, editionId: EDITION, channel: "kdp", idempotencyKey: crypto.randomUUID(),
  } });
  assert.equal(preflight.statusCode, 201, preflight.body);
  return { renderJobId: render.json().jobId as string, preflightJobId: preflight.json().jobId as string };
}

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
