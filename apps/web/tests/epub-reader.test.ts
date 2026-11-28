import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { EpubReaderResult, EpubResourceResult, SavedEpubSource } from "@bookworm/api-client";
import { assertReaderSource, buildReaderDocument, readerImageOccurrences, readerSourceKey, validateReaderHistory, validateReaderSection, verifyReaderResource, createReaderFence, validateReaderDownload, retainReaderImage, READER_IMAGE_BUDGET } from "../lib/epub-reader";

const source: SavedEpubSource = { bookId: "a0000000-0000-4000-8000-000000000001", editionId: "a0000000-0000-4000-8000-000000000002", jobId: "a0000000-0000-4000-8000-000000000003", assetId: "a0000000-0000-4000-8000-000000000004", version: 1, sha256: "a".repeat(64), sizeBytes: 2400 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const raster = { index: 0, mimeType: "image/png" as const, sha256: createHash("sha256").update(png).digest("hex"), sizeBytes: png.length, width: 1, height: 1 };
const resource: EpubResourceResult = { source, resource: { ...raster, base64: png.toString("base64") } };
function section(): EpubReaderResult {
  return { source, formatVersion: "epub-reader-1.0.0", layout: "reflowable", spine: [{ index: 0, title: "Arrival", layout: "reflowable" }], document: { index: 0, title: "Arrival", layout: "reflowable", direction: "rtl", html: '<div lang="ar" dir="rtl"><h1>Arrival &amp; departure</h1><p>Saved text.</p><img alt="Harbor &quot;at dawn&quot;" data-reader-resource="0"></div>', resources: [raster] }, warnings: [] };
}

test("reader binds every identity field, immutable version and bounded digest", () => {
  assertReaderSource(source, source);
  for (const key of ["bookId", "editionId", "jobId", "assetId", "version", "sha256", "sizeBytes"] as const) {
    const changed = { ...source, [key]: key === "version" ? 2 : key === "sizeBytes" ? 2401 : key === "sha256" ? "b".repeat(64) : "a0000000-0000-4000-8000-000000000009" };
    assert.throws(() => assertReaderSource(changed, source));
    assert.notEqual(readerSourceKey(changed as SavedEpubSource), readerSourceKey(source));
  }
  for (const changed of [{ ...source, sha256: "bad" }, { ...source, sizeBytes: 0 }, { ...source, sizeBytes: 150 * 1024 * 1024 + 1 }]) assert.throws(() => assertReaderSource(changed));
});

test("history is scoped, dated, unique and cannot silently cross books", () => {
  const render = { jobId: source.jobId, createdAt: "2026-10-10T00:00:00.000Z", source };
  assert.deepEqual(validateReaderHistory({ renders: [render] }, source.bookId, source.editionId), [render]);
  for (const value of [{ renders: [{ ...render, createdAt: "bad" }] }, { renders: [render, render] }, { renders: [{ ...render, source: { ...source, bookId: source.assetId } }] }, { renders: [{ ...render, jobId: source.assetId }] }]) assert.throws(() => validateReaderHistory(value, source.bookId, source.editionId));
});

test("section preserves exact supported text, resource descriptors and RTL", () => {
  assert.deepEqual(validateReaderSection(section(), source, 0), section());
  const html = buildReaderDocument(section(), new Map(), { font: "serif", size: 20, leading: 1.7 });
  assert.match(html, /dir="rtl"/);
  assert.match(html, /Arrival &amp; departure/);
  assert.match(html, /Illustration 1 is not loaded/);
  assert.match(html, /default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'/);
  assert.ok(!html.includes('<script'));
});

for (const markup of ['<script>alert(1)</script>', '<p onclick="alert(1)">x</p>', '<img src="https://evil.test">', '<p style="background:url(https://evil.test)">x</p>', '<svg><a href="javascript:alert(1)">x</a></svg>', '<a href="https://evil.test">x</a>', '<iframe srcdoc="x"></iframe>', '<meta http-equiv="refresh" content="0;url=https://evil.test">', '<p><span>x</p></span>', '<img data-reader-resource="9">', '<p id="x" id="y">x</p>', '<!-- unsafe alternate markup -->', '<p>unclosed']) test(`reader rejects unexpected active or ambiguous markup ${markup.slice(0, 32)}`, () => {
  const value = section(); value.document.html = markup;
  assert.throws(() => validateReaderSection(value, source, 0));
});

test("resource verifies full source, MIME, canonical base64, byte digest and PNG dimensions", () => {
  const url = verifyReaderResource(resource, source, raster);
  assert.equal(url, `data:image/png;base64,${png.toString("base64")}`);
  const value = section(); const html = buildReaderDocument(value, new Map([[0, url]]), { font: "sans", size: 18, leading: 1.5 });
  assert.ok(html.includes(url)); assert.ok(!html.includes('Illustration 1 is not loaded'));
  for (const changed of [
    { ...resource, source: { ...source, assetId: source.bookId } },
    { ...resource, resource: { ...resource.resource, mimeType: "image/svg+xml" } },
    { ...resource, resource: { ...resource.resource, base64: resource.resource.base64 + "\n" } },
    { ...resource, resource: { ...resource.resource, sha256: "b".repeat(64) } },
    { ...resource, resource: { ...resource.resource, width: 2 } },
    { ...resource, resource: { ...resource.resource, sizeBytes: png.length + 1 } },
  ]) assert.throws(() => verifyReaderResource(changed, source, raster));
  const damaged = Buffer.from(png); damaged[16] = 1;
  assert.throws(() => verifyReaderResource({ source, resource: { ...raster, base64: damaged.toString("base64") } }, source, raster));
});

test("reader does not accept arbitrary data URLs or CSS preferences", () => {
  assert.throws(() => buildReaderDocument(section(), new Map([[0, 'data:text/html;base64,PHNjcmlwdD4=']]), { font: "serif", size: 20, leading: 1.7 }));
  for (const preferences of [{ font: "evil; background:url(https://evil.test)", size: 20, leading: 1.7 }, { font: "serif", size: NaN, leading: 1.7 }, { font: "serif", size: 200, leading: 1.7 }]) assert.throws(() => buildReaderDocument(section(), new Map(), preferences as never));
});

test("fixed reading requires matching raster dimensions, while mixed-layout navigation remains available", () => {
  const value = section(); value.layout = "pre-paginated"; value.spine[0].layout = "pre-paginated"; value.document.layout = "pre-paginated"; value.document.width = 1; value.document.height = 1;
  value.document.html = '<div><img data-reader-resource="0" width="1" height="1"></div>';
  assert.deepEqual(validateReaderSection(value, source, 0), value);
  const html = buildReaderDocument(value, new Map([[0, verifyReaderResource(resource, source, raster)]]), { font: "serif", size: 20, leading: 1.7 });
  assert.match(html, /object-fit:contain/);
  value.document.width = 2; assert.throws(() => validateReaderSection(value, source, 0));
});

test("fixed reader rejects mismatched raw raster dimensions, duplicate pages and unexpected text", () => {
  for (const html of ['<div><img data-reader-resource="0" width="2" height="1"></div>', '<div><img data-reader-resource="0" width="1" height="1"><img data-reader-resource="0" width="1" height="1"></div>', '<div><p>Unexpected text</p><img data-reader-resource="0" width="1" height="1"></div>']) {
    const value = section(); value.layout = "pre-paginated"; value.spine[0].layout = "pre-paginated"; value.document.layout = "pre-paginated"; value.document.width = 1; value.document.height = 1; value.document.html = html;
    assert.throws(() => validateReaderSection(value, source, 0));
  }
});

test("late results are invalid after source, section, authorization or unmount invalidation", () => {
  const fence = createReaderFence();
  const first = fence.reset(readerSourceKey(source)); assert.equal(first(), true);
  const second = fence.reset(`${readerSourceKey(source)}:section1`); assert.equal(first(), false); assert.equal(second(), true);
  fence.clear(); assert.equal(second(), false);
  const third = fence.reset(readerSourceKey(source)); fence.reset(readerSourceKey({ ...source, jobId: source.assetId })); assert.equal(third(), false);
});

test("exact version download rejects credentials, active schemes and unbounded expiry", () => {
  assert.equal(validateReaderDownload({ url: "https://storage.example.test/book.epub?token=synthetic", expiresIn: 300 }), "https://storage.example.test/book.epub?token=synthetic");
  assert.equal(validateReaderDownload({ url: "http://127.0.0.1:4399/fixture-artifact", expiresIn: 300 }), "http://127.0.0.1:4399/fixture-artifact");
  for (const url of ["javascript:alert(1)", "data:text/html,evil", "https://user:pass@storage.example.test/a", "http://evil.test/a", "https://storage.example.test/a#fragment"]) assert.throws(() => validateReaderDownload({ url, expiresIn: 300 }));
  assert.throws(() => validateReaderDownload({ url: "https://storage.example.test/a", expiresIn: 100000 }));
});

test("image-heavy sections keep every descriptor and text; previews evict rather than truncate access", () => {
  const value = section(); value.document.resources = Array.from({ length: 300 }, (_, index) => ({ ...raster, index }));
  value.document.html = `<div><p>All saved chapter text stays readable.</p>${value.document.resources.map((image) => `<img data-reader-resource="${image.index}">`).join("")}</div>`;
  assert.equal(validateReaderSection(value, source, 0).document.resources.length, 300);
  const html = buildReaderDocument(value, new Map(), { font: "serif", size: 20, leading: 1.7 });
  assert.match(html, /All saved chapter text stays readable/); assert.match(html, /Illustration 300 is not loaded/);
  let retained = retainReaderImage(new Map(), 0, "verified-preview-0", 25 * 1024 * 1024, 1, 1);
  retained = retainReaderImage(retained, 1, "verified-preview-1", 25 * 1024 * 1024, 1, 1);
  assert.equal([...retained.values()].reduce((sum, image) => sum + image.sizeBytes, 0), READER_IMAGE_BUDGET);
  retained = retainReaderImage(retained, 299, "verified-preview-299", 25 * 1024 * 1024, 1, 1);
  assert.deepEqual([...retained.keys()], [1, 299]);
  retained = retainReaderImage(retained, 0, "verified-preview-0", 25 * 1024 * 1024, 1, 1);
  assert.deepEqual([...retained.keys()], [299, 0]);
  assert.throws(() => retainReaderImage(retained, 2, "oversized", READER_IMAGE_BUDGET + 1, 1, 1));
  const large = retainReaderImage(new Map(), 0, "large-raster", 1024, 6000, 6000);
  const second = retainReaderImage(large, 1, "second-large-raster", 1024, 6000, 6000);
  assert.deepEqual([...second.keys()], [1], "decoded pixel budget evicts a highly compressed previous image");
});

test("fixed EPUB navigation can select a reflowable contents section without inventing a viewport", () => {
  const value = section(); value.layout = "pre-paginated";
  value.spine.push({ index: 1, title: "Fixed page", layout: "pre-paginated" });
  assert.equal(validateReaderSection(value, source, 0).document.layout, "reflowable");
  assert.match(buildReaderDocument(value, new Map(), { font: "serif", size: 20, leading: 1.7 }), /font-size:20px/);
});

test("supported element ceiling counts elements, not closing tags or text tokens", () => {
  const value = section(); value.document.resources = [];
  value.document.html = `<div>${'<p>Saved text.</p>'.repeat(50_000)}</div>`;
  assert.equal(validateReaderSection(value, source, 0), value);
});

test("fixed-page fit does not replay a saved percentage width over verified raster geometry", () => {
  const value = section(); value.layout = "pre-paginated"; value.spine[0].layout = "pre-paginated"; value.document.layout = "pre-paginated"; value.document.width = 1; value.document.height = 1;
  value.document.html = '<div><img data-reader-resource="0" width="1" height="1" data-reader-width-percent="50"></div>';
  const html = buildReaderDocument(value, new Map([[0, verifyReaderResource(resource, source, raster)]]), { font: "serif", size: 20, leading: 1.7 });
  assert.ok(!html.includes('style="width:50%"')); assert.match(html, /object-fit:contain/);
});

test("raster markup is bounded without losing text; any repeated occurrence can be prioritized", () => {
  const value = section(); value.document.html = '<div><p>Before.</p><img data-reader-resource="0" alt="First occurrence"><p>Between.</p><img data-reader-resource="0" alt="Second occurrence"><p>Still here.</p><img data-reader-resource="0" alt="Last occurrence"><p>After.</p></div>';
  const urls = new Map([[0, verifyReaderResource(resource, source, raster)]]);
  const html = buildReaderDocument(value, urls, { font: "serif", size: 20, leading: 1.7 }, { selectedOccurrence: 2, rasterMarkupBudget: 210 });
  assert.equal((html.match(/<img /g) ?? []).length, 1);
  assert.match(html, /<img[^>]*alt="Last occurrence"/);
  assert.equal((html.match(/data-reader-deferred="1"/g) ?? []).length, 2);
  for (const text of ["Before.", "Between.", "Still here.", "After.", "Occurrence 1 is deferred", "Occurrence 2 is deferred"]) assert.ok(html.includes(text));
  for (const selectedOccurrence of [0, 1, 2]) {
    const selected = buildReaderDocument(value, urls, { font: "serif", size: 20, leading: 1.7 }, { selectedOccurrence, rasterMarkupBudget: 210 });
    assert.match(selected, new RegExp(`<img[^>]*data-reader-occurrence="${selectedOccurrence}"`));
  }
  assert.throws(() => buildReaderDocument(value, urls, { font: "serif", size: 20, leading: 1.7 }, { selectedOccurrence: 3, rasterMarkupBudget: 210 }));
  assert.throws(() => buildReaderDocument(value, urls, { font: "serif", size: 20, leading: 1.7 }, { selectedOccurrence: 0, rasterMarkupBudget: 97 * 1024 * 1024 }));
});

test("occurrence controls follow saved reading order without mutating section identity or small-book fidelity", () => {
  const value = section(); value.document.resources = [raster, { ...raster, index: 2 }];
  value.document.html = '<div><img data-reader-resource="2" alt="First &amp; saved"><p>Keep this text.</p><img data-reader-resource="0" alt="Middle"><img data-reader-resource="2" alt="Last &quot;repeat&quot;"></div>';
  const unchanged = structuredClone(value);
  const occurrences = readerImageOccurrences(value);
  assert.deepEqual(occurrences.map(({ index, resourceIndex, alt }) => ({ index, resourceIndex, alt })), [
    { index: 0, resourceIndex: 2, alt: "First & saved" }, { index: 1, resourceIndex: 0, alt: "Middle" }, { index: 2, resourceIndex: 2, alt: 'Last "repeat"' },
  ]);
  assert.ok(occurrences.every((occurrence) => Number.isSafeInteger(occurrence.markupBytes) && occurrence.markupBytes > 0));
  const urls = new Map(value.document.resources.map((descriptor) => [descriptor.index, verifyReaderResource({ source, resource: { ...descriptor, base64: png.toString("base64") } }, source, descriptor)]));
  const html = buildReaderDocument(value, urls, { font: "serif", size: 20, leading: 1.7 }, { selectedOccurrence: 2 });
  assert.equal((html.match(/<img /g) ?? []).length, 3); assert.ok(!html.includes('data-reader-deferred="1"')); assert.match(html, /Keep this text/);
  assert.deepEqual(value, unchanged);
});

test("unloaded and deferred occurrences have readable block placeholders without changing fixed fit", () => {
  const html = buildReaderDocument(section(), new Map(), { font: "serif", size: 20, leading: 1.7 });
  assert.match(html, /\.reader-placeholder\{display:block;margin:1em 0;/);
});
