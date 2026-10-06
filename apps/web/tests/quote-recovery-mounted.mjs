// Standalone local component acceptance: no Next server, listener or provider.
// Run: node --test apps/web/tests/quote-recovery-mounted.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const bundle = await build({
  stdin: { contents: `import React from "react"; import { createRoot } from "react-dom/client";
    import { ApiClientError } from "@bookworm/api-client";
    import Panel from "./apps/web/components/AiAssistantPanel.tsx";
    import Image from "./apps/web/components/ImageQuoteStudio.tsx";
    import Memory from "./apps/web/components/BookMemoryClient.tsx";
    const root = createRoot(document.getElementById("root"));
    window.apiError = (status, message) => new ApiClientError(status, "fixture_error", message, "fixture-request");
    window.renderPanel = props => root.render(React.createElement(Panel, {...props, onApplied: async () => {
      window.appliedCallbacks.push(props.chapterId); if (window.onApplied) await window.onApplied(); }}));
    window.renderImage = props => root.render(React.createElement(Image, {...props, onCompleted: async () => {}}));
    window.renderMemory = props => root.render(React.createElement(Memory, props));
    window.clearComponent = () => root.render(null);
    window.renderMemoryStrict = props => root.render(React.createElement(React.StrictMode, null,
      React.createElement(Memory, { key: props.bookId, ...props })));`, resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  plugins: [{ name: "local-component-fixtures", setup(builder) {
    builder.onResolve({ filter: /^\.\/api$/ }, args => args.importer.replaceAll("\\", "/").includes(resolve("apps/web/components").replaceAll("\\", "/")) ? { path: "api", namespace: "fixture" } : undefined);
    builder.onLoad({ filter: /^api$/, namespace: "fixture" }, () => ({ contents: "export const apiClient = () => window.api;" }));
    builder.onResolve({ filter: /\.module\.css$/ }, () => ({ path: "styles", namespace: "fixture" }));
    builder.onLoad({ filter: /^styles$/, namespace: "fixture" }, () => ({ contents: "export default {};" }));
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
    builder.onLoad({ filter: /^link$/, namespace: "fixture" }, () => ({ contents: 'import React from "react"; export default function Link(props) { return React.createElement("a", props); }', resolveDir: process.cwd() }));
  } }],
});
const script = bundle.outputFiles[0].text;
const stylePath = resolve("apps/web/styles/globals.css");
const styles = await postcss([tailwind({ base: resolve("apps/web"), optimize: false })]).process(await readFile(stylePath, "utf8"), { from: stylePath });
const instrument = (await readFile(resolve("apps/web/app/fonts/instrument-serif-italic.ttf"))).toString("base64");
const artifacts = await mkdtemp(resolve(tmpdir(), "bookworm-memory-mounted-"));
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
test.after(async () => { await browser.close(); console.log(JSON.stringify({ bookMemoryArtifacts: artifacts })); });

async function fixture({ width = 1280, styled = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 980 } });
  page.setDefaultTimeout(6000);
  // Every request is fulfilled in memory, including the initial trusted origin.
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' }));
  await page.goto("http://127.0.0.1/bookworm-component-fixture");
  // ponytail: the display font is real; body uses local Inter/sans-serif. Verify exact font loading on a native Next route.
  if (styled) await page.addStyleTag({ content: styles.css + `
    @font-face {font-family:BookwormInstrument;src:url(data:font/ttf;base64,${instrument});font-style:italic;font-weight:400;font-display:swap}
    :root {--font-inter:Inter,sans-serif;--font-instrument-serif:BookwormInstrument,serif}
    body {font-family:var(--font-inter);color:#fff}` });
  await page.evaluate(() => {
    window.appliedCallbacks = [];
    window.calls = [];
    window.gates = {};
    window.defer = name => new Promise((resolve, reject) => { window.gates[name] = { resolve, reject }; });
    window.job = (id, chapter, count = 1) => ({ id, book_id: chapter.startsWith("a") ? "a-book" : "b-book", chapter_ids: [chapter], agent_type: "proofreader",
      status: "succeeded", model: "approved", usage_json: {}, context_source_count: count,
      suggestions: [{ id: `${id}-suggestion`, ai_job_id: id, entity_type: "chapter", entity_id: chapter, status: "pending", rationale: `${id} proposal`,
        operation_json: { type: "replace_text", target: { chapterId: chapter, nodeId: "n1" }, payload: { nodeId: "n1", from: 4, to: 7, text: "silver" }, expectedVersion: 1 } }] });
    window.api = { listAiJobs: async () => ({ jobs: [] }), listAiReviewModels: async () => ({ models: [{ id: "approved", label: "Approved", model: "approved" }] }),
      getAiJob: async id => window.job(id, id.startsWith("a") ? "a-chapter" : "b-chapter"),
      applySuggestion: async () => ({ version: 2 }), rejectSuggestion: async () => ({ suggestion: { status: "rejected" } }) };
    window.fetch = async (path, init) => {
      window.calls.push({ path: String(path), method: init?.method || "GET", body: init?.body });
      if (path === "/api/auth/session") return Response.json({ user: { id: "00000000-0000-4000-8000-000000000001" } });
      if (window.fetchFixture) return window.fetchFixture(path, init);
      throw new Error(`Unexpected fixture request: ${path}`);
    };
  });
  await page.addScriptTag({ content: script });
  return page;
}
const props = (bookId = "a-book", chapterId = "a-chapter", initialJobId) => ({ bookId, chapterId, initialJobId,
  savedChapter: { chapterId, version: 1, nodes: [{ id: "n1", type: "paragraph", text: "The old moon rose." }] }, editable: true, dirty: false });
const imageProps = (workspaceId = "a-workspace", canEdit = true) => ({ workspaceId, canEdit, books: [], assets: [] });
const quoteId = "11111111-1111-4111-8111-111111111111";
async function imageFixture(page, saved = true) {
  await page.evaluate(({ quoteId, saved }) => {
    window.imageQuote = { id: quoteId, status: "ready", model: "approved-image", size: "1024x1024", quality: "high", kind: "illustration",
      reservedCredits: "47", expiresAt: "2030-01-01T00:00:00.000Z", pricingBasis: "maximum_token_budget", purchaseAvailable: false };
    if (saved) sessionStorage.setItem("bookworm.image-quote.v1:a-workspace", JSON.stringify({ quoteId, idempotencyKey: "original-image-key" }));
    window.api.listImageQuoteModels = async () => ({ purchaseAvailable: true, models: [{ id: "approved", label: "Approved image", model: "approved-image", size: "1024x1024", quality: "high", maxReferenceImages: 3 }] });
    window.api.createImageQuote = async (_workspace, body) => { window.calls.push({ operation: "image-create", body }); throw new Error("Quote-save reply lost"); };
    window.api.recoverImageQuote = async (_workspace, key) => { window.calls.push({ operation: "image-recover", key }); return { quoteId }; };
    window.api.getImageQuote = async () => ({ quote: window.imageQuote });
    window.api.getImageQuoteJob = async () => ({ quoteId, job: null });
    window.api.acceptImageQuote = async (_workspace, id, credits) => { window.calls.push({ operation: "image-accept", id, credits }); throw new Error("Acceptance reply lost"); };
  }, { quoteId, saved });
}
async function memoryFixture(page) {
  await page.evaluate(() => {
    window.memory = { book: { id: "a-book", title: "Saved book", author_name: "Author", language: "en" },
      metadata: { description: "Saved metadata", keywords: ["saved"], categories: ["fiction"] }, items: [],
      chapters: [{ id: "a-chapter", title: "Saved chapter", current_document_version_id: "a-version" }], imageAssets: [], canEdit: true };
    window.metadataQuote = { id: "quote", status: "ready", model: "approved", reservedCredits: 31, expiresAt: "2030-01-01T00:00:00.000Z", acceptedJobId: null };
    window.metadataStatus = { request: { id: "saved-request", status: "ready" }, quote: window.metadataQuote, job: null };
    window.passageResponse = (text, startOffset = 0, totalLength = startOffset + text.length) => {
      const endOffset = startOffset + text.length;
      return Response.json({ chapterTitle: "Saved chapter", versionNumber: 1, isCurrentVersion: false,
        text, truncated: endOffset < totalLength, startOffset, endOffset, totalLength, nextOffset: endOffset < totalLength ? endOffset : null });
    };
    window.fetchFixture = async (path, init) => {
      if (window.memoryFetch) { const response = await window.memoryFetch(path, init); if (response) return response; }
      if (path.endsWith("/memory")) return Response.json(window.memory);
      if (path.endsWith("/metadata/models")) return Response.json({ models: [{ id: "approved", label: "Approved", model: "approved", priceVersion: "price", policyVersion: "policy" }] });
      if (path.endsWith("/bible/models")) return Response.json({ catalogVersion: "saved", models: [{ id: "approved", label: "Approved", model: "approved", maxOutputTokens: 6000, priceVersion: "price", policyVersion: "policy" }] });
      if (path.endsWith("/drafts")) return Response.json({ drafts: [], pending: [] });
      throw new Error(`Unexpected memory request: ${path}`);
    };
  });
}

const canonItem = { id: "canon-item", book_id: "a-book", type: "character", name: "Private Elara canon",
  description: "Private established character appearance", updated_at: "2026-10-06T01:00:00.000Z",
  attributes_json: { traits: ["patient", "observant"], imageAssetIds: [] },
  source_refs_json: [{ chapterId: "a-chapter", documentVersionId: "a-version", nodeId: "n1", textHash: "a".repeat(64) }] };

test("paid Book Bible recovery reviews evidence then saves structured canon and image links across remount", async () => {
  const page = await fixture({ styled: true });
  try {
    await memoryFixture(page);
    await page.evaluate(ref => {
      window.memory.imageAssets = [{ id: "00000000-0000-4000-8000-000000000011", name: "Silver cloak reference", mime_type: "image/png" }];
      window.extracted = { suggestionKind: "book_bible_candidate", status: "pending", type: "character", name: "Elara Vale",
        description: "Elara keeps a silver cloak and watches the northern archive.", attributes: { traits: ["patient", "observant"], timeline: { arrival: 3 } },
        confidence: 0.87, sourceRefs: [ref] };
      window.bibleStatus = { request: { id: "paid-bible-request", status: "ready" }, quote: { requestId: "paid-bible-request", status: "ready", model: "approved",
        countedInputTokens: 1200, maxOutputTokens: 6000, reservedCredits: 23, expiresAt: "2030-01-01T00:00:00Z" }, job: null };
      window.memoryFetch = (path, init) => {
        if (path.endsWith("/bible/quotes")) return Response.json(window.bibleStatus);
        if (path.endsWith("/paid-bible-request/accept")) {
          window.bibleStatus = { ...window.bibleStatus, quote: { ...window.bibleStatus.quote, status: "accepted" }, job: { id: "paid-bible-job", status: "succeeded" } };
          throw new Error("Accepted reply lost after the paid job was saved");
        }
        if (path.endsWith("/bible/quotes/paid-bible-request")) return Response.json(window.bibleStatus);
        if (path.endsWith("/bible/jobs/paid-bible-job/recover")) return Response.json({ candidates: [window.extracted] });
        if (path.endsWith("/bible/evidence")) return window.passageResponse("Elara wore a silver cloak.");
        if (path.endsWith("/bible") && init?.method === "POST") {
          const body = JSON.parse(init.body);
          const item = { id: "persisted-canon", book_id: "a-book", type: body.type, name: body.name, description: body.description,
            attributes_json: { ...body.attributes, imageAssetIds: body.imageAssetIds }, source_refs_json: body.sourceRefs, updated_at: "2026-10-06T01:00:00Z" };
          window.memory.items.push(item); return Response.json({ item });
        }
      };
      window.renderMemory({ bookId: "a-book" });
    }, canonItem.source_refs_json[0]);
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.method !== "GET").length), 0);
    await expect(page.getByRole("button", { name: "Count tokens and request quote" })).toBeDisabled();
    await page.getByRole("checkbox", { name: /I agree to send the selected saved manuscript batch/ }).check();
    await page.getByRole("button", { name: "Count tokens and request quote" }).click();
    const quote = page.getByRole("region", { name: "Book Bible token quote" });
    await expect(quote).toContainText("1,200 tokens"); await expect(quote).toContainText("6,000 tokens"); await expect(quote).toContainText("23 credits");
    const accept = page.getByRole("button", { name: "Accept quote and start extraction" });
    await expect(accept).toBeDisabled();
    await page.getByRole("checkbox", { name: /I approve this quote and authorize one candidate extraction/ }).check();
    await accept.click();
    await page.getByText(/Acceptance is unconfirmed. Resume this quote/).waitFor(); await expect(accept).toBeDisabled();
    await page.getByRole("button", { name: "Check quote/job status" }).click();
    await page.getByRole("button", { name: "Recover existing result" }).click();
    await expect(page.getByText("0 saved entries · changes are saved only when you choose Save.", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Open as unsaved entry" }).click();
    const evidence = page.getByRole("region", { name: "Saved manuscript evidence" });
    await evidence.getByRole("button", { name: "Read source passage" }).click();
    await expect(evidence.locator("blockquote")).toHaveText("Elara wore a silver cloak.");
    await expect(page.getByRole("textbox", { name: "Attribute 1 value" })).toHaveValue('["patient","observant"]');
    await page.getByRole("checkbox", { name: "Silver cloak reference" }).check();
    assert.equal(await page.evaluate(() => window.memory.items.length), 0, "review, reading and image selection must not write canon");
    await page.getByRole("button", { name: "Save memory entry" }).click();
    await page.getByText("“Elara Vale” saved to this book’s memory.", { exact: true }).waitFor();
    const calls = await page.evaluate(() => window.calls);
    const writes = calls.filter(call => call.path.endsWith("/bible") && call.method === "POST");
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].body), { type: "character", name: "Elara Vale", description: "Elara keeps a silver cloak and watches the northern archive.",
      attributes: { traits: ["patient", "observant"], timeline: { arrival: 3 } }, imageAssetIds: ["00000000-0000-4000-8000-000000000011"], sourceRefs: canonItem.source_refs_json });
    assert.equal(calls.filter(call => call.path.endsWith("/bible/quotes") && call.method === "POST").length, 1);
    const acceptance = calls.filter(call => call.path.endsWith("/accept"));
    assert.equal(acceptance.length, 1); assert.deepEqual(JSON.parse(acceptance[0].body), { expectedCredits: 23 });
    assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage).includes(window.extracted.description)), false);
    await page.evaluate(() => { window.clearComponent(); window.memory.chapters[0].current_document_version_id = "new-version"; });
    await expect(page.getByRole("heading", { name: "Book Bible", exact: true })).toHaveCount(0);
    await page.evaluate(() => window.renderMemory({ bookId: "a-book" }));
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.getByRole("button", { name: /character Elara Vale/ }).click();
    await expect(page.getByRole("textbox", { name: "Attribute 1 value" })).toHaveValue('["patient","observant"]');
    await expect(page.getByRole("checkbox", { name: "Silver cloak reference" })).toBeChecked();
    await page.getByRole("region", { name: "Saved manuscript evidence" }).getByRole("button", { name: "Read source passage" }).click();
    await expect(page.getByText(/Saved version 1 · an earlier version/)).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveValue("Saved metadata");
    await page.screenshot({ path: resolve(artifacts, "book-memory-paid-canon-desktop.png"), fullPage: true });
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.path.endsWith("/accept")).length), 1);
  } finally { await page.close(); }
});

for (const change of ["select another entry", "change source chapter", "remove source"]) test(`late saved passage cannot return after ${change}`, async () => {
  const page = await fixture();
  try {
    await memoryFixture(page);
    await page.evaluate(item => {
      window.memory.items = [item, { ...item, id: "other-canon", name: "Other canon", source_refs_json: [{ chapterId: "second-chapter", documentVersionId: "second-version", nodeId: "n2", textHash: "b".repeat(64) }] }];
      window.memory.chapters.push({ id: "second-chapter", title: "Other chapter", current_document_version_id: "second-version" });
      window.memoryFetch = (path, init) => {
        if (!path.endsWith("/bible/evidence")) return;
        return JSON.parse(init.body).nodeId === "n1" ? window.defer("old-passage") : window.passageResponse("Current entry evidence.");
      };
      window.renderMemory({ bookId: "a-book" });
    }, canonItem);
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.getByRole("button", { name: /Private Elara canon/ }).click();
    await page.getByRole("button", { name: "Read source passage" }).click();
    await page.waitForFunction(() => !!window.gates["old-passage"]);
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(button => button.textContent === "Loading passage…");
      button.click(); button.click();
    });
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.path.endsWith("/bible/evidence")).length), 1, "the loading guard must block repeated read handlers");
    if (change === "select another entry") await page.getByRole("button", { name: /Other canon/ }).click();
    else if (change === "change source chapter") await page.getByRole("combobox", { name: "Source chapter", exact: true }).selectOption("second-chapter");
    else await page.getByRole("button", { name: "Remove source", exact: true }).click();
    await page.evaluate(() => window.gates["old-passage"].resolve(window.passageResponse("Old private passage must stay closed.")));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByText("Old private passage must stay closed.", { exact: true })).toHaveCount(0);
    if (change === "select another entry") {
      await page.getByRole("button", { name: "Read source passage" }).click();
      await expect(page.locator("blockquote")).toHaveText("Current entry evidence.");
    } else await expect(page.getByRole("button", { name: "Read source passage" })).toHaveCount(0);
    const posts = await page.evaluate(() => window.calls.filter(call => call.method !== "GET"));
    assert.equal(posts.every(call => call.path.endsWith("/bible/evidence")), true, "changing the draft must not save or generate");
  } finally { await page.close(); }
});

test("mobile saved evidence keeps verified offsets through failures, keyboard paging and denied reload", async () => {
  const page = await fixture({ width: 375, styled: true });
  try {
    await memoryFixture(page);
    await page.evaluate(item => {
      window.memory.canEdit = false; window.memory.items = [item]; window.memory.chapters[0].title = "EvidenceChapter".repeat(12);
      window.firstSection = "Elara’s silver cloak 😀 was recorded in the northern archive. ";
      window.secondSection = "The saved passage confirms the character’s first appearance.";
      window.evidenceReads = 0; window.pageFailure = false;
      window.memoryFetch = (path, init) => {
        if (path.endsWith("/memory") && window.pageFailure) return Response.json({ error: { message: "Workspace access was revoked" } }, { status: 403 });
        if (!path.endsWith("/bible/evidence")) return;
        const offset = JSON.parse(init.body).offset;
        if (++window.evidenceReads === 1) throw new Error("Reader temporarily offline");
        if (window.evidenceReads === 3) return Response.json({ text: "Unverified replacement must not appear", isCurrentVersion: false,
          startOffset: 0, endOffset: 38, totalLength: 999, nextOffset: 999 });
        return window.passageResponse(offset === 0 ? window.firstSection : window.secondSection, offset, window.firstSection.length + window.secondSection.length);
      };
      window.renderMemory({ bookId: "a-book" });
    }, canonItem);
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.getByRole("button", { name: /Private Elara canon/ }).click();
    const evidence = page.getByRole("region", { name: "Saved manuscript evidence" });
    const read = evidence.getByRole("button", { name: "Read source passage" });
    await read.focus(); await page.keyboard.press("Enter");
    await expect(evidence.getByRole("alert")).toHaveText("Reader temporarily offline"); await expect(read).toBeEnabled();
    await read.focus(); await page.keyboard.press("Enter");
    await expect(evidence.locator("blockquote")).toHaveText("Elara’s silver cloak 😀 was recorded in the northern archive.");
    const next = evidence.getByRole("button", { name: "Next passage section" });
    const previous = evidence.getByRole("button", { name: "Previous passage section" });
    await expect(previous).toBeDisabled(); await next.focus(); await page.keyboard.press("Enter");
    await expect(evidence.getByRole("alert")).toHaveText("The saved passage position could not be verified.");
    await expect(evidence.locator("blockquote")).not.toContainText("Unverified replacement"); await expect(previous).toBeDisabled();
    assert.equal(await next.evaluate(button => button.matches(":focus-visible") && getComputedStyle(button).boxShadow !== "none"), true, "keyboard paging needs a visible focus ring");
    await next.focus(); await page.keyboard.press("Enter");
    await expect(evidence.locator("blockquote")).toHaveText("The saved passage confirms the character’s first appearance.");
    await expect(next).toBeDisabled(); await expect(previous).toBeEnabled();
    await previous.focus(); await page.keyboard.press("Enter");
    await expect(evidence.locator("blockquote")).toContainText("Elara’s silver cloak");
    await page.evaluate(async () => document.fonts.ready);
    const metrics = await evidence.getByRole("button").evaluateAll(buttons => buttons.map(button => ({ label: button.textContent, height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width })));
    assert(metrics.every(button => button.height >= 44 && button.width >= 44), JSON.stringify(metrics));
    assert.equal(await page.evaluate(() => document.compatMode), "CSS1Compat");
    const bounds = await page.evaluate(() => ({ viewport: window.innerWidth, scrollWidth: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll("body *")].map(element => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { tag: element.tagName, classes: element.className, right: rect.right, width: rect.width, minWidth: style.minWidth,
          overflowWrap: style.overflowWrap, text: element.textContent?.slice(0, 100) };
      }).filter(element => element.right > window.innerWidth + 1).slice(0, 14) }));
    await writeFile(resolve(artifacts, "book-memory-mobile-bounds.json"), JSON.stringify({ ...bounds, evidenceButtons: metrics }, null, 2), "utf8");
    if (bounds.scrollWidth > bounds.viewport) await page.screenshot({ path: resolve(artifacts, "book-memory-mobile-overflow.png") });
    assert.equal(bounds.scrollWidth <= bounds.viewport, true, "375px evidence must not overflow, including unbroken chapter titles");
    await evidence.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, "book-memory-source-viewer-mobile.png") });
    const offsets = await page.evaluate(() => window.calls.filter(call => call.path.endsWith("/bible/evidence")).map(call => JSON.parse(call.body).offset));
    const firstLength = await page.evaluate(() => window.firstSection.length);
    assert.deepEqual(offsets, [0, 0, firstLength, firstLength, 0]);
    await page.evaluate(() => { window.pageFailure = true; });
    await page.getByRole("button", { name: "Reload saved data" }).click();
    await page.getByRole("heading", { name: "Book memory is unavailable" }).waitFor();
    await expect(page.getByRole("region", { name: "Saved manuscript evidence" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Private Elara canon/ })).toHaveCount(0);
    await page.screenshot({ path: resolve(artifacts, "book-memory-revalidation-failure-mobile.png") });
  } finally { await page.close(); }
});

for (const status of [401, 403, 503]) test(`Book Bible reload ${status} clears private memory and permissions without losing paid recovery`, async () => {
  const page = await fixture();
  try {
    await memoryFixture(page);
    await page.evaluate(item => { window.memory.items = [item]; window.renderMemory({ bookId: "a-book" }); }, canonItem);
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.getByRole("button", { name: /Private Elara canon/ }).click();
    await expect(page.getByRole("button", { name: "Save memory entry" })).toBeEnabled();
    const pointers = await page.evaluate(() => {
      const key = "original-paid-memory-key";
      const body = { modelId: "approved", idempotencyKey: key, allowProviderTokenCounting: true, chapterIds: ["a-chapter"], maxTokens: 12000 };
      const pointers = ["bookworm:metadata-quote:v1:a-book", "bookworm:bible-quote:v1:a-book"].map(keyName => [keyName, JSON.stringify({ idempotencyKey: key, body })]);
      for (const [keyName, value] of pointers) sessionStorage.setItem(keyName, value);
      window.memoryFetch = path => path.endsWith("/memory") ? window.defer("memory-reload") : undefined;
      return pointers;
    });
    await page.getByRole("button", { name: "Reload saved data" }).click();
    await page.waitForFunction(() => !!window.gates["memory-reload"]);
    await expect(page.getByRole("button", { name: /Private Elara canon/ })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save memory entry" })).toHaveCount(0);
    await page.evaluate(status => window.gates["memory-reload"].resolve(Response.json({ error: { message: "Memory access could not be revalidated" } }, { status })), status);
    await page.getByRole("heading", { name: "Book memory is unavailable" }).waitFor();
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Save book details" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save metadata" })).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText(status === 401 ? "Your session expired" : "Memory access could not be revalidated");
    await page.evaluate(() => {
      window.memoryFetch = undefined; window.memory.canEdit = false; window.memory.items = [];
      window.memory.book.title = "Revalidated read-only book"; window.memory.metadata.description = "Current viewer-approved metadata";
    });
    await page.getByRole("button", { name: "Reload saved data" }).click();
    const description = page.getByRole("textbox", { name: "Book description", exact: true });
    await expect(description).toHaveValue("Current viewer-approved metadata"); await expect(description).toBeDisabled();
    await expect(page.getByText(/You have read-only access/)).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Private Elara canon/ })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(pointers => pointers.map(([key]) => [key, sessionStorage.getItem(key)]), pointers), pointers);
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.method !== "GET").length), 0, "reload must not accept, cancel, regenerate or save");
  } finally { await page.close(); }
});

test("Book Bible StrictMode latest load wins over an older editable response", async () => {
  const page = await fixture();
  try {
    await memoryFixture(page);
    await page.evaluate(item => {
      const oldMemory = structuredClone(window.memory); oldMemory.items = [item];
      window.memoryReads = 0;
      window.memoryFetch = path => {
        if (!path.endsWith("/memory")) return;
        if (++window.memoryReads === 1) { window.oldMemory = oldMemory; return window.defer("strict-old-memory"); }
        return Response.json({ ...window.memory, canEdit: false, metadata: { ...window.memory.metadata, description: "Latest authorized viewer memory" } });
      };
      window.renderMemoryStrict({ bookId: "a-book" });
    }, canonItem);
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveValue("Latest authorized viewer memory");
    await page.evaluate(() => window.gates["strict-old-memory"].resolve(Response.json(window.oldMemory)));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveValue("Latest authorized viewer memory");
    await expect(page.getByRole("button", { name: "Save metadata" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Private Elara canon/ })).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.path.endsWith("/models") || call.path.endsWith("/drafts")).length), 0);
  } finally { await page.close(); }
});

test("saved Book Bible evidence is readable to viewers and chapter-only notes are not passage proof", async () => {
  const page = await fixture();
  try {
    await memoryFixture(page);
    await page.evaluate(item => {
      window.memory.canEdit = false;
      window.memory.items = [item, { ...item, id: "chapter-note", name: "Chapter-only note", source_refs_json: [{ chapterId: "a-chapter", documentVersionId: "a-version", note: "Opening scene" }] }];
      window.memoryFetch = (path, init) => {
        if (path.endsWith("/bible/evidence")) {
          const text = "Elara wore a silver cloak.";
          return Response.json({ chapterTitle: "Saved chapter", versionNumber: 1, isCurrentVersion: false,
            text, truncated: false, startOffset: 0, endOffset: text.length, totalLength: text.length, nextOffset: null });
        }
      };
      window.renderMemory({ bookId: "a-book" });
    }, canonItem);
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.getByRole("button", { name: /Private Elara canon/ }).click();
    const read = page.getByRole("button", { name: "Read source passage" });
    await expect(read).toBeEnabled(); await read.click();
    await expect(page.locator("blockquote")).toHaveText("Elara wore a silver cloak.");
    await expect(page.getByText(/Saved version 1 · an earlier version/)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Save memory entry" })).toHaveCount(0);
    await page.getByRole("button", { name: /Chapter-only note/ }).click();
    await expect(page.getByRole("button", { name: "Read source passage" })).toHaveCount(0);
    await expect(page.getByText("Chapter reference only. No exact passage has been pinned.", { exact: true })).toHaveCount(1);
    const posts = await page.evaluate(() => window.calls.filter(call => call.method !== "GET"));
    assert.equal(posts.length, 1); assert.equal(posts[0].path, "/api/backend/v1/books/a-book/bible/evidence");
    assert.deepEqual(JSON.parse(posts[0].body), { ...canonItem.source_refs_json[0], offset: 0 });
  } finally { await page.close(); }
});

test("metadata draft proof reads exact historical evidence before explicit use and save", async () => {
  const page = await fixture();
  try {
    await memoryFixture(page);
    await page.evaluate(ref => {
      window.metadataCandidate = { description: "An evidence-backed publisher description about Elara and her silver cloak.",
        keywords: ["silver cloak"], categories: ["Fiction / Fantasy"], sourceRefs: [ref] };
      window.memoryFetch = (path, init) => {
        if (path.endsWith("/metadata/drafts")) return Response.json({ drafts: [{ id: "saved-proof", createdAt: "2026-10-06T01:00:00Z", candidate: window.metadataCandidate }], pending: [] });
        if (path.endsWith("/bible/evidence")) {
          const text = "Elara wore a silver cloak.";
          return Response.json({ chapterTitle: "Saved chapter", versionNumber: 1, isCurrentVersion: false,
            text, truncated: false, startOffset: 0, endOffset: text.length, totalLength: text.length, nextOffset: null });
        }
        if (path.endsWith("/metadata") && init?.method === "PUT") {
          const body = JSON.parse(init.body);
          window.memory.metadata = { ...window.memory.metadata, ...body, updated_at: "2026-10-06T01:30:00Z" };
          return Response.json({ metadata: window.memory.metadata });
        }
      };
      window.renderMemory({ bookId: "a-book" });
    }, canonItem.source_refs_json[0]);
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.getByRole("button", { name: /An evidence-backed publisher description/ }).click();
    const proof = page.locator('article[aria-labelledby="metadata-preview-title"]');
    await proof.getByRole("button", { name: "Read source passage" }).click();
    await expect(proof.locator("blockquote")).toHaveText("Elara wore a silver cloak.");
    const description = page.getByRole("textbox", { name: "Book description", exact: true });
    await expect(description).toHaveValue("Saved metadata");
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.method !== "GET").length), 1, "only evidence reading may have occurred");
    await proof.getByRole("button", { name: "Use this draft" }).click();
    await expect(description).toHaveValue("An evidence-backed publisher description about Elara and her silver cloak.");
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.method === "PUT").length), 0);
    await page.getByRole("button", { name: "Save metadata", exact: true }).click();
    await page.getByText("Publishing metadata saved.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Reload saved data" }).click();
    await expect(description).toHaveValue("An evidence-backed publisher description about Elara and her silver cloak.");
    const writes = await page.evaluate(() => window.calls.filter(call => call.method === "PUT"));
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].body), { expectedUpdatedAt: null, description: "An evidence-backed publisher description about Elara and her silver cloak.",
      keywords: ["silver cloak"], categories: ["Fiction / Fantasy"], isbn13: null, edition: null, publicationDate: null });
    assert.equal(await page.evaluate(() => window.calls.filter(call => /quotes|\/accept|\/generate/.test(call.path)).length), 0);
  } finally { await page.close(); }
});

test("late recent-review reply cannot replace another book's list", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.api.listAiJobs = book => book === "a-book" ? window.defer("recent-a") : Promise.resolve({ jobs: [window.job("b-job", "b-chapter", 222)] }); });
    await page.evaluate(input => window.renderPanel(input), props());
    await page.waitForFunction(() => !!window.gates["recent-a"]);
    await page.evaluate(input => window.renderPanel(input), props("b-book", "b-chapter"));
    await page.getByText("222 related saved sources").waitFor({ state: "attached" });
    await page.evaluate(() => window.gates["recent-a"].resolve({ jobs: [window.job("a-job", "a-chapter", 111)] }));
    await expect(page.getByText("222 related saved sources")).toHaveCount(1);
    await expect(page.getByText("111 related saved sources")).toHaveCount(0);
  } finally { await page.close(); }
});

test("late restore success cannot open a review in another chapter", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.api.listAiJobs = async () => ({ jobs: [window.job("a-job", "a-chapter")] }); window.api.getAiJob = id => id === "a-job" ? window.defer("restore-a") : Promise.resolve(window.job(id, "b-chapter")); });
    await page.evaluate(input => window.renderPanel(input), props());
    await page.getByText("Recent saved reviews").click();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.waitForFunction(() => !!window.gates["restore-a"]);
    await page.evaluate(input => window.renderPanel(input), props("b-book", "b-chapter", "b-job"));
    await page.getByText("b-job proposal", { exact: true }).waitFor();
    await page.evaluate(() => window.gates["restore-a"].resolve(window.job("a-job", "a-chapter")));
    await expect(page.getByText("b-job proposal", { exact: true })).toHaveCount(1);
    await expect(page.getByText("a-job proposal", { exact: true })).toHaveCount(0);
  } finally { await page.close(); }
});

test("late Apply success cannot refresh or change a newly selected chapter", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.api.applySuggestion = () => window.defer("apply-a"); });
    await page.evaluate(input => window.renderPanel(input), props("a-book", "a-chapter", "a-job"));
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForFunction(() => !!window.gates["apply-a"]);
    await page.evaluate(input => window.renderPanel(input), props("b-book", "b-chapter", "b-job"));
    await page.getByText("b-job proposal", { exact: true }).waitFor();
    await page.evaluate(() => window.gates["apply-a"].resolve({ version: 999 }));
    await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
    await expect(page.getByText(/version 999/)).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.appliedCallbacks), []);
  } finally { await page.close(); }
});

test("late Reject failure cannot clear a current chapter's in-flight review", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.api.rejectSuggestion = id => window.defer(id.startsWith("a") ? "reject-a" : "reject-b"); });
    await page.evaluate(input => window.renderPanel(input), props("a-book", "a-chapter", "a-job"));
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await page.waitForFunction(() => !!window.gates["reject-a"]);
    await page.evaluate(input => window.renderPanel(input), props("b-book", "b-chapter", "b-job"));
    await page.getByText("b-job proposal", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await page.waitForFunction(() => !!window.gates["reject-b"]);
    await page.evaluate(() => window.gates["reject-a"].reject(new Error("Old chapter rejection failed")));
    await expect(page.getByRole("button", { name: "Reject", exact: true })).toBeDisabled();
    await expect(page.getByText("Old chapter rejection failed", { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.gates["reject-b"].resolve({ suggestion: { id: "b-job-suggestion", status: "rejected" } }));
    await expect(page.getByText("rejected", { exact: true })).toHaveCount(1);
  } finally { await page.close(); }
});

test("image lost-save recovery uses only the persisted key and read-only offer/job requests", async () => {
  const page = await fixture();
  try {
    await imageFixture(page, false);
    await page.evaluate(input => window.renderImage(input), imageProps());
    await page.getByLabel("Describe the scene, characters, mood and visual style").fill("A silver moon over an old market");
    await page.getByRole("checkbox", { name: /Save this private prompt/ }).check();
    await page.getByRole("button", { name: "Prepare image quote" }).click();
    await page.getByText("Quote-save reply lost", { exact: true }).waitFor();
    const original = await page.evaluate(() => JSON.parse(sessionStorage.getItem("bookworm.image-quote.v1:a-workspace")));
    assert.deepEqual(Object.keys(original), ["idempotencyKey"]);
    await page.getByRole("button", { name: "Recover same quote request" }).click();
    await page.getByRole("button", { name: "Accept quote · 47 credits" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.operation).map(call => ({ operation: call.operation, key: call.key ?? call.body?.idempotencyKey }))), [
      { operation: "image-create", key: original.idempotencyKey }, { operation: "image-recover", key: original.idempotencyKey },
    ]);
    await expect(page.getByRole("checkbox", { name: /I approve sending this saved prompt/ })).not.toBeChecked();
  } finally { await page.close(); }
});

test("uncertain image acceptance stays locked until a successful read and fresh consent", async () => {
  const page = await fixture();
  try {
    await imageFixture(page);
    await page.evaluate(input => window.renderImage(input), imageProps());
    const consent = page.getByRole("checkbox", { name: /I approve sending this saved prompt/ });
    const accept = page.getByRole("button", { name: "Accept quote · 47 credits" });
    await consent.check(); await accept.click();
    await page.getByText(/Acceptance is unconfirmed. Refresh status to recover/).waitFor();
    await expect(accept).toBeDisabled(); await expect(consent).toBeDisabled();
    await page.evaluate(() => { window.api.getImageQuoteJob = async () => { throw new Error("Status temporarily unavailable"); }; });
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await page.getByText("Status temporarily unavailable", { exact: true }).waitFor();
    await expect(accept).toBeDisabled(); await expect(consent).toBeDisabled();
    await page.evaluate(quoteId => { window.api.getImageQuoteJob = async () => ({ quoteId, job: null }); }, quoteId);
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect(consent).toBeEnabled(); await expect(consent).not.toBeChecked(); await expect(accept).toBeDisabled();
    await consent.check(); await expect(accept).toBeEnabled();
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.operation === "image-accept").length), 1);
    await page.evaluate(input => window.renderImage(input), imageProps("a-workspace", false));
    await expect(accept).toBeDisabled(); await expect(consent).toBeDisabled();
  } finally { await page.close(); }
});

test("metadata storage failure prevents even the first counting POST", async () => {
  const page = await fixture();
  try {
    await memoryFixture(page);
    await page.evaluate(() => window.renderMemory({ bookId: "a-book" }));
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.getByRole("checkbox", { name: /I agree to send the selected saved chapters/ }).check();
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("Storage blocked"); }; });
    await page.getByRole("button", { name: "Request token quote" }).click();
    await page.getByText(/Browser session recovery is unavailable. No paid quote request was sent/).waitFor();
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.method === "POST").length), 0);
  } finally { await page.close(); }
});

test("metadata lost-create 404 cannot count again until explicit same-key retry", async () => {
  const page = await fixture();
  try {
    await memoryFixture(page);
    await page.evaluate(() => {
      window.memoryFetch = async (path, init) => {
        if (path.endsWith("/metadata/quotes/recover")) return Response.json({ error: { message: "Original request not found" } }, { status: 404 });
        if (path.endsWith("/metadata/quotes")) {
          if (window.calls.filter(call => call.path.endsWith("/metadata/quotes")).length === 1) throw new Error("Quote creation reply lost");
          return Response.json(window.metadataStatus);
        }
      };
      window.renderMemory({ bookId: "a-book" });
    });
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.getByRole("checkbox", { name: /I agree to send the selected saved chapters/ }).check();
    await page.getByRole("button", { name: "Request token quote" }).click();
    await page.getByText(/Quote creation reply lost/).waitFor();
    await page.getByRole("button", { name: "Resume same quote request" }).click();
    await page.getByRole("button", { name: "Retry saving original quote request" }).waitFor();
    const before = await page.evaluate(() => window.calls.filter(call => call.method === "POST"));
    assert.equal(before.length, 2);
    assert.equal(before[1].path.endsWith("/metadata/quotes/recover"), true);
    assert.deepEqual(JSON.parse(before[1].body), { idempotencyKey: JSON.parse(before[0].body).idempotencyKey });
    await page.getByRole("button", { name: "Retry saving original quote request" }).click();
    await page.getByRole("button", { name: "Accept quote · 31 credits" }).waitFor();
    const posts = await page.evaluate(() => window.calls.filter(call => call.method === "POST"));
    assert.equal(posts.length, 3); assert.deepEqual(JSON.parse(posts[2].body), JSON.parse(posts[0].body));
    await expect(page.getByRole("button", { name: "Accept quote · 31 credits" })).toBeDisabled();
    assert.equal(posts.some(call => call.path.endsWith("/accept")), false);
  } finally { await page.close(); }
});

test("metadata uncertain acceptance requires GET recovery and a new explicit consent", async () => {
  const page = await fixture();
  try {
    await memoryFixture(page);
    await page.evaluate(() => {
      window.memoryFetch = async path => {
        if (path.endsWith("/accept")) throw new Error("Acceptance reply lost");
        if (path.endsWith("/metadata/quotes") || path.includes("/metadata/quote-requests/")) return Response.json(window.metadataStatus);
      };
      window.renderMemory({ bookId: "a-book" });
    });
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.getByRole("checkbox", { name: /I agree to send the selected saved chapters/ }).check();
    await page.getByRole("button", { name: "Request token quote" }).click();
    const consent = page.getByRole("checkbox", { name: /I confirm: reserve up to/ });
    const accept = page.getByRole("button", { name: "Accept quote · 31 credits" });
    await consent.check(); await accept.click();
    await page.getByText(/Acceptance is unconfirmed. Refresh saved quote status/).waitFor();
    await expect(consent).toBeDisabled(); await expect(accept).toBeDisabled();
    await page.getByRole("button", { name: "Refresh saved quote status" }).click();
    await expect(consent).toBeEnabled(); await expect(consent).not.toBeChecked(); await expect(accept).toBeDisabled();
    await consent.check(); await expect(accept).toBeEnabled();
    const posts = await page.evaluate(() => window.calls.filter(call => call.method === "POST"));
    assert.equal(posts.length, 2); assert.equal(posts.filter(call => call.path.endsWith("/accept")).length, 1);
    assert.deepEqual(JSON.parse(posts[1].body), { expectedCredits: 31 });
  } finally { await page.close(); }
});

test("verified metadata pre-dispatch cancellation releases the UI lock and never generates", async () => {
  const page = await fixture();
  try {
    await memoryFixture(page);
    await page.evaluate(() => {
      const key = "original-metadata-key";
      sessionStorage.setItem("bookworm:metadata-quote:v1:a-book", JSON.stringify({ idempotencyKey: key,
        body: { modelId: "approved", idempotencyKey: key, allowProviderTokenCounting: true, chapterIds: ["a-chapter"], maxTokens: 12000 } }));
      window.memoryFetch = async path => path.endsWith("/metadata/quotes/recover") ? Response.json({ ...window.metadataStatus,
        job: { id: "cancelled-job", status: "failed", errorCode: "metadata_permission_revoked_before_dispatch" } }) : undefined;
      window.renderMemory({ bookId: "a-book" });
    });
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.getByRole("button", { name: "Resume same quote request" }).click();
    await page.getByText(/Editing permission was revoked before generation.*released the reserved credits/).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("bookworm:metadata-quote:v1:a-book")), null);
    await expect(page.getByText(/This accepted request needs review/)).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.method === "POST").length), 1);
  } finally { await page.close(); }
});

test("AI review uncertain acceptance keeps the original quote locked until read-only recovery", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.reviewQuote = { requestId: "11111111-1111-4111-8111-111111111111", status: "ready", agentType: "proofreader", model: "approved",
        countedInputTokens: 3100, maxOutputTokens: 6000, reservedCredits: 24, expiresAt: "2030-01-01T00:00:00.000Z" };
      window.api.createAiReviewQuote = async (_book, body) => { window.calls.push({ operation: "review-create", body }); return { quote: window.reviewQuote }; };
      window.api.acceptAiReviewQuote = async (_book, requestId, expectedCredits) => { window.calls.push({ operation: "review-accept", requestId, expectedCredits }); throw new Error("Paid reply lost"); };
      window.api.getAiReviewQuote = async () => { window.calls.push({ operation: "review-status" }); throw new Error("Recovery offline"); };
    });
    await page.evaluate(input => window.renderPanel(input), props());
    await page.getByRole("checkbox", { name: /I agree to send the selected saved chapter/ }).check();
    await page.getByRole("button", { name: "Prepare usage quote" }).click();
    const accept = page.getByRole("button", { name: "Accept · 24 credits" });
    await accept.click();
    await page.getByRole("button", { name: "Recover acceptance status" }).waitFor();
    await expect(accept).toBeDisabled();
    await page.evaluate(() => { window.api.getAiReviewQuote = async () => { window.calls.push({ operation: "review-status" }); return { quote: window.reviewQuote, job: null }; }; });
    await page.getByRole("button", { name: "Recover acceptance status" }).click();
    await expect(accept).toBeEnabled();
    const operations = await page.evaluate(() => window.calls.filter(call => call.operation));
    assert.deepEqual(operations.map(call => call.operation), ["review-create", "review-accept", "review-status", "review-status"]);
    assert.equal(operations[1].expectedCredits, 24);
    await page.evaluate(input => window.renderPanel({ ...input, dirty: true }), props());
    await expect(accept).toBeDisabled();
    await page.evaluate(input => window.renderPanel({ ...input, editable: false }), props());
    await expect(accept).toBeDisabled();
  } finally { await page.close(); }
});

test("Book Bible uncertain acceptance reads the existing quote before another explicit approval", async () => {
  const page = await fixture();
  try {
    await memoryFixture(page);
    await page.evaluate(() => {
      window.bibleStatus = { request: { id: "bible-request", status: "ready" }, quote: { requestId: "bible-request", status: "ready", model: "approved",
        countedInputTokens: 1200, maxOutputTokens: 6000, reservedCredits: 23, expiresAt: "2030-01-01T00:00:00.000Z" }, job: null };
      window.memoryFetch = async path => {
        if (path.endsWith("/accept")) throw new Error("Book Bible acceptance reply lost");
        if (path.endsWith("/bible/quotes") || path.endsWith("/bible/quotes/bible-request")) return Response.json(window.bibleStatus);
      };
      window.renderMemory({ bookId: "a-book" });
    });
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.getByRole("checkbox", { name: /I agree to send the selected saved manuscript batch/ }).check();
    await page.getByRole("button", { name: "Count tokens and request quote" }).click();
    const consent = page.getByRole("checkbox", { name: /I approve this quote and authorize one candidate extraction/ });
    const accept = page.getByRole("button", { name: "Accept quote and start extraction" });
    await consent.check(); await accept.click();
    await page.getByText(/Acceptance is unconfirmed. Resume this quote/).waitFor();
    await expect(accept).toBeDisabled(); await expect(consent).toBeDisabled();
    await page.getByRole("button", { name: "Check quote/job status" }).click();
    await expect(consent).toBeEnabled(); await expect(consent).not.toBeChecked(); await expect(accept).toBeDisabled();
    const posts = await page.evaluate(() => window.calls.filter(call => call.method === "POST"));
    assert.equal(posts.length, 2); assert.deepEqual(JSON.parse(posts[1].body), { expectedCredits: 23 });
    await page.getByRole("textbox", { name: "Book description", exact: true }).fill("Unsaved metadata edit");
    await expect(consent).toBeDisabled(); await expect(accept).toBeDisabled();
  } finally { await page.close(); }
});

test("accepted metadata recovery exposes a draft without changing or saving the author form", async () => {
  const page = await fixture();
  try {
    await memoryFixture(page);
    await page.evaluate(() => {
      const key = "original-metadata-key";
      sessionStorage.setItem("bookworm:metadata-quote:v1:a-book", JSON.stringify({ idempotencyKey: key,
        body: { modelId: "approved", idempotencyKey: key, allowProviderTokenCounting: true, chapterIds: ["a-chapter"], maxTokens: 12000 } }));
      window.candidateDescription = "A recovered author-reviewed description with sufficient saved evidence.";
      window.memoryFetch = async path => path.endsWith("/metadata/quotes/recover") ? Response.json({ ...window.metadataStatus,
        quote: { ...window.metadataQuote, status: "accepted", acceptedJobId: "saved-job" }, job: { id: "saved-job", status: "succeeded" },
        candidate: { description: window.candidateDescription, keywords: ["recovered"], categories: ["fantasy"],
          sourceRefs: [{ chapterId: "a-chapter", documentVersionId: "a-version", nodeId: "n1", textHash: "a".repeat(64) }] } }) : undefined;
      window.renderMemory({ bookId: "a-book" });
    });
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.getByRole("button", { name: "Resume same quote request" }).click();
    await page.getByRole("button", { name: "Use this draft" }).waitFor();
    const description = page.getByRole("textbox", { name: "Book description", exact: true });
    await expect(description).toHaveValue("Saved metadata");
    await page.getByRole("button", { name: "Use this draft" }).click();
    await expect(description).toHaveValue("A recovered author-reviewed description with sufficient saved evidence.");
    await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(1);
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.method !== "GET").length), 1, "only read-only key recovery may be sent; using a draft must not save");
  } finally { await page.close(); }
});

test("late drafting prefill is shown without counting and does not replace a pending brief", async () => {
  const page = await fixture();
  try {
    await page.evaluate(input => window.renderPanel(input), props());
    await expect(page.getByRole("button", { name: "Prepare usage quote" })).toBeDisabled();
    await page.evaluate(input => window.renderPanel({ ...input, initialDraftInstruction: "Continue the silver moon scene." }), props());
    await expect(page.getByRole("textbox", { name: "Drafting instruction", exact: true })).toHaveValue("Continue the silver moon scene.");
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.operation).length), 0);
    await page.evaluate(() => {
      window.api.createAiReviewQuote = async () => { throw new Error("Count reply lost"); };
    });
    await page.getByRole("checkbox", { name: /I agree to send the selected saved chapter/ }).check();
    await page.getByRole("button", { name: "Prepare usage quote" }).click();
    await page.getByText("Count reply lost", { exact: true }).waitFor();
    await page.evaluate(input => window.renderPanel({ ...input, initialDraftInstruction: "Changed plan must not replace original pending brief." }), props());
    await expect(page.getByRole("textbox", { name: "Drafting instruction", exact: true })).toHaveValue("Continue the silver moon scene.");
    await page.getByText(/This saved plan no longer matches the pending AI request/).waitFor();
  } finally { await page.close(); }
});

test("generic AI quote 409 preserves the original key and retries only its original body", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.api.createAiReviewQuote = async (_book, body) => {
        window.calls.push({ operation: "review-create", body });
        if (window.calls.filter(call => call.operation === "review-create").length === 1) throw window.apiError(409, "Original request outcome is unknown");
        return { quote: { requestId: "11111111-1111-4111-8111-111111111111", status: "ready", agentType: "writer", model: "approved",
          countedInputTokens: 3100, maxOutputTokens: 6000, reservedCredits: 24, expiresAt: "2030-01-01T00:00:00.000Z" } };
      };
      window.api.getAiJobByRequest = async (_book, key) => {
        window.calls.push({ operation: "review-key-read", key }); throw window.apiError(404, "No accepted job");
      };
    });
    await page.evaluate(input => window.renderPanel({ ...input, initialDraftInstruction: "Continue the silver moon scene." }), props());
    await expect(page.getByRole("textbox", { name: "Drafting instruction", exact: true })).toHaveValue("Continue the silver moon scene.");
    await page.getByRole("checkbox", { name: /I agree to send the selected saved chapter/ }).check();
    await page.getByRole("button", { name: "Prepare usage quote" }).click();
    await page.getByText("Original request outcome is unknown", { exact: true }).waitFor();
    const key = "bookworm:ai-review:00000000-0000-4000-8000-000000000001:a-book:a-chapter";
    const original = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), key);
    assert.match(original.key, /^[0-9a-f-]{36}$/i);
    assert.equal(JSON.stringify(original).includes("silver moon"), false, "recovery stores only the brief digest, never its private text");
    await expect(page.getByRole("combobox", { name: "Task", exact: true })).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Usage-priced model", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Recover original quote" }).click();
    await page.getByRole("button", { name: "Accept · 24 credits" }).waitFor();
    const calls = await page.evaluate(() => window.calls.filter(call => call.operation));
    assert.deepEqual(calls.map(call => call.operation), ["review-create", "review-key-read", "review-create"]);
    assert.equal(calls[1].key, original.key);
    assert.deepEqual(calls[2].body, calls[0].body);
    assert.equal(calls.some(call => call.operation === "review-accept"), false);
    const recovered = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), key);
    assert.equal(recovered.key, original.key);
    assert.equal(recovered.quoteRequestId, "11111111-1111-4111-8111-111111111111");
  } finally { await page.close(); }
});

test("AI quote storage failure blocks token counting and paid acceptance", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.api.createAiReviewQuote = async (_book, body) => { window.calls.push({ operation: "review-create", body }); return { quote: {
        requestId: "11111111-1111-4111-8111-111111111111", status: "ready", agentType: "proofreader", model: "approved",
        countedInputTokens: 3100, maxOutputTokens: 6000, reservedCredits: 24, expiresAt: "2030-01-01T00:00:00.000Z" } }; };
      window.api.acceptAiReviewQuote = async () => { window.calls.push({ operation: "review-accept" }); throw new Error("Acceptance should be blocked"); };
      window.api.getAiReviewQuote = async () => { throw new Error("Recovery offline"); };
      window.originalStorageSet = Storage.prototype.setItem;
    });
    await page.evaluate(input => window.renderPanel(input), props());
    await page.getByRole("checkbox", { name: /I agree to send the selected saved chapter/ }).check();
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("Storage blocked"); }; });
    await page.getByRole("button", { name: "Prepare usage quote" }).click();
    await page.getByText("Browser recovery storage is unavailable. No paid AI request was sent.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.operation).length), 0);
    await page.evaluate(() => { Storage.prototype.setItem = window.originalStorageSet; });
    await page.getByRole("button", { name: "Prepare usage quote" }).click();
    const accept = page.getByRole("button", { name: "Accept · 24 credits" });
    await accept.waitFor();
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("Storage blocked again"); }; });
    await accept.click();
    await page.getByRole("button", { name: "Recover acceptance status" }).waitFor();
    await expect(accept).toBeDisabled();
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.operation === "review-accept").length), 0);
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.operation === "review-create").length), 1);
  } finally { await page.close(); }
});

test("ready drafting quote locks the visible instruction until its saved outcome is resolved", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.api.createAiReviewQuote = async (_book, body) => { window.calls.push({ operation: "review-create", body }); return { quote: {
        requestId: "11111111-1111-4111-8111-111111111111", status: "ready", agentType: "writer", model: "approved",
        countedInputTokens: 3100, maxOutputTokens: 6000, reservedCredits: 24, expiresAt: "2030-01-01T00:00:00.000Z" } }; };
    });
    await page.evaluate(input => window.renderPanel({ ...input, initialDraftInstruction: "Continue the silver moon scene." }), props());
    const instruction = page.getByRole("textbox", { name: "Drafting instruction", exact: true });
    await expect(instruction).toHaveValue("Continue the silver moon scene.");
    await page.getByRole("checkbox", { name: /I agree to send the selected saved chapter/ }).check();
    await page.getByRole("button", { name: "Prepare usage quote" }).click();
    await page.getByRole("button", { name: "Accept · 24 credits" }).waitFor();
    await expect(instruction).toBeDisabled();
    await expect(instruction).toHaveValue("Continue the silver moon scene.");
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.operation).length), 1);
  } finally { await page.close(); }
});

test("late Book Bible reading plan cannot attach another book's saved chapter batches", async () => {
  const page = await fixture();
  try {
    await memoryFixture(page);
    await page.evaluate(() => {
      window.memoryFetch = path => path.endsWith("/bible/reading-plan") ? window.defer("reading-a") : undefined;
      window.renderMemory({ bookId: "a-book" });
    });
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.getByRole("button", { name: "Prepare reading batches · no credits" }).click();
    await page.waitForFunction(() => !!window.gates["reading-a"]);
    await page.evaluate(() => {
      window.memory.book.id = "b-book"; window.memory.metadata.description = "Saved metadata for book B";
      window.memory.chapters = [{ id: "b-chapter", title: "Book B chapter", current_document_version_id: "b-version" }];
      window.renderMemory({ bookId: "b-book" });
    });
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveValue("Saved metadata for book B");
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await page.evaluate(() => window.gates["reading-a"].resolve(Response.json({ fingerprint: "a".repeat(64), pages: [{ pageIndex: 0, bytes: 12, completedJobId: null }] })));
    await expect(page.getByRole("combobox", { name: /Reading batch ·/ })).toHaveCount(0);
    await expect(page.getByText("Saved-version reading plan prepared. No generation or credit charge occurred.", { exact: true })).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.path.endsWith("/bible/reading-plan")).length), 1);
  } finally { await page.close(); }
});

test("late Book Bible acceptance cannot revoke a newly selected book's explicit consent", async () => {
  const page = await fixture();
  try {
    await memoryFixture(page);
    await page.evaluate(() => {
      window.memoryFetch = async path => {
        if (path.endsWith("/bible/quotes")) {
          const requestId = path.includes("/a-book/") ? "a-request" : "b-request";
          return Response.json({ request: { id: requestId, status: "ready" }, quote: { requestId, status: "ready", model: "approved",
            countedInputTokens: 1200, maxOutputTokens: 6000, reservedCredits: 23, expiresAt: "2030-01-01T00:00:00.000Z" }, job: null });
        }
        if (path.endsWith("/bible/quotes/a-request/accept")) return window.defer("accept-a");
        if (path.endsWith("/bible/quotes/a-request")) return Response.json({ request: { id: "a-request", status: "ready" }, quote: null, job: { id: "a-job", status: "queued" } });
      };
      window.renderMemory({ bookId: "a-book" });
    });
    const countConsent = page.getByRole("checkbox", { name: /I agree to send the selected saved manuscript batch/ });
    const consent = page.getByRole("checkbox", { name: /I approve this quote and authorize one candidate extraction/ });
    const accept = page.getByRole("button", { name: "Accept quote and start extraction" });
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await countConsent.check(); await page.getByRole("button", { name: "Count tokens and request quote" }).click();
    await consent.check(); await accept.click(); await page.waitForFunction(() => !!window.gates["accept-a"]);
    await page.evaluate(() => {
      window.memory.book.id = "b-book"; window.memory.metadata.description = "Saved metadata for book B";
      window.memory.chapters = [{ id: "b-chapter", title: "Book B chapter", current_document_version_id: "b-version" }];
      window.renderMemory({ bookId: "b-book" });
    });
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveValue("Saved metadata for book B");
    await expect(page.getByRole("button", { name: "Reload saved data" })).toBeEnabled();
    await countConsent.check(); await page.getByRole("button", { name: "Count tokens and request quote" }).click();
    await consent.check(); await expect(accept).toBeEnabled();
    await page.evaluate(() => window.gates["accept-a"].resolve(Response.json({ jobId: "a-job", status: "queued" })));
    await expect(consent).toBeChecked(); await expect(accept).toBeEnabled();
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.path.endsWith("/bible/quotes/a-request")).length), 0);
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.path.endsWith("/accept")).length), 1);
  } finally { await page.close(); }
});
