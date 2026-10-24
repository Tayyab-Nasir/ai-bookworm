/** Synthetic, in-memory RLS transport fixture. Never contacts a real database. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { BookNode } from "@bookworm/book-model";
import type { SupabaseFactory } from "../lib/supabase.js";
import type { CustomerDispatchScope } from "../lib/customer-ai-dispatch.js";

export const ids = { owner: "00000000-0000-4000-8000-000000000001", workspace: "00000000-0000-4000-8000-000000000002",
  book: "00000000-0000-4000-8000-000000000003", chapter: "00000000-0000-4000-8000-000000000004",
  version: "00000000-0000-4000-8000-000000000005", other: "00000000-0000-4000-8000-000000000006" };
export const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export function sourceFixture() {
  const actor = { userId: ids.owner, accessToken: "synthetic-user-session" }, expectedToken = actor.accessToken;
  const input = { bookId: ids.book, agentType: "writer" as CustomerDispatchScope["agentType"],
    chapters: [{ chapterId: ids.chapter, documentVersionId: ids.version, version: 3, nodeIds: undefined as string[] | undefined }],
    userInstruction: "Clarify the opening." as string | null, contextPolicy: { includeStyleGuide: false, includeBookBible: false,
      includeRelatedContext: false as const, semanticTopK: 5, maxTokens: 4096 } };
  const nodes: BookNode[] = [{ id: "p1", type: "paragraph", text: "雨 🌧 café\nRain fell.", attributes: { privateNote: "not-for-model" } }];
  const data: Record<string, Record<string, any>[]> = {
    books: [{ id: ids.book, workspace_id: ids.workspace, title: "The Rain", author_name: "Author", language: "en", privateNote: "not-for-model" }],
    workspace_members: [{ workspace_id: ids.workspace, user_id: ids.owner, role: "writer", status: "active" }],
    chapters: [{ id: ids.chapter, book_id: ids.book, title: "Rain", order_index: 0, current_document_version_id: ids.version }],
    document_versions: [{ id: ids.version, chapter_id: ids.chapter, version_number: 3, content_json: { nodes } }],
    style_guides: [{ book_id: ids.book, rules_json: { contractions: false }, tone: "calm", spelling_variant: "en-US" }],
    book_bible_items: [{ id: ids.other, book_id: ids.book, type: "place", name: "Town", description: "A rainy town.",
      attributes_json: { weather: "rain", imageAssetIds: [ids.other] }, source_refs_json: [
        { chapterId: ids.chapter, documentVersionId: ids.version, nodeId: "p1", textHash: sha(nodes[0].text!) }] }],
  };
  const reads: { table: string; fields: string; filters: [string, unknown][]; limit?: number }[] = [];
  let authCalls = 0, factories = 0;
  const controls = { authId: ids.owner as string | null, errorTable: "", before: (_table: string, _count: number) => {},
    onAuth: (_count: number) => {} };
  const factory: SupabaseFactory = (token, fetcher) => {
    factories++; assert.equal(token, expectedToken); assert.equal(typeof fetcher, "function");
    return { auth: { async getUser(jwt: string) { authCalls++; controls.onAuth(authCalls); assert.equal(jwt, expectedToken);
      return { data: { user: controls.authId ? { id: controls.authId } : null }, error: null }; } },
      from(table: string) {
        assert(Object.hasOwn(data, table), "Unexpected database access: " + table);
        const query = { table, fields: "", filters: [] as [string, unknown][], limit: undefined as number | undefined };
        const result = (single: boolean) => {
          reads.push(structuredClone(query)); controls.before(table, reads.filter(q => q.table === table).length);
          if (controls.errorTable === table) return { error: { message: "private-database-detail" }, data: null };
          let rows = data[table].filter(row => query.filters.every(([key, value]) => row[key] === value));
          if (query.limit !== undefined) rows = rows.slice(0, query.limit);
          const projected = rows.map(row => Object.fromEntries(query.fields.split(",").map(key => [key, structuredClone(row[key])])));
          return { error: null, data: single ? projected[0] ?? null : projected };
        };
        const builder = { select(fields: string) { query.fields = fields; return builder; },
          eq(key: string, value: unknown) { query.filters.push([key, value]); return builder; },
          order(_field: string) { return builder; }, limit(count: number) { query.limit = count; return builder; },
          async maybeSingle() { return result(true); }, then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
            return Promise.resolve().then(() => result(false)).then(resolve, reject);
          } };
        return builder;
      } } as unknown as ReturnType<SupabaseFactory>;
  };
  return { actor, input, data, nodes, factory, controls, reads, stats: () => ({ authCalls, factories }) };
}
