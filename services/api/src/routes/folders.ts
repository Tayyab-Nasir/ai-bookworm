import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceEditor, requireWorkspaceMember } from "../lib/authorize.js";
import { logActivity } from "../lib/activity.js";

// PRD section 13 book-project template.
export const FOLDER_TEMPLATE: (string | [string, string[]])[] = [
  "00_Admin",
  ["01_Manuscript", ["Original", "Working"]],
  "02_Research",
  ["03_Illustrations", ["Drafts", "Approved"]],
  ["04_Cover", ["Concepts", "Final"]],
  "05_Design",
  "06_Metadata",
  ["07_Publishing", ["KDP", "Apple Books", "Lulu", "Other"]],
  "08_Archive",
];

const createSchema = z.object({
  name: z.string().min(1).max(128),
  parentFolderId: z.string().uuid().nullish(),
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    parentFolderId: z.string().uuid().nullable().optional(),
  })
  .refine((o) => o.name !== undefined || o.parentFolderId !== undefined, { message: "nothing to update" });

export function folderRoutes(app: FastifyInstance) {
  // Flat list; the client builds the tree from parent_folder_id.
  app.get("/workspaces/:id/folders", async (req) => {
    const { id } = req.params as { id: string };
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(sb, id, req.userId);
    const { data, error } = await sb.from("folders").select("*").eq("workspace_id", id);
    if (error) throw new AppError(500, error.message);
    return { folders: data };
  });

  app.post("/workspaces/:id/folders", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid folder", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(sb, id, req.userId);
    const { data, error } = await sb
      .from("folders")
      .insert({ workspace_id: id, name: parsed.data.name, parent_folder_id: parsed.data.parentFolderId ?? null, created_by: req.userId })
      .select()
      .single();
    if (error) throw new AppError(422, error.message);
    await logActivity(sb, { workspaceId: id, actorId: req.userId, eventType: "folder_created", entityType: "folder", entityId: data.id, payload: { name: data.name } });
    return reply.status(201).send(data);
  });

  // Seed the 00_Admin..08_Archive template; skips names that already exist at
  // the same level so it is safe to re-run.
  app.post("/workspaces/:id/folders/template", async (req) => {
    const { id } = req.params as { id: string };
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(sb, id, req.userId);

    const { data: existing, error: listErr } = await sb.from("folders").select("id,name,parent_folder_id").eq("workspace_id", id);
    if (listErr) throw new AppError(500, listErr.message);
    const byParent = new Map<string | null, Map<string, string>>();
    for (const f of existing ?? []) {
      const m = byParent.get(f.parent_folder_id) ?? new Map<string, string>();
      m.set(f.name, f.id);
      byParent.set(f.parent_folder_id, m);
    }

    const created: unknown[] = [];
    const seed = async (name: string, parentId: string | null): Promise<string> => {
      const hit = byParent.get(parentId)?.get(name);
      if (hit) return hit;
      const { data, error } = await sb
        .from("folders")
        .insert({ workspace_id: id, name, parent_folder_id: parentId, folder_type: "template", created_by: req.userId })
        .select()
        .single();
      if (error) throw new AppError(422, error.message);
      byParent.get(parentId)?.set(name, data.id) ?? byParent.set(parentId, new Map([[name, data.id]]));
      created.push(data);
      return data.id;
    };

    for (const entry of FOLDER_TEMPLATE) {
      const [name, children] = Array.isArray(entry) ? entry : [entry, []];
      const parentId = await seed(name, null);
      for (const child of children as string[]) await seed(child, parentId);
    }
    await logActivity(sb, { workspaceId: id, actorId: req.userId, eventType: "folders_template_seeded", payload: { created: created.length } });
    return { created: created.length, folders: created };
  });

  // Move (parentFolderId) and/or rename (name). Cycles are prevented by the
  // parent chain walk — ponytail: O(depth) client-side walk, fine for trees
  // this shallow; use a recursive CTE RPC if trees get deep.
  app.patch("/folders/:id", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid folder update", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);

    const { data: folder } = await sb.from("folders").select("id,workspace_id,name,parent_folder_id").eq("id", id).maybeSingle();
    if (!folder) throw new AppError(404, "folder not found");
    await requireWorkspaceEditor(sb, folder.workspace_id, req.userId);

    if (parsed.data.parentFolderId !== undefined && parsed.data.parentFolderId !== folder.parent_folder_id) {
      let cursor: string | null = parsed.data.parentFolderId;
      while (cursor) {
        if (cursor === id) throw new AppError(422, "cannot move folder into its own descendant");
        const { data: parent } = await sb.from("folders").select("id,parent_folder_id,workspace_id").eq("id", cursor).maybeSingle();
        if (!parent || parent.workspace_id !== folder.workspace_id) throw new AppError(422, "target folder not in workspace");
        cursor = parent.parent_folder_id;
      }
    }

    const update: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name;
    if (parsed.data.parentFolderId !== undefined) update.parent_folder_id = parsed.data.parentFolderId;
    const { data, error } = await sb.from("folders").update(update).eq("id", id).select().single();
    if (error) throw new AppError(422, error.message);
    await logActivity(sb, {
      workspaceId: folder.workspace_id,
      actorId: req.userId,
      eventType: parsed.data.parentFolderId !== undefined ? "folder_moved" : "folder_renamed",
      entityType: "folder",
      entityId: id,
      payload: { from: { name: folder.name, parent_folder_id: folder.parent_folder_id }, to: update },
    });
    return data;
  });
}
