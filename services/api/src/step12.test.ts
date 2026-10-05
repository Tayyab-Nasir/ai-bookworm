import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.SERVICE_AUTH_TOKEN = "svc-secret";
process.env.ADMIN_USER_IDS = "admin-1";

const { buildApp } = await import("./app.js");

// ---- stateful fake supabase --------------------------------------------------
// Same pattern as step11.test.ts, extended with gte/update/delete and the
// communities.slug unique constraint. created_at is an ISO string we control.
type Row = Record<string, unknown>;
interface Store {
  tables: Record<string, Row[]>;
  commentInsertError?: { code: string; message: string };
  reportInsertError?: { code: string; message: string };
  reportReceipt?: Row;
  rpc?: (name: string, params: Row) => { data: unknown; error: { code: string; message: string } | null };
}

const TOKENS: Record<string, string> = { good: "user-1", other: "user-2", admin: "admin-1" };

function fakeSupabase(store: Store, token?: string) {
  const client = {
    rpc: async (name: string, params: Row) => {
      if (name === "community_moderation_queue" && !store.rpc) {
        const communityIds = store.tables.community_members?.filter(row => row.user_id === TOKENS[token ?? ""]
          && row.status === "active" && ["owner","moderator"].includes(String(row.role))).map(row => row.community_id) ?? [];
        const reports = (store.tables.reports ?? []).filter(row => {
          const comment = row.entity_type === "comment" ? store.tables.community_comments?.find(c => c.id === row.entity_id) : undefined;
          const post = store.tables.community_posts?.find(p => p.id === (comment?.post_id ?? row.entity_id));
          return row.status === "open" && communityIds.includes(post?.community_id);
        }).slice(Number(params.p_offset), Number(params.p_offset) + Number(params.p_limit));
        return { data: reports.map(row => ({ ...row, target: null })), error: null };
      }
      if (name === "moderate_community_report" && !store.rpc) {
        const report = store.tables.reports?.find(row => row.id === params.p_report_id);
        if (!report) return { data: null, error: { code: "P0002" } };
        const comment = report.entity_type === "comment" ? store.tables.community_comments?.find(row => row.id === report.entity_id) : undefined;
        const post = store.tables.community_posts?.find(row => row.id === (comment?.post_id ?? report.entity_id));
        const member = store.tables.community_members?.find(row => row.community_id === post?.community_id && row.user_id === TOKENS[token ?? ""] && row.status === "active");
        if (!member || !["owner", "moderator"].includes(String(member.role))) return { data: null, error: { code: "42501" } };
        const replay = report.status !== "open";
        if (!replay) {
          report.status = params.p_action === "remove" ? "actioned" : "dismissed";
          report.resolution_action = params.p_action;
          if (params.p_action === "remove") { if (comment) comment.moderation_state = "removed"; else post!.status = "removed"; }
        }
        return { data: [{ report_id: report.id, status: report.status, resolution_action: report.resolution_action ?? null, already_resolved: replay }], error: null };
      }
      assert.ok(store.rpc, `unexpected RPC ${name}`);
      return store.rpc(name, params);
    },
    auth: {
      getUser: async (token: string) =>
        TOKENS[token] ? { data: { user: { id: TOKENS[token] } }, error: null } : { data: { user: null }, error: { message: "bad" } },
    },
    from: (table: string) => {
      const rows = (store.tables[table] ??= []);
      let filters: [string, unknown][] = [];
      let gteFilters: [string, unknown][] = [];
      let matched: Row[] | null = null;
      let pendingOp: "update" | "delete" | null = null;
      let pendingPatch: Row = {};
      let limitN: number | undefined;
      const apply = () => {
        let out = matched ?? rows;
        out = out.filter((r) => filters.every(([c, v]) => (Array.isArray(v) ? (v as unknown[]).includes(r[c]) : r[c] === v)));
        out = out.filter((r) => gteFilters.every(([c, v]) => String(r[c]) >= String(v)));
        return limitN === undefined ? out : out.slice(0, limitN);
      };
      const uid = () => crypto.randomUUID(); // routes validate uuid params; fake ids must parse
      const b: Record<string, unknown> = {};
      b.select = () => b;
      // Filters after update()/delete() scope the mutation; filters before it are reads.
      b.eq = (c: string, v: unknown) => { if (pendingOp) matched = apply(); filters.push([c, v]); return b; };
      b.in = (c: string, vs: unknown[]) => { if (pendingOp) matched = apply(); filters.push([c, vs]); return b; };
      b.gte = (c: string, v: unknown) => { if (pendingOp) matched = apply(); gteFilters.push([c, v]); return b; };
      b.order = () => b;
      b.limit = (n: number) => { limitN = n; return b; };
      b.insert = (row: Row) => {
        const r = { ...row };
        const insertError = table === "community_comments" ? store.commentInsertError
          : table === "reports" ? store.reportInsertError : undefined;
        if (insertError) {
          b.single = async () => ({ data: null, error: insertError });
          return b;
        }
        if (table === "community_posts") r.status ??= "published";
        const dup =
          (table === "communities" && rows.some((x) => x.slug === r.slug)) ||
          (table === "referrals" && r.referred_user_id != null && rows.some((x) => x.referred_user_id === r.referred_user_id)) ||
          (table === "credit_ledger" && r.reference_id != null && rows.some((x) => x.source === r.source && x.reference_id === r.reference_id));
        if (dup) {
          b.single = async () => ({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } });
          b.maybeSingle = b.single;
          b.then = (res: (v: unknown) => unknown) => res({ data: null, error: { code: "23505", message: "dup" } });
          return b;
        }
        r.id ??= uid();
        r.created_at ??= new Date().toISOString();
        rows.push(r);
        b.single = async () => ({ data: table === "reports" ? store.reportReceipt ?? r : r, error: null });
        b.maybeSingle = b.single;
        b.then = (res: (v: unknown) => unknown) => res({ data: [r], error: null });
        return b;
      };
      b.upsert = (row: Row) => {
        rows.push({ id: uid(), created_at: new Date().toISOString(), ...row });
        b.single = async () => ({ data: row, error: null });
        return b;
      };
      b.update = (patch: Row) => {
        pendingOp = "update";
        pendingPatch = patch;
        b.single = async () => {
          const hit = apply()[0];
          if (hit) Object.assign(hit, patch);
          return { data: hit ?? null, error: null };
        };
        b.then = (res: (v: unknown) => unknown) => {
          const hits = apply();
          for (const h of hits) Object.assign(h, patch);
          return res({ data: hits, error: null });
        };
        return b;
      };
      b.delete = () => {
        pendingOp = "delete";
        b.then = (res: (v: unknown) => unknown) => {
          const hits = new Set(apply());
          store.tables[table] = rows.filter((r) => !hits.has(r));
          return res({ data: null, error: null });
        };
        return b;
      };
      b.single = async () => ({ data: apply()[0] ?? null, error: null });
      b.maybeSingle = async () => ({ data: apply()[0] ?? null, error: null });
      b.then = (res: (v: unknown) => unknown) => res({ data: apply(), error: null });
      return b;
    },
  };
  return client as never;
}

async function appWith(store: Store) {
  return buildApp(((token?: string) => fakeSupabase(store, token)) as never);
}

const as = (token: string) => ({ authorization: `Bearer ${token}` });
const svc = { "x-service-token": "svc-secret" };

function communityStore(visibility = "private", extraUsers: string[] = []): Store {
  const members: Row[] = [
    { community_id: "c1", user_id: "user-1", role: "owner", status: "active" },
    ...extraUsers.map((u) => ({ community_id: "c1", user_id: u, role: "member", status: "active" })),
  ];
  return {
    tables: {
      communities: [{ id: "c1", owner_user_id: "user-1", name: "Writers", slug: "writers", visibility, created_at: new Date().toISOString() }],
      community_members: members,
    },
  };
}

// ---- community ---------------------------------------------------------------
test("community creation uses the authenticated atomic RPC and sanitizes failures", async () => {
  for (const dbCode of [null, "23505", "42501", "22023", "XX000"]) {
    const app = await buildApp(token => fakeSupabase({ tables: {}, rpc: (name, params) => {
      assert.equal(token, "good", "creation must use the caller JWT, not service-role credentials");
      assert.equal(name, "create_community_with_owner");
      assert.deepEqual(params, { p_name: "Writers", p_slug: "writers", p_description: null, p_visibility: "private" });
      return { data: dbCode ? null : { id: "created", name: "Writers" }, error: dbCode ? { code: dbCode, message: "private database details" } : null };
    } }));
    try {
      const response = await app.inject({ method: "POST", url: "/v1/communities", headers: as("good"),
        payload: { name: " Writers ", slug: "writers", visibility: "private" } });
      assert.equal(response.statusCode, dbCode === null ? 201 : dbCode === "23505" ? 409 : dbCode === "42501" ? 403 : dbCode === "22023" ? 422 : 500);
      assert.doesNotMatch(response.body, /private database details/);
    } finally { await app.close(); }
  }
});

test("non-member cannot post in a private community; member can", async () => {
  const app = await appWith(communityStore("private"));
  const denied = await app.inject({ method: "POST", url: "/v1/communities/c1/posts", headers: as("other"), payload: { body: "hello" } });
  assert.equal(denied.statusCode, 403);
  const ok = await app.inject({ method: "POST", url: "/v1/communities/c1/posts", headers: as("good"), payload: { body: "hello" } });
  assert.equal(ok.statusCode, 201);
  await app.close();
});

test("non-member cannot read private community posts; public join works", async () => {
  const priv = await appWith(communityStore("private"));
  const denied = await priv.inject({ method: "GET", url: "/v1/communities/c1/posts", headers: as("other") });
  assert.equal(denied.statusCode, 403);
  await priv.close();

  const pub = await appWith(communityStore("public"));
  const join = await pub.inject({ method: "POST", url: "/v1/communities/c1/join", headers: as("other") });
  assert.equal(join.statusCode, 201);
  const read = await pub.inject({ method: "GET", url: "/v1/communities/c1/posts", headers: as("other") });
  assert.equal(read.statusCode, 200);
  await pub.close();
});

test("private community join rejected for non-member", async () => {
  const app = await appWith(communityStore("private"));
  const res = await app.inject({ method: "POST", url: "/v1/communities/c1/join", headers: as("other") });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test("post rate limit: 11th post in an hour -> 429", async () => {
  const app = await appWith(communityStore("public", []));
  let last = 0;
  for (let i = 0; i < 11; i++) {
    const res = await app.inject({ method: "POST", url: "/v1/communities/c1/posts", headers: as("good"), payload: { body: `post ${i}` } });
    last = res.statusCode;
  }
  assert.equal(last, 429);
  await app.close();
});

test("report creation validates input and uses the caller token with a private response", async () => {
  const store: Store = { tables: {} };
  const tokens: (string | undefined)[] = [];
  const app = await buildApp(((token?: string) => { tokens.push(token); return fakeSupabase(store, token); }) as never);
  try {
    const result = await app.inject({ method: "POST", url: "/v1/reports", headers: as("good"),
      payload: { entityType: "post", entityId: "b1200000-0000-4000-8000-000000000093", reason: "Review this content" } });
    assert.equal(result.statusCode, 201, result.body);
    assert.equal(tokens.at(-1), "good", "report writes must not bypass scoped RLS with service privileges");
    assert.equal(result.headers["cache-control"], "private, no-store");
    assert.equal(result.json().reporter_id, "user-1");
  } finally { await app.close(); }
});

test("report creation rejects malformed target IDs and blank reasons before writing", async () => {
  const store: Store = { tables: {} };
  const app = await appWith(store);
  try {
    for (const payload of [
      { entityType: "post", entityId: "not-an-id", reason: "Review" },
      { entityType: "comment", entityId: "b1200000-0000-4000-8000-000000000093", reason: "   " },
    ]) {
      const result = await app.inject({ method: "POST", url: "/v1/reports", headers: as("good"), payload });
      assert.equal(result.statusCode, 422, result.body);
    }
    assert.equal(store.tables.reports?.length ?? 0, 0);
  } finally { await app.close(); }
});

test("report creation projects permission, validation and storage failures without database details", async () => {
  for (const [code, status] of [["42501",403],["23514",422],["22023",422],["22P02",422],["XX000",503]] as const) {
    const app = await appWith({ tables: {}, reportInsertError: { code, message: "private database row details" } });
    try {
      const result = await app.inject({ method: "POST", url: "/v1/reports", headers: as("other"),
        payload: { entityType: "post", entityId: "b1200000-0000-4000-8000-000000000094", reason: "Review" } });
      assert.equal(result.statusCode, status, result.body);
      assert.doesNotMatch(result.body, /private database row details/);
      assert.equal(result.headers["cache-control"], "private, no-store");
    } finally { await app.close(); }
  }
});

test("a report receipt cannot substitute another target or reporter", async () => {
  const entityId = "b1200000-0000-4000-8000-000000000095";
  const app = await appWith({ tables: {}, reportReceipt: { id: crypto.randomUUID(), reporter_id: "private-reporter",
    entity_type: "post", entity_id: entityId, reason: "Review", status: "open", created_at: new Date().toISOString() } });
  try {
    const result = await app.inject({ method: "POST", url: "/v1/reports", headers: as("good"),
      payload: { entityType: "post", entityId, reason: "Review" } });
    assert.equal(result.statusCode, 503, result.body);
    assert.doesNotMatch(result.body, /private-reporter/);
  } finally { await app.close(); }
});

test("moderation queue rejects invalid windows and projects invalid or unavailable data safely", async () => {
  for (const [result, status] of [
    [{ data: null, error: { code: "42501", message: "private database details" } },403],
    [{ data: null, error: { code: "XX000", message: "private database details" } },503],
    [{ data: [{ id: "invalid-report", reporter_id: "private-reporter" }], error: null },503],
  ] as const) {
    const app = await appWith({ tables: {}, rpc() { return result; } });
    try {
      const queue = await app.inject({ method: "GET", url: "/v1/moderation/queue", headers: as("good") });
      assert.equal(queue.statusCode, status, queue.body);
      assert.doesNotMatch(queue.body, /private database details|private-reporter/);
      assert.equal(queue.headers["cache-control"], "private, no-store");
      for (const query of ["limit=0", "offset=-1", "extra=1"]) {
        const invalid = await app.inject({ method: "GET", url: "/v1/moderation/queue?" + query, headers: as("good") });
        assert.equal(invalid.statusCode, 422, invalid.body);
      }
    } finally { await app.close(); }
  }
});

test("reaction writes project changed access, invalid arguments and uncertain storage safely", async () => {
  for (const [code, status] of [["42501",403],["22023",422],["22P02",422],["XX000",503]] as const) {
    const store = communityStore("public");
    store.tables.community_posts = [{ id: "published-post", community_id: "c1", status: "published" }];
    store.rpc = () => ({ data: null, error: { code, message: "private database details" } });
    const app = await appWith(store);
    try {
      const result = await app.inject({ method: "POST", url: "/v1/posts/published-post/reactions", headers: as("good"), payload: { kind: "like" } });
      assert.equal(result.statusCode, status, result.body);
      assert.doesNotMatch(result.body, /private database details/);
    } finally { await app.close(); }
  }
});

test("report + moderate remove: post hidden from feed, report actioned", async () => {
  const store = communityStore("public", ["user-2"]);
  const app = await appWith(store);
  const post = await app.inject({ method: "POST", url: "/v1/communities/c1/posts", headers: as("other"), payload: { body: "spam" } });
  const postId = post.json().id as string;
  const report = await app.inject({ method: "POST", url: "/v1/reports", headers: as("good"), payload: { entityType: "post", entityId: postId, reason: "spam" } });
  assert.equal(report.statusCode, 201, report.body);

  const queue = await app.inject({ method: "GET", url: "/v1/moderation/queue", headers: as("good") });
  assert.equal(queue.json().reports.length, 1);
  // non-moderator sees an empty queue
  const q2 = await app.inject({ method: "GET", url: "/v1/moderation/queue", headers: as("other") });
  assert.equal(q2.json().reports.length, 0);

  const mod = await app.inject({ method: "POST", url: `/v1/moderation/${report.json().id}/remove`, headers: as("good") });
  assert.equal(mod.statusCode, 200);
  assert.equal(mod.json().status, "actioned");
  const row = store.tables.community_posts.find((p) => p.id === postId);
  assert.equal(row?.status, "removed");

  const feed = await app.inject({ method: "GET", url: "/v1/communities/c1/posts", headers: as("other") });
  assert.equal(feed.json().posts.length, 0);
  await app.close();
});

test("removed comment remains stored but is omitted from community reads", async () => {
  const store = communityStore("public", ["user-2"]);
  const app = await appWith(store);
  const post = await app.inject({ method: "POST", url: "/v1/communities/c1/posts", headers: as("other"), payload: { body: "Conversation" } });
  const postId = post.json().id as string;
  const created = await app.inject({ method: "POST", url: "/v1/posts/" + postId + "/comments", headers: as("other"), payload: { body: "Reported reply" } });
  assert.equal(created.statusCode, 201, created.body);
  const commentId = created.json().id as string;
  const stored = store.tables.community_comments.find((row) => row.id === commentId);
  assert.equal(stored?.moderation_state, "visible");

  const visible = await app.inject({ method: "GET", url: "/v1/posts/" + postId + "/comments", headers: as("good") });
  assert.equal(visible.json().comments.length, 1);
  stored!.moderation_state = "removed";
  const hidden = await app.inject({ method: "GET", url: "/v1/posts/" + postId + "/comments", headers: as("good") });
  assert.equal(hidden.json().comments.length, 0);
  assert.equal(stored?.body, "Reported reply", "removal is soft and retains moderation evidence");
  await app.close();
});

test("removed posts deny comment reads and new comments or reactions", async () => {
  const store = communityStore("public", ["user-2"]);
  store.tables.community_posts = [{ id: "removed-post", community_id: "c1", status: "removed" }];
  store.tables.community_comments = [{ id: "visible-reply", post_id: "removed-post", body: "Hidden parent discussion", moderation_state: "visible" }];
  const app = await appWith(store);
  try {
    for (const request of [
      { method: "GET" as const, url: "/v1/posts/removed-post/comments" },
      { method: "POST" as const, url: "/v1/posts/removed-post/comments", payload: { body: "New reply" } },
      { method: "POST" as const, url: "/v1/posts/removed-post/reactions", payload: { kind: "like" } },
    ]) {
      const result = await app.inject({ ...request, headers: as("other") });
      assert.equal(result.statusCode, 404, result.body);
      assert.equal(result.body.includes("Hidden parent discussion"), false);
    }
    assert.equal(store.tables.community_comments.length, 1);
    assert.equal(store.tables.community_post_reactions?.length ?? 0, 0);
  } finally { await app.close(); }
});

test("a community moderator cannot see or resolve reports from another community", async () => {
  const reportId = "a1200000-0000-4000-8000-000000000011";
  const postId = "b1200000-0000-4000-8000-000000000011";
  const store: Store = { tables: {
    communities: [
      { id: "c1", owner_user_id: "user-1", name: "Local", visibility: "public" },
      { id: "c2", owner_user_id: "user-2", name: "Other", visibility: "public" },
    ],
    community_members: [
      { community_id: "c1", user_id: "user-1", role: "moderator", status: "active" },
      { community_id: "c2", user_id: "user-2", role: "owner", status: "active" },
    ],
    community_posts: [{ id: postId, community_id: "c2", author_id: "user-2", body: "Other community post", status: "published" }],
    reports: [{ id: reportId, entity_type: "post", entity_id: postId, reason: "spam", status: "open", reporter_id: "user-1" }],
  } };
  const app = await appWith(store);
  const queue = await app.inject({ method: "GET", url: "/v1/moderation/queue", headers: as("good") });
  assert.equal(queue.statusCode, 200);
  assert.equal(queue.json().reports.length, 0, "community moderators see only reports in their own communities");
  const attempted = await app.inject({ method: "POST", url: "/v1/moderation/" + reportId + "/remove", headers: as("good") });
  assert.equal(attempted.statusCode, 403);
  assert.equal(store.tables.reports[0].status, "open");
  assert.equal(store.tables.community_posts[0].status, "published");
  store.tables.reports[0].status = "dismissed";
  store.tables.reports[0].resolution_action = "dismiss";
  const closed = await app.inject({ method: "POST", url: "/v1/moderation/" + reportId + "/remove", headers: as("good") });
  assert.equal(closed.statusCode, 403, "closed-report replay still requires scoped moderator authority");
  await app.close();
});

test("community resolution uses the caller-bound atomic RPC and rejects a foreign receipt", async () => {
  const reportId = "a1200000-0000-4000-8000-000000000091";
  const tokens: (string | undefined)[] = [];
  const store: Store = { tables: {}, rpc(name, params) {
    assert.equal(name, "moderate_community_report");
    assert.deepEqual(params, { p_report_id: reportId, p_action: "dismiss" });
    return { data: [{ report_id: "a1200000-0000-4000-8000-000000000099", status: "dismissed", resolution_action: "dismiss", already_resolved: false }], error: null };
  } };
  const app = await buildApp(((token?: string) => { tokens.push(token); return fakeSupabase(store, token); }) as never);
  try {
    const result = await app.inject({ method: "POST", url: "/v1/moderation/" + reportId + "/dismiss", headers: as("good") });
    assert.equal(result.statusCode, 503, result.body);
    assert.equal(tokens.at(-1), "good", "the resolution must not use a service-role client");
    assert.equal(result.headers["cache-control"], "private, no-store");
  } finally { await app.close(); }
});

test("moderator queue includes comment reports and uses caller-bound scope with no reporter identity", async () => {
  const reportId = "a1200000-0000-4000-8000-000000000092";
  const commentId = "b1200000-0000-4000-8000-000000000092";
  const calls: (string | undefined)[] = [];
  const app = await buildApp(((token?: string) => { calls.push(token); return fakeSupabase({ tables: {}, rpc(name, params) {
    assert.equal(name, "community_moderation_queue");
    assert.deepEqual(params, { p_limit: 51, p_offset: 0 });
    return { data: [{ id: reportId, entity_type: "comment", entity_id: commentId, reason: "Review reply", status: "open",
      created_at: "2026-10-05T00:00:00Z", target: null, reporter_id: "private-reporter" }], error: null };
  } }, token); }) as never);
  try {
    const result = await app.inject({ method: "GET", url: "/v1/moderation/queue", headers: as("good") });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().reports[0]?.entity_type, "comment");
    assert.equal(calls.at(-1), "good");
    assert.doesNotMatch(result.body, /private-reporter|reporter_id/);
    assert.equal(result.headers["cache-control"], "private, no-store");
  } finally { await app.close(); }
});

test("comment permission changed during save is actionable and does not leak database details", async () => {
  const store = communityStore("public");
  store.tables.community_posts = [{ id: "published-post", community_id: "c1", status: "published" }];
  store.commentInsertError = { code: "42501", message: "private database row details" };
  const app = await appWith(store);
  try {
    const result = await app.inject({ method: "POST", url: "/v1/posts/published-post/comments", headers: as("good"), payload: { body: "Reply" } });
    assert.equal(result.statusCode, 403, result.body);
    assert.doesNotMatch(result.body, /private database row details/);
  } finally { await app.close(); }
});

test("reaction toggle is caller-bound and rejects a foreign receipt", async () => {
  const store = communityStore("public");
  store.tables.community_posts = [{ id: "published-post", community_id: "c1", status: "published" }];
  const tokens: (string | undefined)[] = [];
  store.rpc = (name, params) => {
    assert.equal(name, "toggle_community_reaction");
    assert.deepEqual(params, { p_post_id: "published-post", p_kind: "like" });
    return { data: { postId: "foreign-post", kind: "like", active: true }, error: null };
  };
  const app = await buildApp(((token?: string) => { tokens.push(token); return fakeSupabase(store, token); }) as never);
  try {
    const result = await app.inject({ method: "POST", url: "/v1/posts/published-post/reactions", headers: as("good"), payload: { kind: "like" } });
    assert.equal(result.statusCode, 503, result.body);
    assert.equal(tokens.at(-1), "good");
    assert.equal(result.headers["cache-control"], "private, no-store");
  } finally { await app.close(); }
});

// ---- referrals ---------------------------------------------------------------
function referralStore(): Store {
  return {
    tables: {
      referral_codes: [{ id: "code-1", user_id: "user-1", code: "bw-test", status: "active", created_at: new Date().toISOString() }],
      credit_ledger: [],
      referrals: [],
    },
  };
}

test("self-referral rejected; one referral per referred user", async () => {
  const store = referralStore();
  const app = await appWith(store);
  const self = await app.inject({ method: "POST", url: "/v1/referrals/claim", headers: as("good"), payload: { code: "bw-test" } });
  assert.equal(self.statusCode, 422);
  const claim = await app.inject({ method: "POST", url: "/v1/referrals/claim", headers: as("other"), payload: { code: " BW-TEST " } });
  assert.equal(claim.statusCode, 201);
  const again = await app.inject({ method: "POST", url: "/v1/referrals/claim", headers: as("other"), payload: { code: "bw-test" } });
  assert.equal(again.json().alreadyAttributed, true);
  assert.equal(store.tables.referrals.length, 1);
  const incoming = await app.inject({ method: "GET", url: "/v1/referrals", headers: as("other") });
  const outgoing = await app.inject({ method: "GET", url: "/v1/referrals", headers: as("good") });
  assert.equal(incoming.json().referrals.length, 0);
  assert.equal(outgoing.json().referrals.length, 1);
  await app.close();
});

// Transaction accounting is exercised against actual PostgreSQL in
// tests/security/referral-transactions.test.sql. These checks cover the HTTP boundary.
const referredId = "a8700000-0000-4000-8000-000000000002";
const refId = "a8710000-0000-4000-8000-000000000002";

test("qualification requires service auth and a UUID, then calls one transaction", async () => {
  const calls: Row[] = [];
  const app = await appWith({ tables: {}, rpc: (name, params) => {
    assert.equal(name, "transition_referral");
    calls.push(params);
    return { data: { qualified: true, held: false, rewarded: true, referral: { id: refId, status: "rewarded" } }, error: null };
  } });
  const denied = await app.inject({ method: "POST", url: "/v1/referrals/qualify", payload: { referredUserId: referredId } });
  assert.equal(denied.statusCode, 401);
  const malformedToken = await app.inject({ method: "POST", url: "/v1/referrals/qualify", headers: { "x-service-token": "éééééééééé" }, payload: { referredUserId: referredId } });
  assert.equal(malformedToken.statusCode, 401);
  const invalid = await app.inject({ method: "POST", url: "/v1/referrals/qualify", headers: svc, payload: { referredUserId: "invalid" } });
  assert.equal(invalid.statusCode, 422);
  assert.equal(calls.length, 0);
  const valid = await app.inject({ method: "POST", url: "/v1/referrals/qualify", headers: svc, payload: { referredUserId: referredId } });
  assert.equal(valid.statusCode, 200, valid.body);
  assert.equal(valid.json().rewarded, true);
  assert.deepEqual(calls, [{ p_action: "qualify", p_referred_user_id: referredId }]);
  await app.close();
});

test("review and reversal require admin and forward the transaction result", async () => {
  const calls: Row[] = [];
  const app = await appWith({ tables: {}, rpc: (name, params) => {
    assert.equal(name, "transition_referral"); calls.push(params);
    return { data: { alreadyResolved: true, referral: { id: refId, status: "reversed" } }, error: null };
  } });
  for (const path of ["review", "reverse"]) {
    const denied = await app.inject({ method: "POST", url: `/v1/referrals/${refId}/${path}`, headers: as("good"), ...(path === "review" ? { payload: { action: "approve" } } : {}) });
    assert.equal(denied.statusCode, 403);
  }
  const invalid = await app.inject({ method: "POST", url: "/v1/referrals/no-id/reverse", headers: as("admin") });
  assert.equal(invalid.statusCode, 422);
  assert.equal(calls.length, 0);
  for (const action of ["approve", "reject", "reverse"]) {
    const response = await app.inject({ method: "POST", url: `/v1/referrals/${refId}/${action === "reverse" ? "reverse" : "review"}`, headers: as("admin"), ...(action === "reverse" ? {} : { payload: { action } }) });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().alreadyResolved, true);
  }
  assert.deepEqual(calls, ["approve", "reject", "reverse"].map((action) => ({ p_action: action, p_referral_id: refId })));
  await app.close();
});

test("referral transaction errors retain their actionable HTTP status", async () => {
  let dbCode = "P0002";
  const app = await appWith({ tables: {}, rpc: () => ({ data: null, error: { code: dbCode, message: "database failure" } }) });
  for (const [code, expected] of [["P0002", 404], ["22023", 422], ["55000", 409], ["XX000", 500]] as const) {
    dbCode = code;
    const response = await app.inject({ method: "POST", url: `/v1/referrals/${refId}/reverse`, headers: as("admin") });
    assert.equal(response.statusCode, expected);
  }
  await app.close();
});

test("code creation uses the authenticated author and the atomic allocator", async () => {
  const calls: Row[] = [];
  const app = await appWith({ tables: {}, rpc: (name, params) => {
    assert.equal(name, "get_or_create_referral_code"); calls.push(params);
    return { data: { code: "bw-1234abcd" }, error: null };
  } });
  const responses = await Promise.all([1, 2].map(() => app.inject({ method: "GET", url: "/v1/referrals/code", headers: as("good") })));
  assert.ok(responses.every((r) => r.statusCode === 200 && r.json().code === "bw-1234abcd"));
  assert.deepEqual(calls, [{ p_user_id: "user-1" }, { p_user_id: "user-1" }]);
  await app.close();
});

test("bounded ledger history carries independent lifetime totals and cannot hide summary failures", async () => {
  let failSummary = false;
  const store: Store = {
    tables: { credit_ledger: Array.from({ length: 150 }, (_, id) => ({ id, user_id: "user-1", amount: 1, balance_after: id + 1 })) },
    rpc: (name, params) => {
      assert.equal(name, "referral_credit_summary"); assert.deepEqual(params, { p_user_id: "user-1" });
      return failSummary ? { data: null, error: { code: "XX000", message: "summary unavailable" } }
        : { data: { creditBalance: 150, referralCredits: 100, rewardedReferrals: 1 }, error: null };
    },
  };
  const app = await appWith(store);
  const response = await app.inject({ method: "GET", url: "/v1/referrals/ledger", headers: as("good") });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().entries.length, 100);
  assert.deepEqual(response.json().summary, { creditBalance: 150, referralCredits: 100, rewardedReferrals: 1 });
  failSummary = true;
  const failed = await app.inject({ method: "GET", url: "/v1/referrals/ledger", headers: as("good") });
  assert.equal(failed.statusCode, 500);
  await app.close();
});
