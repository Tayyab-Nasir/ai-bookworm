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
  entityId: z.string().min(1), // not .uuid(): entity ids come from the entity row
  reason: z.string().min(1).max(1000),
});

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
    const role = await memberRole(svc, post.community_id, req.userId);
    requireReadable(post.community, role, req.userId);
    const { data, error } = await svc.from("community_comments").select("*").eq("post_id", postId).order("created_at");
    if (error) throw new AppError(500, error.message);
    return { comments: data };
  });

  app.post("/posts/:postId/comments", async (req, reply) => {
    const { postId } = req.params as { postId: string };
    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid comment", { issues: parsed.error.issues });
    const svc = app.supabaseFactory();
    const post = await getPost(svc, postId);
    await requireMember(svc, post.community_id, req.userId);
    const { data, error } = await svc
      .from("community_comments")
      .insert({ post_id: postId, author_id: req.userId, body: parsed.data.body })
      .select()
      .single();
    if (error) throw new AppError(500, error.message);
    return reply.status(201).send(data);
  });

  // Toggle: react again with the same kind to unreact.
  app.post("/posts/:postId/reactions", async (req) => {
    const { postId } = req.params as { postId: string };
    const parsed = reactionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid reaction", { issues: parsed.error.issues });
    const svc = app.supabaseFactory();
    const post = await getPost(svc, postId);
    await requireMember(svc, post.community_id, req.userId);
    const { data: existing } = await svc
      .from("community_post_reactions")
      .select("kind")
      .eq("post_id", postId)
      .eq("user_id", req.userId)
      .eq("kind", parsed.data.kind)
      .maybeSingle();
    if (existing) {
      await svc.from("community_post_reactions").delete().eq("post_id", postId).eq("user_id", req.userId).eq("kind", parsed.data.kind);
      return { postId, kind: parsed.data.kind, active: false };
    }
    const { error } = await svc.from("community_post_reactions").insert({ post_id: postId, user_id: req.userId, kind: parsed.data.kind });
    if (error) throw new AppError(500, error.message);
    return { postId, kind: parsed.data.kind, active: true };
  });

  app.post("/reports", async (req, reply) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid report", { issues: parsed.error.issues });
    if (!allowReport(req.userId)) throw new AppError(429, "report rate limit exceeded");
    const svc = app.supabaseFactory();
    const { data, error } = await svc
      .from("reports")
      .insert({ reporter_id: req.userId, entity_type: parsed.data.entityType, entity_id: parsed.data.entityId, reason: parsed.data.reason, status: "open" })
      .select()
      .single();
    if (error) throw new AppError(500, error.message);
    return reply.status(201).send(data);
  });

  // Moderation queue: open reports for communities the user moderates.
  app.get("/moderation/queue", async (req) => {
    const svc = app.supabaseFactory();
    const { data: memberships } = await svc
      .from("community_members")
      .select("community_id")
      .eq("user_id", req.userId)
      .in("role", ["owner", "moderator"])
      .eq("status", "active");
    const communityIds = (memberships ?? []).map((m: { community_id: string }) => m.community_id);
    if (!communityIds.length) return { reports: [] };
    const { data: posts } = await svc.from("community_posts").select("id").in("community_id", communityIds);
    const postIds = (posts ?? []).map((p: { id: string }) => p.id);
    if (!postIds.length) return { reports: [] };
    const { data: reports, error } = await svc
      .from("reports")
      .select("*")
      .eq("entity_type", "post")
      .in("entity_id", postIds)
      .eq("status", "open")
      .order("created_at");
    if (error) throw new AppError(500, error.message);
    return { reports };
  });

  // action=remove -> post status removed, report actioned; action=dismiss.
  app.post("/moderation/:reportId/:action", async (req) => {
    const { reportId, action } = req.params as { reportId: string; action: string };
    if (action !== "remove" && action !== "dismiss") throw new AppError(422, "action must be remove|dismiss");
    const svc = app.supabaseFactory();
    const { data: report } = await svc.from("reports").select("*").eq("id", reportId).maybeSingle();
    if (!report) throw new AppError(404, "report not found");
    const r = report as { status: string; entity_type: string; entity_id: string };
    if (r.status !== "open") return { reportId, action, status: r.status, alreadyResolved: true };
    if (r.entity_type !== "post") throw new AppError(422, "only post reports are supported");
    const post = await getPost(svc, r.entity_id);
    await requireModerator(svc, post.community_id, req.userId);
    if (action === "remove") {
      const { error } = await svc.from("community_posts").update({ status: "removed" }).eq("id", r.entity_id);
      if (error) throw new AppError(500, error.message);
    }
    const { data, error } = await svc
      .from("reports")
      .update({ status: action === "remove" ? "actioned" : "dismissed" })
      .eq("id", reportId)
      .select()
      .single();
    if (error) throw new AppError(500, error.message);
    return data;
  });
}

async function getPost(svc: SupabaseClient, postId: string) {
  const { data } = await svc.from("community_posts").select("id,community_id").eq("id", postId).maybeSingle();
  if (!data) throw new AppError(404, "post not found");
  const post = data as { id: string; community_id: string };
  const community = await getCommunity(svc, post.community_id);
  return { ...post, community };
}
