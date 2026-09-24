import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { bookRoutes } from "./routes/books.js";
import { AppError } from "./errors.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const userId = "11111111-1111-4111-8111-111111111111";
const details = { workspaceId, requestId, title: "Harbor", authorName: "Author", language: "en", genre: "Mystery" };

function fixture() {
  const records = new Map<string, Record<string, unknown>>();
  let actor = userId;
  let role = "editor";
  let inserts = 0;
  const app = Fastify();
  app.decorate("supabaseFactory", ((token?: string) => {
    assert.equal(token, "user-token");
    return {
      from(table: string) {
        if (table === "workspace_members") {
          const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { role }, error: null }) };
          return query;
        }
        assert.equal(table, "books");
        const where: Record<string, string> = {};
        const query = {
          select: () => query,
          eq: (key: string, value: string) => { where[key] = value; return query; },
          maybeSingle: async () => {
            const record = records.get(where.id);
            return { data: record?.workspace_id === where.workspace_id ? record : null, error: null };
          },
          insert: (row: Record<string, unknown>) => ({ select: () => ({ single: async () => {
            inserts++;
            const id = typeof row.id === "string" ? row.id : randomUUID();
            if (records.has(id)) return { data: null, error: { code: "23505", message: "duplicate key" } };
            const record = { ...row, id };
            records.set(id, record);
            return { data: record, error: null };
          } }) }),
        };
        return query;
      },
    };
  }) as never);
  app.addHook("preHandler", async (req) => { req.userToken = "user-token"; req.userId = actor; });
  app.setErrorHandler((error, _req, reply) => {
    reply.status(error instanceof AppError ? error.status : 500).send({ error: error instanceof Error ? error.message : "Unknown error" });
  });
  bookRoutes(app);
  return { app, records, get inserts() { return inserts; }, setActor: (value: string) => { actor = value; }, setRole: (value: string) => { role = value; } };
}

test("book create retries return the same record without a second book", async () => {
  const f = fixture();
  try {
    const first = await f.app.inject({ method: "POST", url: "/books", payload: details });
    const retry = await f.app.inject({ method: "POST", url: "/books", payload: details });
    assert.equal(first.statusCode, 201);
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(retry.json(), first.json());
    assert.equal(first.json().id, requestId);
    assert.equal(f.records.size, 1);
    assert.equal(f.inserts, 2);
  } finally { await f.app.close(); }
});

test("a reused book request cannot silently change details or cross actors", async () => {
  const f = fixture();
  try {
    assert.equal((await f.app.inject({ method: "POST", url: "/books", payload: details })).statusCode, 201);
    const changed = await f.app.inject({ method: "POST", url: "/books", payload: { ...details, title: "Other" } });
    assert.equal(changed.statusCode, 409);
    f.setActor("44444444-4444-4444-8444-444444444444");
    const otherActor = await f.app.inject({ method: "POST", url: "/books", payload: details });
    assert.equal(otherActor.statusCode, 409);
    f.setRole("viewer");
    assert.equal((await f.app.inject({ method: "POST", url: "/books", payload: details })).statusCode, 403);
    assert.equal(f.records.size, 1);
  } finally { await f.app.close(); }
});

test("invalid retry ID is rejected and legacy create remains possible", async () => {
  const f = fixture();
  try {
    assert.equal((await f.app.inject({ method: "POST", url: "/books", payload: { ...details, requestId: "bad" } })).statusCode, 422);
    const legacy = { ...details, requestId: undefined };
    assert.equal((await f.app.inject({ method: "POST", url: "/books", payload: legacy })).statusCode, 201);
    assert.equal((await f.app.inject({ method: "POST", url: "/books", payload: legacy })).statusCode, 201);
    assert.equal(f.records.size, 2);
  } finally { await f.app.close(); }
});
