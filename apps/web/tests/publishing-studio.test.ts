import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEditionTextDirection, formFromEdition, toConfig } from "../components/PublishingStudio";
import type { Edition } from "@bookworm/types";

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
