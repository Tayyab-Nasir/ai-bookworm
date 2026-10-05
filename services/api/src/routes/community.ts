import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "../lib/supabase.js";

const createCommunitySchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/),
  description: z.string().max(2000).optional(),
  visibility: z.enum(["private", "public", "unlisted"]).default("public"),
});

const postSchema = z.object({
  title: z.string().max(300).optional(),
  body: z.string().min(1).max(20000),
});

const commentSchema = z.object({ body: z.string().min(1).max(5000) });

const reactionSchema = z.object({ kind: z.enum(["like", "love", "insightful", "celebrate"]) });

const reportSchema = z.object({
  entityType: z.enum(["post", "comment"]),
  entityId: z.string().uuid(),
  reason: z.string().trim().min(1).max(1000),
}).strict();

// ponytail: in-memory fixed-window rate limits — per-instance, reset on
// restart. Ceiling: multi-instance deploys under-count. Upgrade path: Redis
// INCR + EXPIRE (REDIS_URL already in env) when running >1 API instance.
function fixedWindow(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (key: string) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now > h.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    if (h.count >= limit) return false;
    h.count++;
    return true;
  };
}
const allowPost = fixedWindow(10, 60 * 60 * 1000); // 10 posts/hour/user
const allowReport = fixedWindow(20, 60 * 60 * 1000); // 20 reports/hour/user

type CommunityRow = { id: string; visibility: string; owner_user_id: string };

async function getCommunity(svc: SupabaseClient, id: string): Promise<CommunityRow> {
  const { data } = await svc.from("communities").select("id,visibility,owner_user_id").eq("id", id).maybeSingle();
  if (!data) throw new AppError(404, "community not found");
  return data as CommunityRow;
}

async function memberRole(svc: SupabaseClient, communityId: string, userId: string) {
  const { data } = await svc
    .from("community_members")
    .select("role")
    .eq("community_id", communityId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return (data as { role?: string } | null)?.role;
}

async function requireMember(svc: SupabaseClient, communityId: string, userId: string) {
  const role = await memberRole(svc, communityId, userId);
  if (!role) throw new AppError(403, "not a community member");
  return role;
}

async function requireModerator(svc: SupabaseClient, communityId: string, userId: string) {
  const role = await requireMember(svc, communityId, userId);
  if (role !== "owner" && role !== "moderator") throw new AppError(403, "moderator required");
  return role;
}

function requireReadable(c: CommunityRow, role: string | undefined, userId: string) {
  if (c.visibility === "public") return;
  if (role || c.owner_user_id === userId) return;
  throw new AppError(403, "community is not public");
}

export function communityRoutes(app: FastifyInstance) {
  // Discovery: public communities + ones the user belongs to (client filters).
  app.get("/communities", async (req) => {
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb.from("communities").select("*").order("created_at", { ascending: false });
    if (error) throw new AppError(500, error.message);
    return { communities: data };
  });

  app.post("/communities", async (req, reply) => {
    const parsed = createCommunitySchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid community", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb.rpc("create_community_with_owner", {
      p_name: parsed.data.name, p_slug: parsed.data.slug,
      p_description: parsed.data.description ?? null, p_visibility: parsed.data.visibility,
    });
    if (error) {
      if ((error as { code?: string }).code === "23505") throw new AppError(409, "slug already taken");
      if (error.code === "42501") throw new AppError(403, "Community creation requires an authenticated account.");
      if (error.code === "22023") throw new AppError(422, "invalid community");
      throw new AppError(500, "Community creation could not be confirmed. Refresh the directory before trying again.");
    }
    return reply.status(201).send(data);
  });

  // Public communities are open-join. Private/unlisted need an owner/moderator
  // to add the member — ponytail: no invites table; owner adds by userId,
  // add an invitation flow when email infra lands.
  app.post("/communities/:id/join", async (req, reply) => {
    const { id } = req.params as { id: string };
    const svc = app.supabaseFactory();
    const community = await getCommunity(svc, id);
    const existing = await memberRole(svc, id, req.userId);
    if (existing) return { communityId: id, role: existing, alreadyMember: true };
    if (community.visibility !== "public") throw new AppError(403, "community is not open to join");
    const { error } = await svc
      .from("community_members")
      .insert({ community_id: id, user_id: req.userId, role: "member", status: "active" });
    if (error) throw new AppError(500, error.message);
    return reply.status(201).send({ communityId: id, role: "member" });
  });

  // Owner/moderator adds a member (private-community invite path).
  app.post("/communities/:id/members", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ userId: z.string().uuid(), role: z.enum(["member", "moderator"]).default("member") }).safeParse(req.body);
    if (!body.success) throw new AppError(422, "invalid member", { issues: body.error.issues });
    const svc = app.supabaseFactory();
    await requireModerator(svc, id, req.userId);
    const { data, error } = await svc
      .from("community_members")
      .upsert({ community_id: id, user_id: body.data.userId, role: body.data.role, status: "active" })
      .select()
      .single();
    if (error) throw new AppError(500, error.message);
    return reply.status(201).send(data);
  });

  app.get("/communities/:id/posts", async (req) => {
    const { id } = req.params as { id: string };
    const svc = app.supabaseFactory();
    const community = await getCommunity(svc, id);
    const role = await memberRole(svc, id, req.userId);
    requireReadable(community, role, req.userId);
    // Removed posts visible only to moderators (RLS hides nothing at row level).
    let q = svc.from("community_posts").select("*").eq("community_id", id).order("created_at", { ascending: false });
    if (role !== "owner" && role !== "moderator") q = q.eq("status", "published");
    const { data, error } = await q;
    if (error) throw new AppError(500, error.message);
    return { posts: data, role: role ?? null };
  });

  app.post("/communities/:id/posts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = postSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid post", { issues: parsed.error.issues });
    const svc = app.supabaseFactory();
    await requireMember(svc, id, req.userId);
    if (!allowPost(req.userId)) throw new AppError(429, "post rate limit exceeded (10/hour)");
    const { data, error } = await svc
      .from("community_posts")
      .insert({ community_id: id, author_id: req.userId, title: parsed.data.title ?? null, body: parsed.data.body })
      .select()
      .single();
    if (error) throw new AppError(500, error.message);
    return reply.status(201).send(data);
  });

  app.get("/posts/:postId/comments", async (req) => {
    const { postId } = req.params as { postId: string };
    const svc = app.supabaseFactory();
    const post = await getPost(svc, postId);
    requirePublishedPost(post);
    const role = await memberRole(svc, post.community_id, req.userId);
    requireReadable(post.community, role, req.userId);
    const { data, error } = await app.supabaseFactory(req.userToken).from("community_comments").select("*")
      .eq("post_id", postId).eq("moderation_state", "visible").order("created_at");
    if (error) throw new AppError(503, "Discussion replies could not be loaded. Refresh before trying again.");
    return { comments: data };
  });

  app.post("/posts/:postId/comments", async (req, reply) => {
    const { postId } = req.params as { postId: string };
    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid comment", { issues: parsed.error.issues });
    const svc = app.supabaseFactory();
    const post = await getPost(svc, postId);
    requirePublishedPost(post);
    await requireMember(svc, post.community_id, req.userId);
    const { data, error } = await app.supabaseFactory(req.userToken)
      .from("community_comments")
      .insert({ post_id: postId, author_id: req.userId, body: parsed.data.body, moderation_state: "visible" })
      .select()
      .single();
    discussionWriteError(error);
    return reply.status(201).send(data);
  });

  // Toggle: react again with the same kind to unreact.
  app.post("/posts/:postId/reactions", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const { postId } = req.params as { postId: string };
    const parsed = reactionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid reaction", { issues: parsed.error.issues });
    const svc = app.supabaseFactory();
    const post = await getPost(svc, postId);
    requirePublishedPost(post);
    await requireMember(svc, post.community_id, req.userId);
    const { data, error } = await app.supabaseFactory(req.userToken).rpc("toggle_community_reaction", {
      p_post_id: postId, p_kind: parsed.data.kind,
    });
    discussionWriteError(error);
    const receipt = z.object({ postId: z.literal(postId), kind: z.literal(parsed.data.kind), active: z.boolean() }).safeParse(data);
    if (!receipt.success) throw new AppError(503, "Reaction outcome could not be verified. Refresh before trying again.");
    return receipt.data;
  });

  app.post("/reports", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid report", { issues: parsed.error.issues });
    if (!allowReport(req.userId)) throw new AppError(429, "report rate limit exceeded");
    const { data, error } = await app.supabaseFactory(req.userToken)
      .from("reports")
      .insert({ reporter_id: req.userId, entity_type: parsed.data.entityType, entity_id: parsed.data.entityId, reason: parsed.data.reason, status: "open" })
      .select()
      .single();
    if (error?.code === "42501") throw new AppError(403, "This content is not available to report.");
    if (error && ["23514", "22023", "22P02"].includes(error.code)) throw new AppError(422, "Choose a valid report target and reason.");
    if (error) throw new AppError(503, "Report save could not be confirmed. Refresh before trying again.");
    const receipt = z.object({ id: z.string().uuid(), reporter_id: z.literal(req.userId),
      entity_type: z.literal(parsed.data.entityType), entity_id: z.literal(parsed.data.entityId),
      reason: z.literal(parsed.data.reason), status: z.literal("open"), created_at: z.string().datetime({ offset: true }),
    }).safeParse(data);
    if (!receipt.success) throw new AppError(503, "Report save could not be verified. Refresh before trying again.");
    return reply.status(201).send(receipt.data);
  });

  // Moderation queue: open reports for communities the user moderates.
  app.get("/moderation/queue", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(1000000).default(0),
    }).strict().safeParse(req.query ?? {});
    if (!query.success) throw new AppError(422, "Choose a valid moderation queue window.");
    const { data, error } = await app.supabaseFactory(req.userToken).rpc("community_moderation_queue", {
      p_limit: query.data.limit + 1, p_offset: query.data.offset,
    });
    if (error?.code === "42501") throw new AppError(403, "Community access required.");
    if (error) throw new AppError(503, "The moderation queue could not be loaded. Refresh before trying again.");
    const reports = z.array(z.object({ id: z.string().uuid(), entity_type: z.enum(["post", "comment"]),
      entity_id: z.string().uuid(), reason: z.string().min(1).max(1000), status: z.literal("open"),
      created_at: z.string().datetime({ offset: true }),
      target: z.union([
        z.object({ type: z.literal("post"), title: z.string().nullable(), body: z.string(), status: z.string(), communityName: z.string().nullable() }).strip(),
        z.object({ type: z.literal("comment"), body: z.string(), moderationState: z.enum(["visible","removed"]),
          parentTitle: z.string().nullable(), parentBody: z.string().nullable(), communityName: z.string().nullable() }).strip(),
      ]).nullable(),
    }).strip()).max(query.data.limit + 1).safeParse(data ?? []);
    if (!reports.success) throw new AppError(503, "The moderation queue returned invalid report data.");
    return { reports: reports.data.slice(0,query.data.limit), ...query.data, hasMore: reports.data.length > query.data.limit };
  });

  app.post("/moderation/:reportId/:action", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const parsed = z.object({ reportId: z.string().uuid(), action: z.enum(["remove", "dismiss"]) }).safeParse(req.params);
    if (!parsed.success) throw new AppError(422, "Choose a valid report and moderation action.");
    const { reportId, action } = parsed.data;
    const { data, error } = await app.supabaseFactory(req.userToken).rpc("moderate_community_report", {
      p_report_id: reportId, p_action: action,
    });
    if (error?.code === "42501") throw new AppError(403, "moderator required");
    if (error?.code === "P0002") throw new AppError(404, "Report or reported content not found.");
    if (error?.code === "22023") throw new AppError(422, "This report cannot be resolved with that action.");
    if (error) throw new AppError(503, "Moderation outcome unclear. Refresh the queue before retrying.");
    const parsedReceipt = z.object({ report_id: z.literal(reportId), status: z.enum(["actioned", "dismissed"]),
      resolution_action: z.enum(["remove", "dismiss"]).nullable(), already_resolved: z.boolean(),
    }).refine((row) => row.already_resolved && row.resolution_action === null
      || (row.status === "actioned" ? row.resolution_action === "remove" : row.resolution_action === "dismiss")
        && (row.already_resolved || row.resolution_action === action)).safeParse(Array.isArray(data) ? data[0] : data);
    if (!parsedReceipt.success) throw new AppError(503, "Moderation outcome could not be verified. Refresh the queue.");
    return { reportId, status: parsedReceipt.data.status, action: parsedReceipt.data.resolution_action,
      alreadyResolved: parsedReceipt.data.already_resolved };
  });
}

async function getPost(svc: SupabaseClient, postId: string) {
  const { data } = await svc.from("community_posts").select("id,community_id,status").eq("id", postId).maybeSingle();
  if (!data) throw new AppError(404, "post not found");
  const post = data as { id: string; community_id: string; status: string };
  const community = await getCommunity(svc, post.community_id);
  return { ...post, community };
}

function requirePublishedPost(post: { status: string }) {
  if (post.status !== "published") throw new AppError(404, "post not found");
}

function discussionWriteError(error: { code?: string } | null) {
  if (error?.code === "42501") throw new AppError(403, "Discussion access changed. Refresh before trying again.");
  if (error?.code === "22023" || error?.code === "22P02") throw new AppError(422, "Choose a valid discussion and content.");
  if (error) throw new AppError(503, "The discussion update could not be confirmed. Refresh before trying again.");
}
