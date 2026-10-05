import assert from "node:assert/strict";
import { test } from "node:test";

test("fixed EPUB page controls survive saving and switching flow", () => {
  const edition = { type: "ebook", language: "en", edition_metadata_json: { kind: "ebook", flow: "fixed" } } as unknown as Edition;
  const original = formFromEdition(edition);
  assert.equal(original.bodyFont, "BookwormVera");
  const form = { ...original, trimSize: "7x10" as const, top: 1, bottom: 0.5, inner: 0.8, outer: 0.6,
    bodyFont: "Courier" as const, bodySize: 15, headingFont: "Times-Bold" as const, headingSize: 24,
    leading: 21, paragraphSpacing: 9, firstLineIndent: 0.4, textAlign: "left" as const };
  const saved = toConfig(form);
  assert.equal(saved.kind, "ebook");
  if (saved.kind !== "ebook") throw new Error("wrong format");
  assert.equal(saved.fixed_layout?.trim_size, "7x10");
  assert.deepEqual(saved.fixed_layout?.margins, { top: 1, bottom: 0.5, inner: 0.8, outer: 0.6 });
  assert.deepEqual(formFromEdition({ ...edition, edition_metadata_json: saved }), form);
  const reflowable = toConfig({ ...form, flow: "reflowable" }, saved);
  assert.deepEqual(toConfig({ ...formFromEdition({ ...edition, edition_metadata_json: reflowable }), flow: "fixed" }, reflowable), saved);
});
import { applyLayoutPreset, resolveEditionTextDirection, formFromEdition, toConfig } from "../lib/publishing-edition-form";
import type { Edition } from "@bookworm/types";

test("front matter survives save and reload for both book formats", () => {
  for (const kind of ["ebook", "print"] as const) {
    const edition = { type: kind, language: "en", edition_metadata_json: { kind } } as unknown as Edition;
    const form = { ...formFromEdition(edition), copyrightNotice: "Copyright Ada\nPermission required.", publisher: "Finch & Fox", ebookTitlePage: true, printContents: true };
    const saved = toConfig(form);
    if (saved.kind === "audiobook") throw new Error("wrong format");
    assert.deepEqual(saved.front_matter, { copyright_notice: form.copyrightNotice, publisher: form.publisher });
    const restored = formFromEdition({ ...edition, edition_metadata_json: saved });
    assert.equal(restored.copyrightNotice, form.copyrightNotice);
    assert.equal(restored.publisher, form.publisher);
    if (kind === "ebook") assert.equal(restored.ebookTitlePage, true);
    if (kind === "print") assert.equal(restored.printContents, true);
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

test("layout presets set print typography and preserve cover, QR, bleed, and front matter", () => {
  const edition = { type: "print", language: "en", edition_metadata_json: { kind: "print" } } as unknown as Edition;
  const source = {
    ...formFromEdition(edition), coverAssetId: "cover-asset", titleOnCover: false,
    qrEnabled: true, qrUrl: "https://example.test/bonus", qrLabel: "Bonus chapter",
    bleed: 0.125, bleedEdges: "outer" as const, wrapEnabled: true, backText: "Back cover copy",
    copyrightNotice: "Copyright 2026", publisher: "Harbor Press",
  };

  const largePrint = applyLayoutPreset(source, "large-print");

  assert.equal(largePrint.trimSize, "6x9");
  assert.equal(largePrint.bodySize, 16);
  assert.equal(largePrint.headingSize, 20);
  assert.equal(largePrint.leading, 20);
  assert.equal(largePrint.firstLineIndent, 0);
  assert.equal(largePrint.textAlign, "left");
  assert.equal(largePrint.coverAssetId, source.coverAssetId);
  assert.equal(largePrint.titleOnCover, source.titleOnCover);
  assert.equal(largePrint.qrUrl, source.qrUrl);
  assert.equal(largePrint.qrLabel, source.qrLabel);
  assert.equal(largePrint.bleed, source.bleed);
  assert.equal(largePrint.bleedEdges, source.bleedEdges);
  assert.equal(largePrint.wrapEnabled, source.wrapEnabled);
  assert.equal(largePrint.backText, source.backText);
  assert.equal(largePrint.copyrightNotice, source.copyrightNotice);
  assert.equal(largePrint.publisher, source.publisher);
});

test("trade and poetry layout presets have different composition and survive edition save", () => {
  const edition = { type: "print", language: "en", edition_metadata_json: { kind: "print" } } as unknown as Edition;
  const source = formFromEdition(edition);
  const trade = applyLayoutPreset(source, "trade-paperback");
  const poetry = applyLayoutPreset(source, "poetry");

  assert.equal(trade.bodySize, 11);
  assert.equal(trade.textAlign, "justify");
  assert.equal(trade.firstLineIndent, 0.25);
  assert.equal(poetry.bodySize, 12);
  assert.equal(poetry.leading, 18);
  assert.equal(poetry.paragraphSpacing, 12);
  assert.equal(poetry.firstLineIndent, 0);
  assert.equal(poetry.textAlign, "left");
  assert.notDeepEqual(
    [trade.bodySize, trade.leading, trade.paragraphSpacing, trade.firstLineIndent, trade.textAlign],
    [poetry.bodySize, poetry.leading, poetry.paragraphSpacing, poetry.firstLineIndent, poetry.textAlign],
  );
  const saved = toConfig({ ...poetry, kind: "print" });
  assert.equal(saved.kind, "print");
  if (saved.kind !== "print") throw new Error("wrong edition");
  assert.equal(saved.typography?.body_size_pt, 12);
  assert.equal(saved.typography?.leading, 18);
  assert.equal(saved.typography?.paragraph_spacing_pt, 12);
});
