import assert from "node:assert/strict";
import { test } from "node:test";
import type { Edition } from "@bookworm/types";

// Runtime-only server import avoids pulling Fastify types into web's tsconfig.
// Do not load a developer's .env.local while evaluating the server schema.
Object.assign(process.env, { NODE_ENV: "production" });
const serverModulePath = "../../../services/api/src/routes/editions.ts";
const { editionConfigSchema } = await import(serverModulePath) as { editionConfigSchema: { parse(input: unknown): unknown } };
const { DEFAULT_FORM, formFromEdition, toConfig, matchesCreatedEditionConfig } = await import("../lib/publishing-edition-form");
type Stored = { kind: "audiobook"; speed: number } | { kind: "ebook" | "print"; cover: { text_color: string } };

test("edition create comparison matches actual server schema defaults and trims", () => {
  for (const kind of ["ebook", "print", "audiobook"] as const) {
    const sent = toConfig({ ...DEFAULT_FORM, kind });
    const stored = editionConfigSchema.parse(sent) as Stored;
    assert(matchesCreatedEditionConfig(sent, stored), `${kind} server defaults`);
    const changed = structuredClone(stored);
    if (changed.kind === "audiobook") changed.speed = 1.25;
    else changed.cover.text_color = "#123456";
    assert.equal(matchesCreatedEditionConfig(sent, changed), false, `${kind} changed setting`);
  }
  for (const kind of ["ebook", "print"] as const) {
    const sent = toConfig({ ...DEFAULT_FORM, kind, coverAssetId: "a0000000-0000-4000-8000-000000000001", qrEnabled: true,
      qrUrl: "  https://example.com/book  ", qrLabel: "  author  " });
    const stored = editionConfigSchema.parse(sent) as Stored;
    assert(matchesCreatedEditionConfig(sent, stored), `${kind} QR trimming`);
    assert.equal(matchesCreatedEditionConfig(sent, { ...stored, unexpected: true }), false);
  }
});

test("finished covers round-trip an exact source version without carrying composition controls into the edition", () => {
  const id = "a0000000-0000-4000-8000-000000000002";
  const sent = toConfig({ ...DEFAULT_FORM, kind: "print", wrapEnabled: true, wrapSource: "uploaded",
    wrapPdfAssetId: id, wrapPdfVersion: 4, qrEnabled: true, qrUrl: "https://example.com/book",
    wrapBarcode: "kdp", backText: "Previous cover text" });
  assert.equal(sent.kind, "print");
  if (sent.kind !== "print") throw new Error("Expected print edition settings");
  assert.equal(sent.cover?.asset_id, id);
  assert.equal(sent.cover?.qr_code?.enabled, false);
  assert.equal(sent.wrap_cover?.source_pdf_version, 4);
  assert.equal(sent.wrap_cover?.barcode, undefined);
  assert.equal(sent.wrap_cover?.back_text, "");
  const stored = editionConfigSchema.parse(sent);
  assert(matchesCreatedEditionConfig(sent, stored));
  const loaded = formFromEdition({ type: "print", language: "en", edition_metadata_json: stored } as Edition);
  assert.equal(loaded.coverAssetId, "");
  assert.equal(loaded.wrapPdfAssetId, id);
  assert.deepEqual(toConfig(loaded), sent);
});
