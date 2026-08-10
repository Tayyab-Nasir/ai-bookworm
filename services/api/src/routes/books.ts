import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceMember, requireWorkspaceEditor } from "../lib/authorize.js";

const createSchema = z.object({
  workspaceId: z.string().uuid(),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  authorName: z.string().min(1),
  language: z.string().default("en"),
  genre: z.string().optional(),
});

export function bookRoutes(app: FastifyInstance) {
  app.get("/books", async (req) => {
    const { workspaceId } = req.query as { workspaceId?: string };
    if (!workspaceId) throw new AppError(400, "workspaceId query param required");
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(sb, workspaceId, req.userId);
    const { data, error } = await sb.from("books").select("*").eq("workspace_id", workspaceId);
    if (error) throw new AppError(500, error.message);
    return { books: data };
  });

  app.post("/books", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid request", { issues: parsed.error.issues });
    const b = parsed.data;
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(sb, b.workspaceId, req.userId);
    const { data, error } = await sb.from("books").insert({
      workspace_id: b.workspaceId,
      title: b.title,
      subtitle: b.subtitle ?? null,
      author_name: b.authorName,
      language: b.language,
      genre: b.genre ?? null,
      created_by: req.userId,
    }).select().single();
    if (error) throw new AppError(422, error.message);
    return reply.status(201).send(data);
  });

  app.get("/books/:bookId/chapters", async (req) => {
    const { bookId } = req.params as { bookId: string };
    const sb = app.supabaseFactory(req.userToken);
    const { data: book } = await sb.from("books").select("workspace_id").eq("id", bookId).maybeSingle();
    if (!book) throw new AppError(404, "book not found");
    await requireWorkspaceMember(sb, book.workspace_id, req.userId);
    const { data, error } = await sb.from("chapters").select("*").eq("book_id", bookId).order("order_index");
    if (error) throw new AppError(500, error.message);
    return { chapters: data };
  });
}
