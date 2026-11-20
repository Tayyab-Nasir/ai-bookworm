import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { AppError } from "./errors.js";
import { makeAuthPlugin } from "./plugins/auth.js";
import { communityRoutes } from "./routes/community.js";
import type { SupabaseFactory } from "./lib/supabase.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
type Row = { community_id: string; user_id: string; status: string };

async function fixture(rows: Row[], options: { pageCap?: number; error?: boolean; throwRead?: boolean; noCount?: boolean; countOverride?: number } = {}) {
  const reads: { token: string | undefined; actor: unknown; from: number; to: number }[] = [];
  const factory = ((token?: string) => ({
    auth: { getUser: async () => ({ data: { user: { id: token === "a" ? A : B } }, error: null }) },
    from: (table: string) => {
      assert.equal(table, "community_members");
      let actor: unknown;
      const query = {
        select: (columns: string, config: { count: string }) => { assert.equal(columns, "community_id,status"); assert.equal(config.count, "exact"); return query; },
        eq: (field: string, value: unknown) => { assert.equal(field, "user_id"); actor = value; return query; },
        order: (field: string) => { assert.equal(field, "community_id"); return query; },
        range: async (from: number, to: number) => {
          reads.push({ token, actor, from, to });
          if (options.throwRead) throw new Error("private upstream detail");
          const filtered = rows.filter(row => row.user_id === actor).sort((a, b) => a.community_id.localeCompare(b.community_id));
          return { data: filtered.slice(from, Math.min(to + 1, from + (options.pageCap ?? 500))).map(({ community_id, status }) => ({ community_id, status })),
            error: options.error ? { message: "private upstream detail" } : null,
            count: options.noCount ? null : options.countOverride ?? filtered.length };
        },
      };
      return query;
    },
  })) as unknown as SupabaseFactory;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.status : 500).send({ error: error instanceof Error ? error.message : "Unexpected error" }));
  await app.register(makeAuthPlugin(factory));
  await app.register(communityRoutes);
  return { app, reads };
}

test("membership snapshot uses one complete caller-scoped read for each actor", async () => {
  const rows: Row[] = Array.from({ length: 207 }, (_, n) => ({ community_id: id(n + 1), user_id: A, status: n === 5 ? "inactive" : "active" }));
  rows.push({ community_id: id(500), user_id: B, status: "active" });
  const { app, reads } = await fixture(rows);
  try {
    const a = await app.inject({ method: "GET", url: "/communities/memberships", headers: { authorization: "Bearer a", "x-bookworm-actor": A } });
    assert.equal(a.statusCode, 200); assert.equal(a.headers["cache-control"], "private, no-store");
    assert.equal(a.json().memberships.length, 207);
    assert.deepEqual(a.json().memberships[5], { communityId: id(6), active: false });
    assert.deepEqual(reads.map(read => [read.token, read.actor, read.from, read.to]), [["a", A, 0, 9999]]);
    const b = await app.inject({ method: "GET", url: "/communities/memberships", headers: { authorization: "Bearer b", "x-bookworm-actor": B } });
    assert.deepEqual(b.json(), { memberships: [{ communityId: id(500), active: true }] });
    const before = reads.length;
    const crossed = await app.inject({ method: "GET", url: "/communities/memberships", headers: { authorization: "Bearer b", "x-bookworm-actor": A } });
    assert.equal(crossed.statusCode, 409); assert.equal(reads.length, before);
  } finally { await app.close(); }
});

for (const [name, options] of [["database error", { error: true }], ["transport error", { throwRead: true }], ["missing count", { noCount: true }], ["oversized result", { countOverride: 10001 }], ["empty page", { pageCap: 0 }], ["truncated response", { pageCap: 1 }]] as const) {
  test(`membership snapshot fails closed for ${name}`, async () => {
    const { app } = await fixture([{ community_id: id(1), user_id: A, status: "active" }, { community_id: id(2), user_id: A, status: "active" }], options);
    try {
      const res = await app.inject({ method: "GET", url: "/communities/memberships", headers: { authorization: "Bearer a" } });
      assert.equal(res.statusCode, 503); assert.doesNotMatch(res.body, /private upstream detail/);
    } finally { await app.close(); }
  });
}

test("membership snapshot rejects malformed or duplicate rows instead of guessing", async () => {
  for (const rows of [
    [{ community_id: "invalid", user_id: A, status: "active" }],
    [{ community_id: id(1), user_id: A, status: "active" }, { community_id: id(1), user_id: A, status: "inactive" }],
  ]) {
    const { app } = await fixture(rows);
    try {
      const res = await app.inject({ method: "GET", url: "/communities/memberships", headers: { authorization: "Bearer a" } });
      assert.equal(res.statusCode, 503);
    } finally { await app.close(); }
  }
});
