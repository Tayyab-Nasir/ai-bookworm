import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { chapterRoutes } from "./routes/chapters.js";
import { AppError } from "./errors.js";

const nodes = [{ id: "n1", type: "paragraph", text: "Saved original" }];
const row = { id: "version-one", chapter_id: "chapter", operation_id: "mobile-original", created_by: "author", version_number: 2, content_json: { nodes } };

async function fixture({ role = "writer", rows = [row], databaseError = false, chapterExists = true } = {}) {
  const filters: Record<string, unknown>[] = [];
  const app = Fastify();
  app.decorate("supabaseFactory", ((token: string) => {
    assert.equal(token, "scoped-token");
    return { from(table: string) {
      const predicates: Record<string, unknown> = {};
      const query = { select: () => query, eq: (key: string, value: unknown) => { predicates[key] = value; return query; },
        maybeSingle: async () => {
          if (table === "chapters") return { data: chapterExists ? { id: "chapter", book_id: "book" } : null, error: null };
          if (table === "books") return { data: { id: "book", workspace_id: "workspace" }, error: null };
          if (table === "workspace_members") return { data: role ? { role } : null, error: null };
          assert.equal(table, "document_versions"); filters.push(predicates);
          return { data: rows.find(candidate => Object.entries(predicates).every(([key, value]) => candidate[key as keyof typeof row] === value)) ?? null,
            error: databaseError ? { code: "unavailable" } : null };
        } };
      return query;
    }, rpc: () => { throw new Error("A save lookup must not mutate or replay a write"); } };
  }) as never);
  app.addHook("preHandler", async req => { req.userId = "author"; req.userToken = "scoped-token"; });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.status : 500).send({ error: error instanceof Error ? error.message : "Unknown error" }));
  chapterRoutes(app);
  return { app, filters };
}

test("original author can recover immutable save after later chapter versions, without a write", async () => {
  const { app, filters } = await fixture({ rows: [{ ...row, id: "later", operation_id: "someone-else", version_number: 8 }, row] });
  try {
    const result = await app.inject({ url: "/chapters/chapter/saves?operationId=mobile-original" });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["cache-control"], "private, no-store");
    assert.deepEqual(result.json(), { status: "saved", operationId: "mobile-original", versionId: "version-one", document: { chapterId: "chapter", version: 2, nodes } });
    assert.deepEqual(filters, [{ chapter_id: "chapter", operation_id: "mobile-original", created_by: "author" }]);
  } finally { await app.close(); }
});

test("recovery never leaks another author's or chapter's receipt", async () => {
  for (const override of [{ created_by: "another-author" }, { chapter_id: "another-chapter" }, { operation_id: "different-save" }]) {
    const { app } = await fixture({ rows: [{ ...row, ...override }] });
    try {
      const result = await app.inject({ url: "/chapters/chapter/saves?operationId=mobile-original" });
      assert.equal(result.statusCode, 200); assert.deepEqual(result.json(), { status: "not_found", operationId: "mobile-original" });
    } finally { await app.close(); }
  }
});

test("membership, missing chapter, malformed identity and lookup outage fail closed", async () => {
  for (const [options, operation, status] of [
    [{ role: "" }, "mobile-original", 403], [{ chapterExists: false }, "mobile-original", 404],
    [{ databaseError: true }, "mobile-original", 503], [{}, "x".repeat(201), 422],
  ] as const) {
    const { app } = await fixture(options);
    try { assert.equal((await app.inject({ url: `/chapters/chapter/saves?operationId=${operation}` })).statusCode, status); }
    finally { await app.close(); }
  }
});

test("an original author with current read-only membership can inspect but not resubmit", async () => {
  const { app } = await fixture({ role: "viewer" });
  try {
    assert.equal((await app.inject({ url: "/chapters/chapter/saves?operationId=mobile-original" })).statusCode, 200);
    assert.equal((await app.inject({ method: "PUT", url: "/chapters/chapter/document", payload: { expectedVersion: 1, nodes, operationId: "mobile-original" } })).statusCode, 403);
  } finally { await app.close(); }
});

test("recovery accepts the full save operation ID length and encoded query characters", async () => {
  const operationId = "a/?&=#".repeat(33) + "ab";
  assert.equal(operationId.length, 200);
  const { app } = await fixture({ rows: [{ ...row, operation_id: operationId }] });
  try {
    const result = await app.inject({ url: `/chapters/chapter/saves?${new URLSearchParams({ operationId })}` });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().operationId, operationId);
    assert.equal(result.json().status, "saved");
  } finally { await app.close(); }
});
