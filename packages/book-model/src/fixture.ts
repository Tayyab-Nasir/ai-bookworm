import type { BookModel } from "./schema.js";

export const CH1 = "11111111-1111-4111-8111-111111111111";
export const CH2 = "22222222-2222-4222-8222-222222222222";
export const ASSET1 = "33333333-3333-4333-8333-333333333333";

export function sampleBook(): BookModel {
  return {
    schemaVersion: "1.0",
    bookId: "00000000-0000-4000-8000-000000000001",
    metadata: {
      title: "Test Book",
      author: "A. Writer",
      language: "en",
      keywords: ["test"],
      isbn13: null,
      edition: null,
    },
    styleGuide: { spellingVariant: "en-US", tone: "neutral", rules: ["no oxford comma"] },
    bookBible: {
      entities: [
        {
          id: "e1",
          type: "character",
          name: "Jane",
          description: "protagonist",
          attributes: { age: 30 },
          sourceRefs: [CH1],
          confidence: 0.9,
        },
      ],
    },
    chapters: [
      {
        id: CH1,
        order: 0,
        title: "One",
        nodes: [
          { id: "n1", type: "heading", level: 1, text: "Chapter One" },
          { id: "n2", type: "paragraph", text: "Hello world" },
          { id: "n3", type: "paragraph", text: "Second para" },
        ],
      },
      {
        id: CH2,
        order: 1,
        title: "Two",
        nodes: [
          { id: "n4", type: "quote", text: "A quote" },
          { id: "n5", type: "image", assetId: ASSET1, attributes: { width: 100 } },
        ],
      },
    ],
    assets: [{ id: ASSET1, role: "illustration", caption: "Fig 1", altText: "a figure" }],
  };
}
