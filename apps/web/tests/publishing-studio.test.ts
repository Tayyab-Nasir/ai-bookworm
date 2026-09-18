import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEditionTextDirection, formFromEdition, toConfig } from "../components/PublishingStudio";
import type { Edition } from "@bookworm/types";

test("front matter survives save and reload for both book formats", () => {
  for (const kind of ["ebook", "print"] as const) {
    const edition = { type: kind, language: "en", edition_metadata_json: { kind } } as unknown as Edition;
    const form = { ...formFromEdition(edition), copyrightNotice: "Copyright Ada\nPermission required.", publisher: "Finch & Fox", ebookTitlePage: true };
    const saved = toConfig(form);
    if (saved.kind === "audiobook") throw new Error("wrong format");
    assert.deepEqual(saved.front_matter, { copyright_notice: form.copyrightNotice, publisher: form.publisher });
    const restored = formFromEdition({ ...edition, edition_metadata_json: saved });
    assert.equal(restored.copyrightNotice, form.copyrightNotice);
    assert.equal(restored.publisher, form.publisher);
    if (kind === "ebook") assert.equal(restored.ebookTitlePage, true);
    assert.deepEqual(toConfig(restored, saved), saved);
  }
});

test("interior bleed edges round-trip while legacy editions retain all-edge geometry", () => {
  const edition = { type: "print", language: "en", edition_metadata_json: { kind: "print", bleed_in: 0.125 } } as unknown as Edition;
  const original = formFromEdition(edition);
  assert.equal(original.bleedEdges, "all");
  const saved = toConfig({ ...original, bleedEdges: "outer" });
  assert.equal(saved.kind, "print");
  if (saved.kind !== "print") throw new Error("wrong edition");
  assert.equal(saved.bleed_edges, "outer");
  assert.equal(formFromEdition({ ...edition, edition_metadata_json: saved }).bleedEdges, "outer");
  assert.equal("bleed_edges" in toConfig({ ...original, kind: "ebook" }), false);
});

test("edition direction honors explicit choice before language inference", () => {
  assert.equal(resolveEditionTextDirection("ar", "ltr"), "ltr");
  assert.equal(resolveEditionTextDirection("en", "rtl"), "rtl");
});

test("edition direction recognizes RTL primary languages and script subtags", () => {
  assert.equal(resolveEditionTextDirection("ar", "auto"), "rtl");
  assert.equal(resolveEditionTextDirection("fa-IR", "auto"), "rtl");
  assert.equal(resolveEditionTextDirection("az-Arab", "auto"), "rtl");
  assert.equal(resolveEditionTextDirection("en", "auto"), "ltr");
});

test("editing an ebook cover preserves saved image policy and edition metadata", () => {
  const config = { kind: "ebook", image_policy: { max_width_px: 2400, max_bytes: 7000000, embed: false, allowed_formats: ["png", "webp"] }, metadata_overrides: { title: "Special edition", publisher: "Harbor Press" } };
  const edition = { type: "ebook", language: "en", edition_metadata_json: config } as unknown as Edition;
  const form = formFromEdition(edition);
  const saved = toConfig({ ...form, textColor: "#112233" }, config);
  assert.equal(saved.kind, "ebook");
  if (saved.kind !== "ebook") throw new Error("wrong edition");
  assert.deepEqual(saved.image_policy, config.image_policy);
  assert.deepEqual(saved.metadata_overrides, config.metadata_overrides);
  assert.equal(saved.cover?.text_color, "#112233");
  assert.deepEqual(toConfig(formFromEdition({ ...edition, edition_metadata_json: saved }), saved), saved);
});

test("print typography edits retain starting page and allow deliberate changes", () => {
  const edition = { type: "print", language: "en", edition_metadata_json: { kind: "print", page_numbering: { style: "roman", start_at: 17, position: "bottom-outer" } } } as unknown as Edition;
  const form = formFromEdition(edition);
  const saved = toConfig({ ...form, bodySize: 12 });
  assert.equal(saved.kind, "print");
  if (saved.kind !== "print") throw new Error("wrong edition");
  assert.deepEqual(saved.page_numbering, { style: "roman", start_at: 17, position: "bottom-outer" });
  const changed = toConfig({ ...form, startAt: 5 });
  assert.equal(changed.kind === "print" && changed.page_numbering?.start_at, 5);
});

test("audiobook voice settings round-trip without print or cover fields", () => {
  const edition = {
    type: "audiobook",
    language: "en",
    edition_metadata_json: { kind: "audiobook", schema_version: "1.0.0", voice: "cedar", speed: 0.95, instructions: "Warm and precise." },
  } as unknown as Edition;
  const saved = toConfig(formFromEdition(edition), edition.edition_metadata_json);
  assert.deepEqual(saved, { kind: "audiobook", schema_version: "1.0.0", voice: "cedar", speed: 0.95, instructions: "Warm and precise." });
});

test("embedded print font choices survive save and reload", () => {
  const config = { kind: "print", typography: { body_font: "BookwormVera", heading_font: "BookwormVera-Bold" } };
  const edition = { type: "print", language: "fr", edition_metadata_json: config } as unknown as Edition;
  const saved = toConfig(formFromEdition(edition));
  assert.equal(saved.kind, "print");
  if (saved.kind !== "print") throw new Error("wrong edition");
  assert.equal(saved.typography?.body_font, "BookwormVera");
  assert.equal(saved.typography?.heading_font, "BookwormVera-Bold");
  assert.deepEqual(toConfig(formFromEdition({ ...edition, edition_metadata_json: saved })), saved);
});

test("full paperback cover settings survive save and reload without leaking to EPUB", () => {
  const config = { kind: "print", wrap_cover: { enabled: true, profile: "custom", spine_width_in: 0.415,
    expected_page_count: 184, back_text: "Back cover copy", spine_text: "Title", background_color: "#102030", text_color: "#ffffff" } };
  const edition = { type: "print", language: "en", edition_metadata_json: config } as unknown as Edition;
  const form = formFromEdition(edition);
  const saved = toConfig(form);
  assert.equal(saved.kind, "print");
  if (saved.kind !== "print") throw new Error("wrong edition");
  assert.deepEqual(saved.wrap_cover, config.wrap_cover);
  assert.deepEqual(toConfig(formFromEdition({ ...edition, edition_metadata_json: saved })), saved);
  assert.equal("wrap_cover" in toConfig({ ...form, kind: "ebook" }), false);
});
