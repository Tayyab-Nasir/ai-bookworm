import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { makeAuthPlugin } from "./plugins/auth.js";
import { storyBlueprintRoutes } from "./routes/story-blueprints.js";

const BOOK = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const BLUEPRINT = "44444444-4444-4444-8444-444444444444";
const PLAN_ITEM = "55555555-5555-4555-8555-555555555555";
const CHAPTER = "66666666-6666-4666-8666-666666666666";

const story = {
  workingTitle: "The Long Way Home",
  premise: "A cartographer follows a vanished road.",
  readerPromise: "A hopeful, adventurous mystery.",
  genre: "Fantasy",
  tone: "Warm and suspenseful",
  pointOfView: "Third person",
  tense: "Past",
  targetWordCount: 90_000,
  synopsis: "Elara's map opens a path through an impossible sea.",
  theme: "Home can be chosen.",
  notes: "Keep the magic grounded in character choices.",
};

const chapterPlan = [{
  id: PLAN_ITEM,
  title: "A Map in the Rain",
  purpose: "Introduce Elara and the map.",
  summary: "Elara finds a road absent from every known chart.",
  targetWords: 2_500,
}];

const blueprintRow = {
  id: BLUEPRINT,
  book_id: BOOK,
  revision: 3,
  details_json: story,
  chapter_plan_json: chapterPlan,
  created_by: "private-creator",
  updated_by: "private-editor",
};

const chapterRow = {
  id: CHAPTER,
  book_id: BOOK,
  order_index: 0,
  title: chapterPlan[0].title,
  status: "draft",
  current_document_version_id: null,
  created_at: "2026-09-19T08:00:00.000Z",
  updated_at: "2026-09-19T08:00:00.000Z",
};

type RpcError = { code: string; details?: string | null };

function fakeSupabase(options: {
  role?: string | null;
  blueprint?: Record<string, unknown> | null;
  materializations?: Record<string, unknown>[];
  rpcError?: RpcError;
} = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const role = options.role === undefined ? "editor" : options.role;
  const blueprint = options.blueprint === undefined ? blueprintRow : options.blueprint;
  const materializations = options.materializations ?? [{
    blueprint_id: BLUEPRINT,
    blueprint_chapter_id: PLAN_ITEM,
    chapter_id: CHAPTER,
    materialized_by: USER,
    request_key: "private-request-key",
  }];

  const client = {
    auth: {
      getUser: async (token: string) => ({ data: { user: token === "good" ? { id: USER } : null }, error: null }),
    },
    from(table: string) {
      const result = () => {
        if (table === "books") return { data: { id: BOOK, workspace_id: WORKSPACE }, error: null };
        if (table === "workspace_members") return { data: role ? { user_id: USER, workspace_id: WORKSPACE, role, status: "active" } : null, error: null };
        if (table === "story_blueprints") return { data: blueprint, error: null };
        if (table === "story_blueprint_materializations") return { data: materializations, error: null };
        return { data: null, error: { message: `unexpected table ${table}` } };
      };
      const query = {
        select() { return query; },
        eq() { return query; },
        order() { return query; },
        async maybeSingle() { return result(); },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name: string, args: unknown) {
      calls.push({ name, args });
      if (options.rpcError) return { data: null, error: options.rpcError };
      return { data: name === "save_story_blueprint" ? blueprintRow : chapterRow, error: null };
    },
  };
  return { client, calls };
}

async function appWith(options?: Parameters<typeof fakeSupabase>[0]) {
  const fake = fakeSupabase(options);
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(makeAuthPlugin(() => fake.client as never));
  await app.register(async (v1) => storyBlueprintRoutes(v1), { prefix: "/v1" });
  return { app, ...fake };
}

const auth = { authorization: "Bearer good" };
const savePayload = { expectedRevision: 0, story, chapterPlan };
const blueprintUrl = `/v1/books/${BOOK}/story-blueprint`;

test("story blueprint GET is member-readable, private/no-store, and omits internal rows", async (t) => {
  const { app } = await appWith({ role: "viewer" });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: blueprintUrl, headers: auth });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.json(), {
    role: "viewer",
    blueprint: {
      revision: 3,
      story,
      chapterPlan,
      materializations: [{ planItemId: PLAN_ITEM, chapterId: CHAPTER }],
    },
  });
  assert.equal(response.body.includes("private-creator"), false);
  assert.equal(response.body.includes("private-request-key"), false);
});

test("story blueprint routes authenticate, validate before RPC, and require editor access for writes", async (t) => {
  const missingAuth = await appWith();
  t.after(() => missingAuth.app.close());
  assert.equal((await missingAuth.app.inject({ method: "GET", url: blueprintUrl })).statusCode, 401);

  const nonMember = await appWith({ role: null });
  t.after(() => nonMember.app.close());
  assert.equal((await nonMember.app.inject({ method: "GET", url: blueprintUrl, headers: auth })).statusCode, 403);

  const invalid = await appWith();
  t.after(() => invalid.app.close());
  const invalidResponse = await invalid.app.inject({ method: "PUT", url: blueprintUrl, headers: auth, payload: { ...savePayload, chapterPlan: [{ ...chapterPlan[0], targetWords: 1 }] } });
  assert.equal(invalidResponse.statusCode, 422, invalidResponse.body);
  assert.equal(invalid.calls.length, 0);

  const viewer = await appWith({ role: "viewer" });
  t.after(() => viewer.app.close());
  const forbidden = await viewer.app.inject({ method: "PUT", url: blueprintUrl, headers: auth, payload: savePayload });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.equal(viewer.calls.length, 0);
});

test("story blueprint writes use the authenticated RPC contracts", async (t) => {
  const { app, calls } = await appWith();
  t.after(() => app.close());

  const saved = await app.inject({ method: "PUT", url: blueprintUrl, headers: auth, payload: savePayload });
  assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(saved.headers["cache-control"], "private, no-store");
  assert.deepEqual(calls[0], {
    name: "save_story_blueprint",
    args: { p_book_id: BOOK, p_expected_revision: 0, p_details: story, p_chapters: chapterPlan },
  });
  assert.equal(saved.json().blueprint.revision, 3);

  const materialized = await app.inject({
    method: "POST",
    url: `${blueprintUrl}/chapters/${PLAN_ITEM}/materialize`,
    headers: auth,
    payload: { expectedRevision: 3, idempotencyKey: "blueprint-chapter-one" },
  });
  assert.equal(materialized.statusCode, 200, materialized.body);
  assert.deepEqual(calls[1], {
    name: "materialize_story_blueprint_chapter",
    args: {
      p_book_id: BOOK,
      p_blueprint_chapter_id: PLAN_ITEM,
      p_expected_revision: 3,
      p_request_key: "blueprint-chapter-one",
    },
  });
  assert.deepEqual(materialized.json(), { chapter: chapterRow });
});

test("story blueprint RPC errors map to stable HTTP outcomes and preserve numeric revisions", async (t) => {
  const cases: { error: RpcError; status: number; currentRevision?: number }[] = [
    { error: { code: "40001", details: "0" }, status: 409, currentRevision: 0 },
    { error: { code: "40001", details: "7" }, status: 409, currentRevision: 7 },
    { error: { code: "40001", details: "not-a-revision" }, status: 409 },
    { error: { code: "42501" }, status: 403 },
    { error: { code: "P0002" }, status: 404 },
    { error: { code: "22023" }, status: 422 },
    { error: { code: "23514" }, status: 422 },
    { error: { code: "PGRST202" }, status: 503 },
  ];
  for (const entry of cases) {
    const { app } = await appWith({ rpcError: entry.error });
    t.after(() => app.close());
    const response = await app.inject({ method: "PUT", url: blueprintUrl, headers: auth, payload: savePayload });
    assert.equal(response.statusCode, entry.status, `${entry.error.code}: ${response.body}`);
    assert.equal(response.json().error.details?.currentRevision, entry.currentRevision);
  }
});
