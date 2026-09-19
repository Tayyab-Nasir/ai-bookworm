import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceEditor, requireWorkspaceMember } from "../lib/authorize.js";
import type { SupabaseClient } from "../lib/supabase.js";

const id = z.string().uuid();

const storySchema = z.object({
  workingTitle: z.string().trim().max(500),
  premise: z.string().trim().max(12_000),
  readerPromise: z.string().trim().max(4_000),
  genre: z.string().trim().max(240),
  tone: z.string().trim().max(240),
  pointOfView: z.string().trim().max(120),
  tense: z.string().trim().max(120),
  targetWordCount: z.number().int().min(100).max(2_000_000).nullable(),
  synopsis: z.string().trim().max(24_000),
  theme: z.string().trim().max(4_000),
  notes: z.string().trim().max(12_000),
}).strict();

const chapterPlanItemSchema = z.object({
  id,
  title: z.string().trim().min(1).max(500),
  purpose: z.string().trim().max(4_000),
  summary: z.string().trim().max(16_000),
  targetWords: z.number().int().min(10).max(200_000).nullable(),
}).strict();

const chapterPlanSchema = z.array(chapterPlanItemSchema).max(200).superRefine((items, context) => {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) {
      context.addIssue({ code: "custom", message: "Each chapter plan item needs a unique ID.", path: [index, "id"] });
    }
    seen.add(item.id);
  }
});

const saveSchema = z.object({
  expectedRevision: z.number().int().min(0),
  story: storySchema,
  chapterPlan: chapterPlanSchema,
}).strict();

const materializeSchema = z.object({
  expectedRevision: z.number().int().min(0),
  idempotencyKey: z.string().trim().min(8).max(160),
}).strict();

const storedBlueprintSchema = z.object({
  id,
  revision: z.number().int().min(1),
  details_json: storySchema,
  chapter_plan_json: chapterPlanSchema,
}).passthrough();

const materializationSchema = z.object({
  blueprint_chapter_id: id,
  chapter_id: id,
}).passthrough();

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(422, "Check the submitted story blueprint fields.", { issues: result.error.issues });
  return result.data;
}

async function scopedBook(app: FastifyInstance, req: FastifyRequest, edit = false) {
  const bookId = parse(id, (req.params as { bookId: string }).bookId);
  const sb = app.supabaseFactory(req.userToken);
  const { data: book, error } = await sb.from("books").select("workspace_id").eq("id", bookId).maybeSingle();
  if (error) throw new AppError(500, "Could not load the book.");
  if (!book) throw new AppError(404, "Book not found.");
  const role = await (edit ? requireWorkspaceEditor : requireWorkspaceMember)(sb, book.workspace_id, req.userId);
  return { sb, bookId, role };
}

function currentRevision(details: unknown) {
  if (typeof details !== "string" || !/^(?:0|[1-9]\d*)$/.test(details)) return undefined;
  const revision = Number(details);
  return Number.isSafeInteger(revision) ? revision : undefined;
}

function storyBlueprintRpcError(error: { code?: string; message?: string; details?: string | null }): never {
  if (error.code === "40001") {
    const revision = currentRevision(error.details);
    throw new AppError(409, "Story blueprint changed. Reload before saving.", revision === undefined ? undefined : { currentRevision: revision });
  }
  if (error.code === "42501") throw new AppError(403, "Editing access is required to change the story blueprint.");
  if (error.code === "P0002") throw new AppError(404, "Story blueprint or book not found.");
  if (error.code === "PGRST202" || error.code === "42883") {
    throw new AppError(503, "Story blueprint database migration is not installed. No changes were saved.");
  }
  if (error.code === "22023") throw new AppError(422, "Story blueprint input is invalid.");
  if (error.code === "23514") throw new AppError(422, "A materialized chapter plan item cannot be removed.");
  throw new AppError(500, "Could not save the story blueprint. No success was recorded.");
}

function firstRpcRow(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row) throw new AppError(500, "Story blueprint persistence returned no result.");
  return row;
}

function safeBlueprint(value: unknown, materializations: unknown[]) {
  const blueprint = storedBlueprintSchema.safeParse(value);
  const mappedMaterializations = z.array(materializationSchema).safeParse(materializations);
  if (!blueprint.success || !mappedMaterializations.success) {
    throw new AppError(500, "Saved story blueprint data is unavailable.");
  }
  const planIds = new Set(blueprint.data.chapter_plan_json.map((item) => item.id));
  const seen = new Set<string>();
  const safeMaterializations = mappedMaterializations.data.flatMap((item) => {
    if (!planIds.has(item.blueprint_chapter_id) || seen.has(item.blueprint_chapter_id)) return [];
    seen.add(item.blueprint_chapter_id);
    return [{ planItemId: item.blueprint_chapter_id, chapterId: item.chapter_id }];
  });
  return {
    revision: blueprint.data.revision,
    story: blueprint.data.details_json,
    chapterPlan: blueprint.data.chapter_plan_json,
    materializations: safeMaterializations,
  };
}

async function loadMaterializations(sb: SupabaseClient, blueprintId: string) {
  const { data, error } = await sb.from("story_blueprint_materializations")
    .select("blueprint_chapter_id,chapter_id").eq("blueprint_id", blueprintId).order("created_at");
  if (error) throw new AppError(500, "Could not load story blueprint materializations.");
  return data ?? [];
}

export function storyBlueprintRoutes(app: FastifyInstance) {
  app.get("/books/:bookId/story-blueprint", async (req, reply) => {
    const { sb, bookId, role } = await scopedBook(app, req);
    reply.header("cache-control", "private, no-store");
    const { data, error } = await sb.from("story_blueprints")
      .select("id,revision,details_json,chapter_plan_json").eq("book_id", bookId).maybeSingle();
    if (error) throw new AppError(500, "Could not load the story blueprint.");
    if (!data) return { blueprint: null, role };
    const materializations = await loadMaterializations(sb, data.id);
    return { blueprint: safeBlueprint(data, materializations), role };
  });

  app.put("/books/:bookId/story-blueprint", async (req, reply) => {
    const body = parse(saveSchema, req.body);
    const { sb, bookId, role } = await scopedBook(app, req, true);
    const { data, error } = await sb.rpc("save_story_blueprint", {
      p_book_id: bookId,
      p_expected_revision: body.expectedRevision,
      p_details: body.story,
      p_chapters: body.chapterPlan,
    });
    if (error) storyBlueprintRpcError(error);
    const row = firstRpcRow(data);
    const parsedRow = storedBlueprintSchema.safeParse(row);
    if (!parsedRow.success) throw new AppError(500, "Saved story blueprint data is unavailable.");
    const materializations = await loadMaterializations(sb, parsedRow.data.id);
    reply.header("cache-control", "private, no-store");
    return reply.status(body.expectedRevision === 0 ? 201 : 200).send({
      blueprint: safeBlueprint(parsedRow.data, materializations), role,
    });
  });

  app.post("/books/:bookId/story-blueprint/chapters/:planItemId/materialize", async (req, reply) => {
    const body = parse(materializeSchema, req.body);
    const planItemId = parse(id, (req.params as { planItemId: string }).planItemId);
    const { sb, bookId } = await scopedBook(app, req, true);
    const { data, error } = await sb.rpc("materialize_story_blueprint_chapter", {
      p_book_id: bookId,
      p_blueprint_chapter_id: planItemId,
      p_expected_revision: body.expectedRevision,
      p_request_key: body.idempotencyKey,
    });
    if (error) storyBlueprintRpcError(error);
    reply.header("cache-control", "private, no-store");
    return { chapter: firstRpcRow(data) };
  });
}
