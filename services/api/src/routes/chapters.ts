import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceEditor } from "../lib/authorize.js";

// DocumentOperation per spec section 9; full op semantics land in Step 4 (book-model).
const operationSchema = z.object({
  operationId: z.string().min(1),
  type: z.string().min(1),
  target: z.record(z.string(), z.unknown()),
  payload: z.record(z.string(), z.unknown()),
  source: z.enum(["human", "ai"]).default("human"),
  sourceRef: z.string().optional(),
  expectedVersion: z.number().int().nonnegative(),
});

export function chapterRoutes(app: FastifyInstance) {
  app.post("/chapters/:chapterId/operations", async (req) => {
    const { chapterId } = req.params as { chapterId: string };
    const parsed = operationSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid operation", { issues: parsed.error.issues });
    const op = parsed.data;
    const sb = app.supabaseFactory(req.userToken);

    const { data: chapter } = await sb.from("chapters").select("book_id").eq("id", chapterId).maybeSingle();
    if (!chapter) throw new AppError(404, "chapter not found");
    const { data: book } = await sb.from("books").select("workspace_id").eq("id", chapter.book_id).single();
    if (!book) throw new AppError(404, "book not found");
    await requireWorkspaceEditor(sb, book.workspace_id, req.userId);

    const { data: current } = await sb.from("document_versions")
      .select("version_number, content_json, plain_text, word_count")
      .eq("chapter_id", chapterId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const currentVersion = current?.version_number ?? 0;
    if (op.expectedVersion !== currentVersion) {
      throw new AppError(409, "stale expectedVersion", { currentVersion });
    }

    // ponytail: op application is a passthrough until Step 4's book-model engine
    // owns node semantics; here we store the op so versions are never lost.
    const newVersion = currentVersion + 1;
    const { error } = await sb.from("document_versions").insert({
      chapter_id: chapterId,
      version_number: newVersion,
      content_json: current?.content_json ?? { type: "doc", content: [] },
      plain_text: current?.plain_text ?? "",
      word_count: current?.word_count ?? 0,
      created_by: req.userId,
    });
    if (error) {
      // unique(chapter_id, version_number) race => someone else committed first
      if (error.code === "23505") throw new AppError(409, "concurrent update", { currentVersion: newVersion });
      throw new AppError(500, error.message);
    }
    return { version: newVersion };
  });
}
