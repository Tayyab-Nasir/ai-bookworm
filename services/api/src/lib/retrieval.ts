import { z } from "zod";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "./supabase.js";

export const searchSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  limit: z.number().int().min(1).max(20).default(8),
  chapterIds: z.array(z.string().uuid()).max(50).optional(),
  includeBible: z.boolean().default(true),
}).strict();

export async function searchBookContext(sb: SupabaseClient, bookId: string, input: z.infer<typeof searchSchema>) {
  const { data, error } = await sb.rpc("search_book_context", {
    p_book_id: bookId, p_query: input.query, p_limit: input.limit,
    p_chapter_ids: input.chapterIds ?? null, p_include_bible: input.includeBible,
  });
  if (error?.code === "P0002") throw new AppError(404, "Book not found.");
  if (error?.code === "42883" || error?.code === "PGRST202") throw new AppError(503, "Book search requires the retrieval migration.");
  if (error) throw new AppError(500, "Could not search this book.");
  return data ?? [];
}

// Keyword retrieval is explicit, not marketed as semantic/graph search. Keep
// exact names and terms; OR broadens author instructions into ranked evidence.
export function retrievalQuery(text: string) {
  const stop = new Set("a an and are as at be but by for from has have he her his how i in is it its me my of on or our she that the their them they this to was we were what when where which who will with would you your".split(" "));
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((word) => !stop.has(word)))]
    .slice(0, 24).map((word) => `"${word}"`).join(" OR ").slice(0, 1000);
}
