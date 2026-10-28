import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { bookRoutes } from "./routes/books.js";
import { AppError } from "./errors.js";

const actor = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
async function fixture(role = "editor", code?: string) {
  const calls: { name: string; args: unknown }[] = [];
  const app = Fastify();
  app.decorate("supabaseFactory", ((token: string) => {
    assert.equal(token, "user-token");
    return {
      from(table: string) {
        const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: table === "books" ? { id: "book", workspace_id: "workspace" } : { role }, error: null }) };
        return query;
      },
      rpc: async (name: string, args: unknown) => {
        calls.push({ name, args });
        return { data: code ? null : [{ id: "chapter" }], error: code ? { code } : null };
      },
    };
  }) as never);
  app.addHook("preHandler", async (req) => { req.userToken = "user-token"; req.userId = actor; });
  app.setErrorHandler((error, _req, reply) => {
    reply.status(error instanceof AppError ? error.status : 500).send({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  });
  bookRoutes(app);
  return { app, calls };
}

test("chapter create forwards stable request data to the authenticated atomic RPC", async () => {
  const { app, calls } = await fixture();
  try {
    for (let i=0;i<2;i++) {
      const result = await app.inject({ method: "POST", url: "/books/book/chapters", payload: { title: " First ", idempotencyKey: "request-one" } });
      assert.equal(result.statusCode, 201);
      assert.equal(result.json().chapter.id, "chapter");
    }
    assert.deepEqual(calls[0], { name: "create_book_chapter_once", args: { p_book_id: "book", p_title: "First", p_nodes: null, p_request_key: "request-one" } });
    assert.deepEqual(calls[1], calls[0]);
  } finally { await app.close(); }
});

test("chapter create and reorder validate a supplied original actor but retain direct API compatibility", async () => {
  const { app, calls } = await fixture();
  try {
    for (const [method, url, payload] of [
      ["POST", "/books/book/chapters", { title: "First", idempotencyKey: "request-one" }],
      ["PUT", "/books/book/chapters/order", { orderedIds: [], expectedIds: [] }],
    ] as const) {
      for (const [header, status] of [[undefined, method === "POST" ? 201 : 200], ["invalid", 422], [other, 409], [actor, method === "POST" ? 201 : 200]] as const) {
        const before = calls.length;
        const response = await app.inject({ method, url, payload, headers: header ? { "x-bookworm-actor": header } : {} });
        assert.equal(response.statusCode, status);
        assert.equal(calls.length, before + (status < 300 ? 1 : 0));
      }
    }
  } finally { await app.close(); }
});

test("chapter create rejects invalid keys and viewers before persistence", async () => {
  for (const [role, payload, status] of [
    ["editor", { title: "First", idempotencyKey: "bad" }, 422],
    ["viewer", { title: "First", idempotencyKey: "request-one" }, 403],
  ] as const) {
    const { app, calls } = await fixture(role);
    try {
      const result = await app.inject({ method: "POST", url: "/books/book/chapters", payload });
      assert.equal(result.statusCode, status); assert.equal(calls.length, 0);
    } finally { await app.close(); }
  }
});

test("chapter key conflicts return 409 and legacy creation stays supported", async () => {
  for (const code of ["40001", undefined]) {
    const { app, calls } = await fixture("editor", code);
    try {
      const result = await app.inject({ method: "POST", url: "/books/book/chapters", payload: { title: "First", ...(code ? { idempotencyKey: "request-one" } : {}) } });
      assert.equal(result.statusCode, code ? 409 : 201);
      assert.equal(calls[0].name, code ? "create_book_chapter_once" : "create_book_chapters");
    } finally { await app.close(); }
  }
});
