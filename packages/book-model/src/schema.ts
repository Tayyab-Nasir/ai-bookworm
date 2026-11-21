import { z } from "zod";

export const Isbn13Schema = z.string().max(32).transform((value) => value.replace(/[ -]/gu, "")).refine((value) => {
  return /^(978[0-9]|979[1-9])[0-9]{9}$/u.test(value)
    && [...value].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0) % 10 === 0;
}, "Enter a valid ISBN-13 assigned to this print edition.");

export const NODE_TYPES = [
  "paragraph", "heading", "quote", "list", "listItem", "image",
  "caption", "pageBreak", "table", "footnote", "separator",
] as const;

export const BookNodeSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(NODE_TYPES),
    text: z.string().optional(),
    level: z.number().int().min(1).max(6).optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    assetId: z.guid().nullable().optional(),
    assetVersionNumber: z.number().int().positive().optional(),
    altText: z.string().max(1000).optional(),
    caption: z.string().max(2000).optional(),
    rows: z.array(z.array(z.string().max(100000)).max(100)).max(2000).optional(),
  })
  .passthrough();
export type BookNode = z.infer<typeof BookNodeSchema>;

export const ChapterSchema = z.object({
  id: z.guid(),
  order: z.number().int().min(0),
  title: z.string(),
  nodes: z.array(BookNodeSchema),
});
export type Chapter = z.infer<typeof ChapterSchema>;

export const BookMetadataSchema = z
  .object({
    title: z.string().min(1),
    subtitle: z.string().optional(),
    author: z.string().min(1),
    language: z.string(),
    description: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    categories: z.array(z.string()).optional(),
    isbn13: z.string().nullable().optional(),
    edition: z.string().nullable().optional(),
    publicationDate: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u).refine((value) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return Number(value.slice(0, 4)) >= 1 && !Number.isNaN(date.getTime())
        && date.toISOString().slice(0, 10) === value;
    }, "Enter a valid YYYY-MM-DD publication date.").nullable().optional(),
  })
  .passthrough();
export type BookMetadata = z.infer<typeof BookMetadataSchema>;

export const StyleGuideSchema = z.object({
  spellingVariant: z.string().optional(),
  tone: z.string().optional(),
  rules: z.array(z.string()).optional(),
});
export type StyleGuide = z.infer<typeof StyleGuideSchema>;

export const BookBibleEntitySchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    sourceRefs: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .passthrough();
export type BookBibleEntity = z.infer<typeof BookBibleEntitySchema>;

export const BookBibleSchema = z.object({
  entities: z.array(BookBibleEntitySchema),
});
export type BookBible = z.infer<typeof BookBibleSchema>;

export const BookAssetSchema = z.object({
  id: z.guid(),
  role: z.string(),
  caption: z.string().optional(),
  altText: z.string().optional(),
});
export type BookAsset = z.infer<typeof BookAssetSchema>;

export const BookModelSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    bookId: z.guid(),
    metadata: BookMetadataSchema,
    styleGuide: StyleGuideSchema,
    bookBible: BookBibleSchema,
    chapters: z.array(ChapterSchema),
    assets: z.array(BookAssetSchema),
  })
  .strict();
export type BookModel = z.infer<typeof BookModelSchema>;
