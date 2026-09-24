import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { assetRoutes } from "./routes/assets.js";
import { AppError } from "./errors.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const userId = "11111111-1111-4111-8111-111111111111";
const body = { workspaceId, requestId, filename: "manuscript.txt", mimeType: "text/plain", sizeBytes: 120, type: "manuscript" };

function fixture() {
  const tables: Record<string, Record<string, unknown>[]> = { assets: [], asset_versions: [], activity_events: [] };
  let actor = userId;
  let role = "editor";
  let failVersionOnce = false;
  let signs = 0;
  const app = Fastify();
  app.decorate("supabaseFactory", ((token?: string) => {
    assert.equal(token, "user-token");
    return {
      storage: { from: () => ({ createSignedUploadUrl: async (path: string) => ({ data: { signedUrl: `signed:${++signs}:${path}` }, error: null }) }) },
      from(table: string) {
        const rows = table === "workspace_members" ? [{ role, workspace_id: workspaceId, user_id: actor, status: "active" }] : (tables[table] ??= []);
        const filters: [string, unknown][] = [];
        let insertion: Record<string, unknown> | null = null;
        let deletion = false;
        let descending = false;
        let limit: number | undefined;
        const query = {
          select: () => query,
          eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
          order: (_key: string, options: { ascending?: boolean }) => { descending = options.ascending === false; return query; },
          limit: (value: number) => { limit = value; return query; },
          insert: (row: Record<string, unknown>) => { insertion = row; return query; },
          delete: () => { deletion = true; return query; },
          single: async () => execute(true),
          maybeSingle: async () => execute(true),
          then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(execute(false)).then(resolve, reject),
        };
        function execute(single: boolean) {
          if (insertion) {
            const row = insertion;
            insertion = null;
            if (table === "asset_versions" && failVersionOnce) {
              failVersionOnce = false;
              return { data: null, error: { code: "08006", message: "temporary version outage" } };
            }
            if (rows.some((existing) => table === "assets" ? existing.id === row.id
              : table === "asset_versions" && existing.asset_id === row.asset_id && existing.version_number === row.version_number)) {
              return { data: null, error: { code: "23505", message: "duplicate key" } };
            }
            rows.push(row);
            return { data: single ? row : [row], error: null };
          }
          const selected = rows.filter((row) => filters.every(([key, value]) => row[key] === value));
          if (deletion) { selected.forEach((row) => rows.splice(rows.indexOf(row), 1)); return { data: null, error: null }; }
          if (descending) selected.reverse();
          const result = limit === undefined ? selected : selected.slice(0, limit);
          return { data: single ? result[0] ?? null : result, error: null };
        }
        return query;
      },
    };
  }) as never);
  app.addHook("preHandler", async (req) => { req.userToken = "user-token"; req.userId = actor; });
  app.setErrorHandler((error, _req, reply) => {
    reply.status(error instanceof AppError ? error.status : 500).send({ error: error instanceof Error ? error.message : "Unknown error" });
  });
  assetRoutes(app);
  return { app, tables, get signs() { return signs; }, setActor: (value: string) => { actor = value; },
    setRole: (value: string) => { role = value; }, failNextVersion: () => { failVersionOnce = true; } };
}

test("upload allocation reissues a URL for one exact pending asset and version", async () => {
  const f = fixture();
  try {
    const first = await f.app.inject({ method: "POST", url: "/assets/upload-url", payload: body });
    const replay = await f.app.inject({ method: "POST", url: "/assets/upload-url", payload: body });
    assert.equal(first.statusCode, 200);
    assert.equal(replay.statusCode, 200);
    assert.equal(first.json().assetId, requestId);
    assert.equal(replay.json().assetId, requestId);
    assert.notEqual(first.json().uploadUrl, replay.json().uploadUrl);
    assert.equal(f.tables.assets.length, 1);
    assert.equal(f.tables.asset_versions.length, 1);
    assert.equal(f.tables.activity_events.length, 1);
    assert.equal(f.signs, 2);
  } finally { await f.app.close(); }
});

test("a partial asset allocation repairs version one without a second asset", async () => {
  const f = fixture(); f.failNextVersion();
  try {
    assert.equal((await f.app.inject({ method: "POST", url: "/assets/upload-url", payload: body })).statusCode, 503);
    assert.equal(f.tables.assets.length, 1);
    assert.equal(f.tables.asset_versions.length, 0);
    const recovered = await f.app.inject({ method: "POST", url: "/assets/upload-url", payload: body });
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().assetId, requestId);
    assert.equal(f.tables.assets.length, 1);
    assert.equal(f.tables.asset_versions.length, 1);
  } finally { await f.app.close(); }
});

test("upload replay rejects changed metadata, other actors and viewers", async () => {
  const f = fixture();
  try {
    assert.equal((await f.app.inject({ method: "POST", url: "/assets/upload-url", payload: body })).statusCode, 200);
    assert.equal((await f.app.inject({ method: "POST", url: "/assets/upload-url", payload: { ...body, filename: "changed.txt" } })).statusCode, 409);
    f.setActor("44444444-4444-4444-8444-444444444444");
    assert.equal((await f.app.inject({ method: "POST", url: "/assets/upload-url", payload: body })).statusCode, 409);
    f.setRole("viewer");
    assert.equal((await f.app.inject({ method: "POST", url: "/assets/upload-url", payload: body })).statusCode, 403);
    assert.equal(f.tables.assets.length, 1);
  } finally { await f.app.close(); }
});

test("upload replay never reopens a finalized or replaced source", async () => {
  const f = fixture();
  try {
    assert.equal((await f.app.inject({ method: "POST", url: "/assets/upload-url", payload: body })).statusCode, 200);
    f.tables.asset_versions[0].scan_status = "clean";
    assert.equal((await f.app.inject({ method: "POST", url: "/assets/upload-url", payload: body })).statusCode, 409);
    f.tables.asset_versions[0].scan_status = "pending";
    f.tables.asset_versions.push({ asset_id: requestId, version_number: 2, storage_path: "replaced" });
    assert.equal((await f.app.inject({ method: "POST", url: "/assets/upload-url", payload: body })).statusCode, 409);
    assert.equal(f.signs, 1);
  } finally { await f.app.close(); }
});
