import { createHash } from "node:crypto";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "./supabase.js";
import { imageBookContext } from "./image-book-context.js";
import { retrievalQuery, searchBookContext } from "./retrieval.js";
import type { ImageQuoteRequest } from "./image-pricing.js";

export async function imageQuoteContext(user: SupabaseClient, input: {
  workspaceId: string; bookId?: string; kind: "illustration" | "cover"; prompt: string; referenceAssetIds: string[];
}) {
  let book: Record<string, unknown> | null = null;
  let bible: Record<string, unknown>[] = [];
  if (input.bookId) {
    const found = await user.from("books").select("id,workspace_id,title,subtitle,author_name,genre,language")
      .eq("id", input.bookId).eq("workspace_id", input.workspaceId).maybeSingle();
    if (found.error || !found.data) throw new AppError(404, "Book not found in this workspace.");
    book = found.data;
    const saved = await user.from("book_bible_items").select("id,type,name,description,attributes_json")
      .eq("book_id", input.bookId).order("id", { ascending: true }).limit(100);
    if (saved.error) throw new AppError(503, "Saved book context is unavailable.");
    bible = saved.data ?? [];
    const query = retrievalQuery(input.prompt);
    if (query) {
      const matches = await searchBookContext(user, input.bookId, { query, limit: 20, includeBible: true });
      const ids = [...new Set<string>(matches.filter((item: { source_type: string; bible_item_id: string | null }) => item.source_type === "bible" && item.bible_item_id)
        .map((item: { bible_item_id: string }) => item.bible_item_id))];
      if (ids.length) {
        const relevant = await user.from("book_bible_items").select("id,type,name,description,attributes_json")
          .eq("book_id", input.bookId).in("id", ids);
        if (relevant.error) throw new AppError(503, "Relevant book context is unavailable.");
        bible = [...ids.flatMap((id) => (relevant.data ?? []).filter((row) => row.id === id)),
          ...bible.filter((row) => !ids.includes(String(row.id)))];
      }
    }
  }
  const references: ImageQuoteRequest["references"] = [];
  for (const assetId of input.referenceAssetIds) {
    const result = await user.from("assets").select("id,storage_path,checksum,mime_type,size_bytes,deleted_at")
      .eq("id", assetId).eq("workspace_id", input.workspaceId).maybeSingle();
    const asset = result.data;
    if (result.error || !asset || asset.deleted_at) throw new AppError(404, "Reference image not found.");
    if (asset.mime_type !== "image/png" || !Number.isInteger(asset.size_bytes) || asset.size_bytes <= 0
      || asset.size_bytes > 5 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(String(asset.checksum))
      || !String(asset.storage_path).startsWith(`workspaces/${input.workspaceId}/assets/${assetId}/`)
      || String(asset.storage_path).includes("..")) throw new AppError(422, "Reference must be a confirmed PNG up to 5 MiB.");
    const version = await user.from("asset_versions").select("version_number,checksum,scan_status")
      .eq("asset_id", assetId).eq("storage_path", asset.storage_path).maybeSingle();
    if (version.error || !version.data || version.data.checksum !== asset.checksum
      || !Number.isInteger(version.data.version_number) || version.data.version_number < 1
      || !["clean", "trusted_generated"].includes(version.data.scan_status)) throw new AppError(409, "Reference is quarantined or changed.");
    const file = await user.storage.from("book-assets").download(asset.storage_path);
    if (file.error || !file.data) throw new AppError(503, "Reference could not be read.");
    if (file.data.size !== asset.size_bytes) throw new AppError(409, "Reference size changed.");
    const bytes = Buffer.from(await file.data.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== asset.checksum
      || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new AppError(409, "Reference integrity check failed.");
    references.push({ assetId, version: version.data.version_number, sha256: asset.checksum, mimeType: "image/png" });
  }
  const instruction = input.kind === "cover"
    ? "Create cover artwork only. Do not render any title, author name, lettering, logo, barcode, or QR code; Bookworm adds typography during layout."
    : "Create a book illustration without captions, lettering, logos, watermarks, barcodes, or QR codes.";
  return { prompt: `${instruction}\n${imageBookContext(book, bible)}\nAuthor direction: ${input.prompt}`, references };
}
