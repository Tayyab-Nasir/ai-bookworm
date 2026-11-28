import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { chapterRoutes } from "./routes/chapters.js";
import { AppError } from "./errors.js";

const chapterId = "11111111-1111-4111-8111-111111111111", versionId = "22222222-2222-4222-8222-222222222222";
const nodes = [{ id: "image", type: "image", assetId: "33333333-3333-4333-8333-333333333333", assetVersionNumber: 2, altText: "Saved illustration" }];
const saved = { id: versionId, chapter_id: chapterId, version_number: 3, plain_text: "", word_count: 0,
  created_by: "original-author", created_at: "2026-10-23T10:00:00Z", change_summary: "Illustration", content_json: { nodes } };
async function fixture({ role = "viewer", row = saved, databaseError = false, chapterExists = true } = {}) {
  const queries: { table: string; filters: Record<string, unknown> }[] = [];
  const app = Fastify();
  app.decorate("supabaseFactory", ((token: string) => {
    assert.equal(token, "scoped-fixture");
    return { from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = { select: () => query, eq: (key: string, value: unknown) => { filters[key] = value; return query; },
        maybeSingle: async () => {
          queries.push({ table, filters });
          if (table === "chapters") return { data: chapterExists ? { id: chapterId, book_id: "book" } : null, error: null };
          if (table === "books") return { data: { id: "book", workspace_id: "workspace" }, error: null };
          if (table === "workspace_members") return { data: role ? { role } : null, error: null };
          assert.equal(table, "document_versions");
          return { data: Object.entries(filters).every(([key, value]) => row[key as keyof typeof saved] === value) ? row : null,
            error: databaseError ? { message: "private database diagnostics" } : null };
        } };
      return query;
    }, rpc: () => { throw new Error("Historical revision reads must not mutate"); } };
  }) as never);
  app.addHook("preHandler", async req => { req.userId = "current-reader"; req.userToken = "scoped-fixture"; });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.status : 500).send({ error: error instanceof Error ? error.message : "Unknown error" }));
  chapterRoutes(app);
  return { app, queries };
}
const url = `/chapters/${chapterId}/versions/${versionId}`;
test("viewer reads exact immutable canonical revision with no writes or asset fetches", async () => {
  const { app, queries } = await fixture();
  try {
    const response = await app.inject({ url });
    assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "private, no-store");
    const { content_json: _content, ...version } = saved;
    assert.deepEqual(response.json(), { version, document: { chapterId, version: 3, nodes } });
    assert.deepEqual(queries.map(query => query.table), ["chapters", "books", "workspace_members", "document_versions"]);
    assert.deepEqual(queries.at(-1)?.filters, { chapter_id: chapterId, id: versionId });
  } finally { await app.close(); }
});
test("foreign version cannot be read through an authorized chapter", async () => {
  const { app } = await fixture({ row: { ...saved, chapter_id: "another-chapter" } });
  try { assert.equal((await app.inject({ url })).statusCode, 404); } finally { await app.close(); }
});
test("membership is checked before reading history and UUIDs fail before database access", async () => {
  for (const [options, path, status] of [[{ role: "" }, url, 403], [{ chapterExists: false }, url, 404], [{}, url.replace(versionId, "bad"), 422]] as const) {
    const { app, queries } = await fixture(options);
    try {
      assert.equal((await app.inject({ url: path })).statusCode, status);
      assert(!queries.some(query => query.table === "document_versions"));
    } finally { await app.close(); }
  }
});
test("outage and unsupported legacy content fail closed without echoing diagnostics", async () => {
  for (const [options, status] of [[{ databaseError: true }, 503], [{ row: { ...saved, content_json: { nodes: [{ id: "unknown", type: "legacy" }] } } }, 422]] as const) {
    const { app } = await fixture(options as Parameters<typeof fixture>[0]);
    try {
      const response = await app.inject({ url });
      assert.equal(response.statusCode, status); assert(!response.body.includes("private database diagnostics"));
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert(!response.json().document);
    } finally { await app.close(); }
  }
});
