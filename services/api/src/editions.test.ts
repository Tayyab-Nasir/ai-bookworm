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
interface Store { tables: Record<string, Row[]> }

function fakeSupabase(store: Store) {
  return {
    auth: { getUser: async (token: string) => token === "good"
      ? { data: { user: { id: USER } }, error: null }
      : { data: { user: null }, error: { message: "bad" } } },
    from: (table: string) => {
      const rows = (store.tables[table] ??= []);
      const filters: [string, unknown][] = [];
      let insert: Row | null = null;
      let update: Row | null = null;
      const selected = () => rows.filter((row) => filters.every(([key, value]) => row[key] === value));
      const mutate = () => {
        if (insert) {
          const row = { id: insert.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...insert };
          rows.push(row); insert = null; return [row];
        }
        if (update) {
          const result = selected(); result.forEach((row) => Object.assign(row, update)); update = null; return result;
        }
        return selected();
      };
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "order", "limit", "is", "in"]) builder[method] = () => builder;
      builder.eq = (key: string, value: unknown) => { filters.push([key, value]); return builder; };
      builder.insert = (row: Row) => { insert = row; return builder; };
      builder.update = (row: Row) => { update = row; return builder; };
      builder.single = async () => ({ data: mutate()[0] ?? null, error: null });
      builder.maybeSingle = async () => ({ data: mutate()[0] ?? null, error: null });
      builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: mutate(), error: null });
      return builder;
    },
  } as never;
}

const USER = "c0000000-0000-4000-8000-000000000001";
const WORKSPACE = "c0000000-0000-4000-8000-000000000002";
const BOOK = "c0000000-0000-4000-8000-000000000003";
const COVER = "c0000000-0000-4000-8000-000000000004";
const EDITION = "c0000000-0000-4000-8000-000000000005";
const auth = { authorization: "Bearer good" };

function baseStore(role = "editor"): Store {
  return { tables: {
    books: [{ id: BOOK, workspace_id: WORKSPACE }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, role, status: "active" }],
    assets: [{ id: COVER, workspace_id: WORKSPACE, mime_type: "image/png", checksum: "a".repeat(64), status: "approved", deleted_at: null }],
    editions: [], activity_events: [],
  } };
}

test("editor creates a normalized print edition with a confirmed cover and HTTPS QR", async () => {
  const store = baseStore();
  const app = await buildApp(() => fakeSupabase(store));
  const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/editions`, headers: auth, payload: {
    language: "en",
    config: {
      kind: "print", text_direction: "rtl", trim_size: "6x9", bleed_in: 0.125, bleed_edges: "outer", typography: { body_size_pt: 11, leading: 15, body_font: "BookwormVera", heading_font: "BookwormVera-Bold" },
      cover: { asset_id: COVER, qr_code: { enabled: true, url: "https://author.example/books/river" } },
    },
  } });
  assert.equal(response.statusCode, 201, response.body);
  const edition = response.json();
  assert.equal(edition.type, "print");
  assert.equal(edition.edition_metadata_json.bleed_edges, "outer");
  assert.equal(edition.edition_metadata_json.bleed_in, 0.125);
  assert.equal(edition.edition_metadata_json.margins.inner, 0.75);
  assert.equal(edition.edition_metadata_json.typography.body_font, "BookwormVera");
  assert.equal(edition.edition_metadata_json.typography.heading_font, "BookwormVera-Bold");
    assert.equal(edition.edition_metadata_json.typography.text_align, "justify");
    assert.equal(edition.edition_metadata_json.text_direction, "rtl");
  assert.equal(edition.edition_metadata_json.cover.qr_code.position, "bottom-right");
  assert.equal(store.tables.activity_events.length, 1);
  await app.close();
});

test("edition input rejects unsafe QR destinations and unconfirmed cover assets", async () => {
  const store = baseStore();
  const app = await buildApp(() => fakeSupabase(store));
  const unsafe = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/editions`, headers: auth, payload: {
    config: { kind: "ebook", cover: { qr_code: { enabled: true, url: "http://author.example" } } },
  } });
  assert.equal(unsafe.statusCode, 422);
  store.tables.assets[0].checksum = "pending";
  const pending = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/editions`, headers: auth, payload: {
    config: { kind: "ebook", cover: { asset_id: COVER } },
  } });
  assert.equal(pending.statusCode, 422);
  assert.equal(store.tables.editions.length, 0);
  await app.close();
});

test("viewer cannot create an edition", async () => {
  const store = baseStore("viewer");
  const app = await buildApp(() => fakeSupabase(store));
  const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/editions`, headers: auth, payload: { config: { kind: "ebook" } } });
  assert.equal(response.statusCode, 403);
  assert.equal(store.tables.editions.length, 0);
  await app.close();
});

test("edition updates use optimistic concurrency", async () => {
  const store = baseStore();
  store.tables.editions.push({ id: EDITION, book_id: BOOK, type: "ebook", status: "draft", updated_at: "2026-09-03T00:00:00.000Z", edition_metadata_json: { kind: "ebook" } });
  const app = await buildApp(() => fakeSupabase(store));
  const stale = await app.inject({ method: "PATCH", url: `/v1/editions/${EDITION}`, headers: auth, payload: {
    status: "in_review", expectedUpdatedAt: "2026-09-02T00:00:00.000Z",
  } });
  assert.equal(stale.statusCode, 409);
  assert.equal(store.tables.editions[0].status, "draft");
  const saved = await app.inject({ method: "PATCH", url: `/v1/editions/${EDITION}`, headers: auth, payload: {
    status: "in_review", expectedUpdatedAt: "2026-09-03T00:00:00.000Z",
  } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(store.tables.editions[0].status, "in_review");
  await app.close();
});
