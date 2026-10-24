/** Server-only canonical context. No credentials, paid calls, job creation or
 * browser registration. Only the authenticated user's RLS client reads source.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { bookNodesPlainText } from "@bookworm/book-model";
import { AppError } from "../errors.js";
import { parseNodes } from "./authoring.js";
import { boundedSupabaseFetch, type SupabaseFactory } from "./supabase.js";
import { customerDispatchScope } from "./customer-ai-dispatch.js";

const id = z.string().uuid().regex(/^[0-9a-f-]+$/u);
const scalar = (max: number, min = 0, trim = false) => (trim ? z.string().trim() : z.string()).min(min).max(max)
  .refine(text => Buffer.from(text).toString("utf8") === text);
const selection = z.object({ chapterId: id, documentVersionId: id, version: z.number().int().min(1).max(999999999),
  nodeIds: z.array(scalar(200, 1)).min(1).max(200).optional() }).strict();
export const customerSourceInput = z.object({ bookId: id, agentType: customerDispatchScope.shape.agentType,
  chapters: z.array(selection).min(1).max(100), userInstruction: scalar(4000, 1, true).nullable(),
  contextPolicy: z.object({ includeBookBible: z.boolean(), includeStyleGuide: z.boolean(),
    // Related passages need their own full-node provenance contract. Never
    // silently downgrade a request for retrieval to an empty context.
    includeRelatedContext: z.literal(false), semanticTopK: z.number().int().min(1).max(20),
    maxTokens: z.number().int().min(256).max(16000) }).strict(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.chapters.map(ch => ch.chapterId)).size !== value.chapters.length
    || value.chapters.some(ch => ch.nodeIds && new Set(ch.nodeIds).size !== ch.nodeIds.length)
    || (value.agentType === "writer" && !value.userInstruction)) ctx.addIssue({ code: "custom", message: "Invalid source selection." });
});
const bookRow = z.object({ id, workspace_id: id, title: scalar(500, 1), author_name: scalar(500).nullable(), language: scalar(40, 1) }).strict();
const chapterRow = z.object({ id, book_id: id, title: scalar(500), order_index: z.number().int().nonnegative(), current_document_version_id: id.nullable() }).strict();
const versionRow = z.object({ id, chapter_id: id, version_number: z.number().int().positive(), content_json: z.unknown() }).strict();
const sourceRef = z.object({ chapterId: id, documentVersionId: id, nodeId: scalar(200, 1), textHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
type Chapter = { id: string; documentVersionId: string; version: number; title: string; order: number;
  nodes: { id: string; type: string; text: string; textHash: string }[] };
const unavailable = () => new AppError(503, "Saved AI source could not be verified. No generation was started.");
const changed = () => new AppError(409, "Saved source or access changed. Refresh before preparing this request.");
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

export async function loadCustomerAiSource(factory: SupabaseFactory, actor: { userId: string; accessToken: string }, input: unknown, abort?: AbortSignal) {
  try {
    const parsed = customerSourceInput.safeParse(input);
    if (!parsed.success) throw new AppError(422, "Choose saved chapters, whole nodes and supported context options.");
    const { userId, accessToken } = actor;
    if (!id.safeParse(userId).success || typeof accessToken !== "string" || !accessToken.trim() || accessToken.length > 16384) {
      throw new AppError(401, "Sign in again before preparing AI source.");
    }
    const selected = parsed.data, signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(abort ? [abort] : [])]);
    signal.throwIfAborted();
    const sb = factory(accessToken, boundedSupabaseFetch(signal));
    const authenticate = async () => {
      const result = await sb.auth.getUser(accessToken);
      if (result.error || !result.data.user || result.data.user.id !== userId) throw new AppError(401, "Sign in again before preparing AI source.");
    };
    const readBook = async () => {
      const found = await sb.from("books").select("id,workspace_id,title,author_name,language").eq("id", selected.bookId).maybeSingle();
      if (found.error) throw unavailable();
      if (!found.data) throw new AppError(404, "Book not found.");
      const book = bookRow.parse(found.data);
      if (book.id !== selected.bookId) throw unavailable();
      const member = await sb.from("workspace_members").select("workspace_id,user_id,role,status")
        .eq("workspace_id", book.workspace_id).eq("user_id", userId).eq("status", "active").maybeSingle();
      if (member.error) throw unavailable();
      if (!member.data || member.data.workspace_id !== book.workspace_id || member.data.user_id !== userId
        || member.data.status !== "active" || !["owner", "admin", "editor", "writer"].includes(member.data.role)) {
        throw new AppError(403, "Current writing access is required to prepare AI source.");
      }
      return book;
    };
    const readChapter = async (pointer: z.infer<typeof selection>) => {
      const found = await sb.from("chapters").select("id,book_id,title,order_index,current_document_version_id")
        .eq("id", pointer.chapterId).eq("book_id", selected.bookId).maybeSingle();
      if (found.error) throw unavailable();
      if (!found.data) throw changed();
      const chapter = chapterRow.parse(found.data);
      if (chapter.id !== pointer.chapterId || chapter.book_id !== selected.bookId || chapter.current_document_version_id !== pointer.documentVersionId) throw changed();
      return chapter;
    };
    await authenticate(); const book = await readBook();
    const chapters: Record<string, Chapter> = {}, savedChapters = new Map<string, z.infer<typeof chapterRow>>();
    const refs: z.infer<typeof sourceRef>[] = []; let totalNodes = 0;
    const editing = ["writer", "proofreader", "copyeditor", "consistency"].includes(selected.agentType);
    for (const pointer of selected.chapters) {
      signal.throwIfAborted();
      const chapter = await readChapter(pointer); savedChapters.set(pointer.chapterId, chapter);
      const result = await sb.from("document_versions").select("id,chapter_id,version_number,content_json")
        .eq("id", pointer.documentVersionId).eq("chapter_id", pointer.chapterId).maybeSingle();
      if (result.error) throw unavailable();
      if (!result.data) throw changed();
      const version = versionRow.parse(result.data);
      if (version.id !== pointer.documentVersionId || version.chapter_id !== pointer.chapterId || version.version_number !== pointer.version) throw changed();
      const wanted = pointer.nodeIds ? new Set(pointer.nodeIds) : null;
      const nodes = parseNodes(version.content_json).flatMap(node => {
        if (wanted && !wanted.has(node.id)) return [];
        const text = bookNodesPlainText([node]);
        // Only the original text field can be an edit target. Metadata/Bible
        // may cite canonical table cells or image captions without editing them.
        const eligible = editing ? typeof node.text === "string" && node.text === text : text.length > 0;
        if (!eligible) return [];
        if (!scalar(200, 1).safeParse(node.id).success || !scalar(400000).safeParse(text).success) throw unavailable();
        const textHash = createHash("sha256").update(text, "utf8").digest("hex");
        refs.push({ chapterId: chapter.id, documentVersionId: version.id, nodeId: node.id, textHash });
        return [{ id: node.id, type: node.type, text, textHash }];
      });
      if (!nodes.length || (wanted && nodes.length !== wanted.size)) throw new AppError(422, "Select supported whole manuscript nodes for this AI task.");
      totalNodes += nodes.length;
      if (totalNodes > 200) throw new AppError(422, "Select at most 200 whole nodes per AI request.");
      chapters[chapter.id] = { id: chapter.id, documentVersionId: version.id, version: version.version_number,
        title: chapter.title, order: chapter.order_index, nodes };
    }
    let styleGuide: Record<string, unknown> = {}, bookBible: Record<string, unknown>[] = [];
    if (selected.contextPolicy.includeStyleGuide) {
      const row = await sb.from("style_guides").select("book_id,rules_json,tone,spelling_variant").eq("book_id", book.id).maybeSingle();
      if (row.error) throw unavailable();
      if (row.data) {
        const style = z.object({ book_id: id, rules_json: z.record(z.string(), z.unknown()), tone: scalar(500).nullable(), spelling_variant: scalar(100).nullable() }).strict().parse(row.data);
        if (style.book_id !== book.id) throw unavailable();
        styleGuide = { rules: style.rules_json, tone: style.tone, spellingVariant: style.spelling_variant };
      }
    }
    if (selected.contextPolicy.includeBookBible) {
      const rows = await sb.from("book_bible_items").select("id,book_id,type,name,description,attributes_json,source_refs_json")
        .eq("book_id", book.id).order("created_at").order("id").limit(101);
      if (rows.error || !Array.isArray(rows.data)) throw unavailable();
      if (rows.data.length > 100) throw new AppError(422, "The Book Bible is too large for this request. Deselect it or narrow the saved context.");
      const allowedRefs = new Set(refs.map(ref => JSON.stringify(ref)));
      bookBible = rows.data.map(raw => {
        const entry = z.object({ id, book_id: id, type: scalar(100), name: scalar(160), description: scalar(12000).nullable(),
          attributes_json: z.record(z.string(), z.unknown()), source_refs_json: z.array(z.unknown()) }).strict().parse(raw);
        if (entry.book_id !== book.id) throw unavailable();
        const { imageAssetIds: _images, ...attributes } = entry.attributes_json;
        const sourceRefs = entry.source_refs_json.flatMap(rawRef => {
          const ref = sourceRef.safeParse(rawRef); return ref.success && allowedRefs.has(JSON.stringify(ref.data)) ? [ref.data] : [];
        });
        return { id: entry.id, type: entry.type, name: entry.name, description: entry.description, attributes, sourceRefs };
      });
    }
    const request = { input: { chapterIds: selected.chapters.map(ch => ch.chapterId), chapters,
      book: { title: book.title, author: book.author_name, language: book.language }, styleGuide, bookBible,
      relatedContext: [], userInstruction: selected.userInstruction }, contextPolicy: selected.contextPolicy };
    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized, "utf8") > 400000) throw new AppError(422, "Selected AI context is too large. Choose fewer whole nodes.");
    // Do not substitute newest-by-number for the author's explicit current pointer.
    for (const pointer of selected.chapters) if (!isDeepStrictEqual(await readChapter(pointer), savedChapters.get(pointer.chapterId))) throw changed();
    if (!isDeepStrictEqual(await readBook(), book)) throw changed();
    await authenticate(); signal.throwIfAborted();
    return freeze({ ownerId: userId, workspaceId: book.workspace_id, bookId: book.id, agentType: selected.agentType,
      request: JSON.parse(serialized) as typeof request,
      sourceVersions: selected.chapters.map(({ chapterId, documentVersionId, version }) => ({ chapterId, documentVersionId, version })) });
  } catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
}
