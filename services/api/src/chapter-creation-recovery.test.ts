import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { bookRoutes } from "./routes/books.js";
import { AppError } from "./errors.js";

const actor = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const bookId = "33333333-3333-4333-8333-333333333333";
const requestKey = "44444444-4444-4444-8444-444444444444";

async function fixture(role = "editor", invalid = false) {
  const calls: { name: string; args: unknown }[] = [];
  const app = Fastify();
  app.decorate("supabaseFactory", (() => ({
    from(table: string) {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({
        data: table === "books" ? { id: bookId, workspace_id: "workspace" } : { role }, error: null,
      }) };
      return query;
    },
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return { data: { bookId, requestKey, status: invalid ? "created" : "not_found", chapterId: null }, error: null };
    },
  })) as never);
  app.addHook("preHandler", async req => { req.userToken = "user-token"; req.userId = actor; });
  app.setErrorHandler((error, _req, reply) => reply.status(error instanceof AppError ? error.status : 500).send({ error: error instanceof Error ? error.message : "Unknown error" }));
  bookRoutes(app);
  return { app, calls };
}

test("chapter request recovery binds the actor and uses read or close intentionally", async () => {
  const { app, calls } = await fixture();
  try {
    const base = `/books/${bookId}/chapter-creation/${requestKey}`;
    for (const [header, status] of [[undefined, 422], [other, 409], [actor, 200]] as const) {
      const response = await app.inject({ method: "GET", url: base, headers: header ? { "x-bookworm-actor": header } : {} });
      assert.equal(response.statusCode, status);
      if (status === 200) assert.equal(response.headers["cache-control"], "private, no-store");
    }
    assert.deepEqual(calls[0], { name: "chapter_creation_status", args: { p_book_id: bookId, p_request_key: requestKey, p_close: false } });
    const response = await app.inject({ method: "POST", url: `${base}/close`, headers: { "x-bookworm-actor": actor } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls[1], { name: "chapter_creation_status", args: { p_book_id: bookId, p_request_key: requestKey, p_close: true } });
  } finally { await app.close(); }
});

test("chapter recovery denies viewers and inconsistent receipts", async () => {
  for (const [role, invalid, status] of [["viewer", false, 403], ["editor", true, 503]] as const) {
    const { app, calls } = await fixture(role, invalid);
    try {
      const response = await app.inject({ method: "GET", url: `/books/${bookId}/chapter-creation/${requestKey}`, headers: { "x-bookworm-actor": actor } });
      assert.equal(response.statusCode, status);
      assert.equal(calls.length, role === "viewer" ? 0 : 1);
    } finally { await app.close(); }
  }
});
