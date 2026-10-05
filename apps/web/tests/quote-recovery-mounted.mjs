// Standalone local component acceptance: no Next server, listener or provider.
// Run: node --test apps/web/tests/quote-recovery-mounted.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

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
    window.renderMemory = props => root.render(React.createElement(Memory, props));`, resolveDir: process.cwd(), loader: "tsx" },
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
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
test.after(() => browser.close());

async function fixture() {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  // Every request is fulfilled in memory, including the initial trusted origin.
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://127.0.0.1/bookworm-component-fixture");
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
