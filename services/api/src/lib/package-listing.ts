import { BookMetadataSchema } from "@bookworm/book-model";
import { unzipSync } from "fflate";
import { z } from "zod";

const maxBytes = 128 * 1024;
const packagedListing = z.object({
  schemaVersion: z.literal("1.0"),
  metadata: BookMetadataSchema.pick({
    title: true, subtitle: true, author: true, language: true, description: true,
    isbn13: true, edition: true, publicationDate: true, keywords: true, categories: true,
  }).extend({ subtitle: z.string().nullish(), description: z.string().nullish() }).strict(),
}).strict();

/** Called only after the ZIP has matched the saved private package checksum. */
export function readPackageListing(archive: Uint8Array) {
  try {
    let files = 0;
    const entries = unzipSync(archive, { filter: file => {
      if (file.name !== "metadata.json") return false;
      files++;
      if (files > 1 || file.size > maxBytes || file.originalSize > maxBytes) throw new Error("Invalid metadata entry.");
      return true;
    } });
    const metadata = entries["metadata.json"];
    if (files !== 1 || !metadata || metadata.length > maxBytes) return null;
    const parsed = packagedListing.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata)));
    if (!parsed.success) return null;
    const { subtitle, description, ...fields } = parsed.data.metadata;
    return { ...fields, ...(subtitle == null ? {} : { subtitle }), ...(description == null ? {} : { description }) };
  } catch { return null; }
}
