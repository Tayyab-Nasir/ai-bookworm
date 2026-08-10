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
}

const TOKENS: Record<string, string> = { good: "user-1", other: "user-2", admin: "admin-1" };

function fakeSupabase(store: Store) {
  const client = {
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
      const apply = () => {
        let out = matched ?? rows;
        out = out.filter((r) => filters.every(([c, v]) => (Array.isArray(v) ? (v as unknown[]).includes(r[c]) : r[c] === v)));
        out = out.filter((r) => gteFilters.every(([c, v]) => String(r[c]) >= String(v)));
        return out;
      };
      const uid = () => crypto.randomUUID(); // routes validate uuid params; fake ids must parse
      const b: Record<string, unknown> = {};
      b.select = () => b;
      // Filters after update()/delete() scope the mutation; filters before it are reads.
      b.eq = (c: string, v: unknown) => { if (pendingOp) matched = apply(); filters.push([c, v]); return b; };
      b.in = (c: string, vs: unknown[]) => { if (pendingOp) matched = apply(); filters.push([c, vs]); return b; };
      b.gte = (c: string, v: unknown) => { if (pendingOp) matched = apply(); gteFilters.push([c, v]); return b; };
      b.order = () => b;
      b.limit = () => b;
      b.insert = (row: Row) => {
        const r = { ...row };
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
        b.single = async () => ({ data: r, error: null });
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
  return buildApp((() => fakeSupabase(store)) as never);
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
  const claim = await app.inject({ method: "POST", url: "/v1/referrals/claim", headers: as("other"), payload: { code: "bw-test" } });
  assert.equal(claim.statusCode, 201);
  const again = await app.inject({ method: "POST", url: "/v1/referrals/claim", headers: as("other"), payload: { code: "bw-test" } });
  assert.equal(again.json().alreadyAttributed, true);
  assert.equal(store.tables.referrals.length, 1);
  await app.close();
});

test("qualify posts exactly one reward; replay is a no-op", async () => {
  const store = referralStore();
  const app = await appWith(store);
  await app.inject({ method: "POST", url: "/v1/referrals/claim", headers: as("other"), payload: { code: "bw-test" } });
  const q1 = await app.inject({ method: "POST", url: "/v1/referrals/qualify", headers: svc, payload: { referredUserId: "user-2" } });
  assert.equal(q1.statusCode, 200, q1.body);
  assert.equal(q1.json().rewarded, true);
  assert.equal(q1.json().referral.status, "rewarded");
  const rewards = () => store.tables.credit_ledger.filter((r) => r.source === "referral_reward");
  assert.equal(rewards().length, 1);
  assert.equal(rewards()[0].amount, 100);
  // replay: terminal status short-circuits — no second ledger entry
  const q2 = await app.inject({ method: "POST", url: "/v1/referrals/qualify", headers: svc, payload: { referredUserId: "user-2" } });
  assert.equal(q2.statusCode, 200);
  assert.equal(q2.json().duplicate, true);
  assert.equal(rewards().length, 1);
  // service token required
  const noAuth = await app.inject({ method: "POST", url: "/v1/referrals/qualify", payload: { referredUserId: "user-2" } });
  assert.equal(noAuth.statusCode, 401);
  await app.close();
});

test("velocity flag holds the reward: no ledger entry until review", async () => {
  const store = referralStore();
  // 21 referrals in the last 24h for referrer user-1 => velocity flag
  for (let i = 0; i < 21; i++) {
    store.tables.referrals.push({
      id: `r-old-${i}`, referrer_id: "user-1", referred_user_id: `u-old-${i}`, code_id: "code-1",
      status: "attributed", flagged: false, created_at: new Date().toISOString(),
    });
  }
  const app = await appWith(store);
  await app.inject({ method: "POST", url: "/v1/referrals/claim", headers: as("other"), payload: { code: "bw-test" } });
  const q = await app.inject({ method: "POST", url: "/v1/referrals/qualify", headers: svc, payload: { referredUserId: "user-2" } });
  assert.equal(q.json().held, true);
  assert.equal(q.json().referral.status, "held");
  assert.equal(store.tables.credit_ledger.filter((r) => r.source === "referral_reward").length, 0);
  await app.close();
});

test("admin review approve posts the reward exactly once", async () => {
  const store = referralStore();
  for (let i = 0; i < 21; i++) {
    store.tables.referrals.push({
      id: `r-old-${i}`, referrer_id: "user-1", referred_user_id: `u-old-${i}`, code_id: "code-1",
      status: "attributed", flagged: false, created_at: new Date().toISOString(),
    });
  }
  const app = await appWith(store);
  await app.inject({ method: "POST", url: "/v1/referrals/claim", headers: as("other"), payload: { code: "bw-test" } });
  const q = await app.inject({ method: "POST", url: "/v1/referrals/qualify", headers: svc, payload: { referredUserId: "user-2" } });
  const referralId = q.json().referral.id as string;

  // non-admin cannot review
  const forbidden = await app.inject({ method: "POST", url: `/v1/referrals/${referralId}/review`, headers: as("good"), payload: { action: "approve" } });
  assert.equal(forbidden.statusCode, 403);

  const approve = await app.inject({ method: "POST", url: `/v1/referrals/${referralId}/review`, headers: as("admin"), payload: { action: "approve" } });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().referral.status, "rewarded");
  const rewards = () => store.tables.credit_ledger.filter((r) => r.source === "referral_reward");
  assert.equal(rewards().length, 1);
  // second approve: already resolved, no double post
  const again = await app.inject({ method: "POST", url: `/v1/referrals/${referralId}/review`, headers: as("admin"), payload: { action: "approve" } });
  assert.equal(again.json().alreadyResolved, true);
  assert.equal(rewards().length, 1);
  await app.close();
});

test("reversal creates a compensating negative entry; cannot reverse twice", async () => {
  const store = referralStore();
  const app = await appWith(store);
  await app.inject({ method: "POST", url: "/v1/referrals/claim", headers: as("other"), payload: { code: "bw-test" } });
  const q = await app.inject({ method: "POST", url: "/v1/referrals/qualify", headers: svc, payload: { referredUserId: "user-2" } });
  const referralId = q.json().referral.id as string;

  const rev = await app.inject({ method: "POST", url: `/v1/referrals/${referralId}/reverse`, headers: as("admin") });
  assert.equal(rev.statusCode, 200);
  assert.equal(rev.json().reversedAmount, -100);
  const entries = store.tables.credit_ledger;
  assert.equal(entries.length, 2);
  const reversal = entries.find((r) => r.source === "reversal");
  assert.equal(reversal?.amount, -100);
  assert.equal(reversal?.reference_id, referralId);
  assert.equal(reversal?.balance_after, 0);
  assert.equal(store.tables.referrals.find((r) => r.id === referralId)?.status, "reversed");

  const again = await app.inject({ method: "POST", url: `/v1/referrals/${referralId}/reverse`, headers: as("admin") });
  assert.equal(again.json().alreadyReversed, true);
  assert.equal(entries.length, 2);
  await app.close();
});

test("GET /v1/referrals/code auto-creates once", async () => {
  const store: Store = { tables: {} };
  const app = await appWith(store);
  const c1 = await app.inject({ method: "GET", url: "/v1/referrals/code", headers: as("good") });
  assert.equal(c1.statusCode, 200);
  const c2 = await app.inject({ method: "GET", url: "/v1/referrals/code", headers: as("good") });
  assert.equal(c1.json().code, c2.json().code);
  assert.equal(store.tables.referral_codes.length, 1);
  await app.close();
});
