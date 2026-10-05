// Actual mounted component/CSS with in-memory transports. No Next server or provider.
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const bundle = await build({
  stdin: { contents: `import React from "react"; import { createRoot } from "react-dom/client";
    import Studio from "./apps/web/components/NarrationQuoteStudio.tsx";
    import Publishing from "./apps/web/components/PublishingStudio.tsx";
    import { ApiClientError } from "@bookworm/api-client";
    window.ApiClientError = ApiClientError;
    const root = createRoot(document.getElementById("root"));
    window.renderStudio = props => root.render(React.createElement(Studio, props));
    window.renderPublishing = bookId => root.render(React.createElement(Publishing, { bookId }));
    window.unmountStudio = () => root.render(null);`, resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", outdir: "memory",
  plugins: [{ name: "local-api-fixture", setup(builder) {
    builder.onResolve({ filter: /^\.\/api$/ }, args => args.importer.replaceAll("\\", "/").includes(resolve("apps/web/components").replaceAll("\\", "/"))
      ? { path: "api", namespace: "fixture" } : undefined);
    builder.onLoad({ filter: /^api$/, namespace: "fixture" }, () => ({ contents: "export const apiClient = () => window.api;" }));
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
    builder.onLoad({ filter: /^link$/, namespace: "fixture" }, () => ({ contents: 'import React from "react"; export default props => React.createElement("a", props);', resolveDir: process.cwd() }));
  } }],
});
const script = bundle.outputFiles.find(file => file.path.endsWith(".js")).text;
const css = bundle.outputFiles.find(file => file.path.endsWith(".css")).text;
const font = await readFile("apps/web/app/fonts/instrument-serif-italic.ttf");
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
test.after(() => browser.close());
const uuid = n => `a6700000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = uuid(1), WORKSPACE = uuid(2), BOOK = uuid(3), EDITION = uuid(4), CHAPTER = uuid(5), DOCUMENT = uuid(6), QUOTE = uuid(7);
const props = (overrides = {}) => ({ workspaceId: WORKSPACE, bookId: BOOK, editionId: EDITION, chapterId: CHAPTER,
  chapters: [{ id: CHAPTER, title: "The city after rain", current_document_version_id: DOCUMENT, order_index: 0 }],
  voice: "marin", speed: 1, instructions: "PRIVATE-VOICE-DIRECTION", canEdit: true, disabled: false, ...overrides });
const key = (book = BOOK, edition = EDITION, user = USER) => `bookworm.narration-chapter-quote.v1:${user}:${WORKSPACE}:${book}:${edition}`;

async function fixture({ publishing = false } = {}) {
  const page = await browser.newPage(); page.setDefaultTimeout(6000);
  await page.route("**/*", route => route.request().url().endsWith("/bookworm-font")
    ? route.fulfill({ contentType: "font/ttf", body: font }) : route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://127.0.0.1/bookworm-narration-component-fixture");
  await page.addStyleTag({ content: `@font-face {font-family: Instrument;src:url('/bookworm-font')} html {background:#050505;--font-instrument-serif:Instrument}
    body {color:#f5f5f1;max-width:1040px;margin:48px auto;padding:0 16px;font-family:Arial,sans-serif} * {box-sizing:border-box} ${css}` });
  await page.evaluate(({ USER, WORKSPACE, BOOK, EDITION, CHAPTER, DOCUMENT, QUOTE, child1, child2, publishing }) => {
    window.calls = []; window.gates = {}; window.account = USER; window.notified = []; window.acceptance = null;
    window.defer = name => new Promise((resolve, reject) => { window.gates[name] = { resolve, reject }; });
    window.offer = { quoteId: QUOTE, purchaseAvailable: false, pricingBasis: "maximum_token_budget", modelId: "mini", model: "gpt-realtime-2.1-mini",
      voice: "marin", speed: 1, source: { bookId: BOOK, editionId: EDITION, chapterId: CHAPTER, documentVersionId: DOCUMENT }, segmentCount: 2,
      segments: [{ quoteId: child1, segmentIndex: 0, textStart: 0, textEnd: 1800, reservedCredits: "1612" },
        { quoteId: child2, segmentIndex: 1, textStart: 1800, textEnd: 3000, reservedCredits: "1612" }],
      reservedCredits: "3224", priceVersion: "synthetic", policyVersion: "synthetic", expiresAt: "2030-01-01T00:00:00.000Z", expired: false };
    window.fetch = async path => {
      if (path !== "/api/auth/session") throw new Error(`Unexpected request ${path}`);
      return Response.json({ user: { id: window.account } });
    };
    window.api = {
      listNarrationModels: async () => ({ models: [{ id: "mini", label: "Mini narration", model: "gpt-realtime-2.1-mini" }], purchaseAvailable: window.offer.purchaseAvailable }),
      createNarrationChapterQuote: async (workspace, body) => {
        window.calls.push({ operation: "save", workspace, body, stored: Object.keys(sessionStorage).map(key => sessionStorage.getItem(key)) });
        if (window.createOverride) return window.createOverride(workspace, body);
        return window.offer;
      },
      recoverNarrationChapterQuote: async (workspace, key) => { window.calls.push({ operation: "recover", workspace, key });
        return window.recoverOverride ? window.recoverOverride(workspace, key) : window.offer; },
      getNarrationChapterQuote: async (workspace, id) => { window.calls.push({ operation: "get", workspace, id }); return window.offer; },
      getNarrationChapterAcceptance: async (workspace, id) => { window.calls.push({ operation: "status", workspace, id });
        return window.statusOverride ? window.statusOverride(workspace, id) : window.acceptance ?? { quoteId: id, accepted: false, project: null }; },
      acceptNarrationChapterQuote: async (workspace, id, body) => {
        window.calls.push({ operation: "accept", workspace, id, body, stored: Object.keys(sessionStorage).map(key => sessionStorage.getItem(key)) });
        if (window.acceptOverride) return window.acceptOverride(workspace, id, body);
        window.acceptance = { quoteId: id, accepted: true, project: { id: 'a6700000-0000-4000-8000-000000000020',
          billingMode: "quoted", status: "queued", reservedCredits: window.offer.reservedCredits } };
        return window.acceptance;
      },
    };
    if (publishing) {
      const id = n => `a6700000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      window.parentCalls = [];
      window.chapters = [{ id: CHAPTER, book_id: BOOK, title: "The city after rain", order_index: 0, current_document_version_id: DOCUMENT },
        { id: id(10), book_id: BOOK, title: "The morning ferry", order_index: 1, current_document_version_id: id(11) }];
      const edition = (editionId, language) => ({ id: editionId, book_id: BOOK, type: "audiobook", language, status: "draft", updated_at: "2026-10-05T00:00:00Z",
        edition_metadata_json: { kind: "audiobook", voice: "marin", instructions: "PRIVATE-VOICE-DIRECTION", speed: 1 } });
      window.editions = [edition(EDITION, "en"), edition(id(14), "fr")];
      window.project = { id: id(20), editionId: EDITION, chapterId: CHAPTER, documentVersionId: DOCUMENT,
        voice: "marin", speed: 1, billingMode: "operational", status: "queued", segmentCount: 2, creditUnits: 5, createdAt: "2026-10-05T00:00:00Z",
        completedAt: null, aiVoiceDisclosureRequired: true, segments: [] };
      window.projects = [window.project];
      Object.assign(window.api, {
        getBook: async bookId => window.bookOverride ? window.bookOverride(bookId) : ({ book: { id: bookId, workspace_id: WORKSPACE, title: "Rain City", language: "en" }, role: "writer" }),
        listEditions: async () => ({ editions: window.editions }),
        listPublishingJobs: async () => ({ jobs: [] }),
        listChapters: async () => ({ chapters: window.chapters }),
        listAssets: async () => ({ assets: [] }),
        listAudiobookProjects: async editionId => {
          window.parentCalls.push({ operation: "history", editionId });
          return window.historyOverride ? window.historyOverride(editionId) : ({ projects: editionId === EDITION ? window.projects : [] });
        },
        listAudiobookGooglePlayExports: async () => ({ jobs: [] }),
      });
      window.createOverride = async (_workspace, body) => ({ ...window.offer, source: { ...window.offer.source, chapterId: body.chapterId,
        documentVersionId: window.chapters.find(chapter => chapter.id === body.chapterId).current_document_version_id } });
    }
  }, { USER, WORKSPACE, BOOK, EDITION, CHAPTER, DOCUMENT, QUOTE, child1: uuid(8), child2: uuid(9), publishing });
  await page.addScriptTag({ content: script });
  return page;
}
const render = (page, value = props()) => page.evaluate(value => window.renderStudio({ ...value, onAccepted: id => window.notified.push(id) }), value);
const prepare = async page => {
  const consent = page.getByRole("checkbox"); await expect(consent).toBeEnabled(); await consent.check();
  await page.getByRole("button", { name: "Review full chapter price" }).click();
};
const confirmPurchase = async page => {
  await page.getByRole("checkbox", { name: /AI-generated voice/ }).check();
  await page.getByRole("checkbox", { name: /Authorize up to/ }).check();
};
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test("mounted chapter review stores only opaque recovery identity before saving, displays every part and never dispatches", async () => {
  const page = await fixture();
  try {
    await render(page); await prepare(page);
    await expect(page.getByText("3,224", { exact: false })).toBeVisible();
    await page.getByText("2 ordered parts · full saved chapter").click();
    await expect(page.getByText("Source range 1800–3000")).toBeVisible();
    const calls = await page.evaluate(() => window.calls);
    assert.equal(calls.length, 2); assert.equal(calls[0].operation, "save"); assert.equal(calls[1].operation, "status");
    assert.equal(calls[0].body.instructions, "PRIVATE-VOICE-DIRECTION");
    assert.equal(calls[0].body.consentToQuoteStorage, true);
    assert.deepEqual(JSON.parse(calls[0].stored[0]), { idempotencyKey: calls[0].body.idempotencyKey });
    const saved = JSON.parse(await page.evaluate(key => sessionStorage.getItem(key), key()));
    assert.deepEqual(Object.keys(saved).sort(), ["idempotencyKey", "quoteId"]);
    assert.equal(saved.quoteId, QUOTE);
    await expect(page.getByText("Paid narration not enabled", { exact: true })).toBeVisible();
    await expect(page.getByText("Not charged or reserved.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Refresh saved offer" }).click();
    assert.equal((await page.evaluate(() => window.calls)).filter(call => call.operation === "save").length, 1);
    assert(!JSON.stringify(saved).includes("PRIVATE"));
  } finally { await page.close(); }
});

test("lost offer reply recovers the same complete chapter using only the saved key, even without current prices", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.createOverride = async () => { throw new Error("Save reply lost"); }; });
    await render(page); await prepare(page);
    await expect(page.getByRole("alert")).toContainText("Save reply lost");
    await expect(page.getByRole("button", { name: "Review full chapter price" })).toHaveCount(0);
    await page.getByRole("button", { name: "Recover original offer" }).click();
    await expect(page.getByText("3,224", { exact: false })).toBeVisible();
    const calls = await page.evaluate(() => window.calls);
    assert.deepEqual(calls.map(call => call.operation), ["save", "recover", "status"]);
    assert.equal(calls[1].key, calls[0].body.idempotencyKey);
    await page.evaluate(() => { window.unmountStudio(); window.api.listNarrationModels = async () => { throw new Error("Catalog unavailable"); }; });
    await expect(page.getByRole("heading", { name: "A voice for every word." })).toHaveCount(0);
    await render(page);
    await expect(page.getByText("3,224", { exact: false })).toBeVisible();
    assert.deepEqual((await page.evaluate(() => window.calls)).map(call => call.operation), ["save", "recover", "status", "get", "status"]);
  } finally { await page.close(); }
});

test("cold recovery works with unavailable catalog and preserves original source and private settings", async () => {
  const page = await fixture();
  try {
    await page.evaluate(key => { sessionStorage.setItem(key, JSON.stringify({ idempotencyKey: "original-private-key" }));
      window.api.listNarrationModels = async () => { throw new Error("Catalog unavailable"); }; }, key());
    await render(page);
    await expect(page.getByText("3,224", { exact: false })).toBeVisible();
    assert.deepEqual((await page.evaluate(() => window.calls)).map(call => call.operation), ["recover", "status"]);
    await expect(page.getByText("Approved narration prices are unavailable.", { exact: false })).toBeVisible();
    await expect(page.getByText("PRIVATE-VOICE-DIRECTION")).toHaveCount(0);
  } finally { await page.close(); }
});

test("storage write failure and malformed reply cannot create another offer or bypass read-only recovery", async () => {
  const page = await fixture();
  try {
    await render(page); await expect(page.getByRole("checkbox")).toBeEnabled();
    await page.evaluate(() => { window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error("Recovery storage unavailable"); }; });
    await prepare(page); await expect(page.getByRole("alert")).toContainText("Recovery storage unavailable");
    assert.equal((await page.evaluate(() => window.calls)).length, 0);
    await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; window.offer.reservedCredits = "1"; });
    await page.getByRole("button", { name: "Review full chapter price" }).click();
    await expect(page.getByRole("alert")).toContainText("could not be verified");
    await expect(page.getByRole("button", { name: "Recover original offer" })).toBeEnabled();
    assert.equal((await page.evaluate(() => window.calls)).filter(call => call.operation === "save").length, 1);
  } finally { await page.close(); }
});

test("late reply from another book cannot overwrite this book's offer or recovery pointer", async () => {
  const page = await fixture();
  try {
    await page.evaluate(key => { sessionStorage.setItem(key, JSON.stringify({ idempotencyKey: "old-book-key" }));
      window.recoverOverride = async () => window.defer("old"); }, key());
    await render(page); await expect.poll(() => page.evaluate(() => Boolean(window.gates.old))).toBe(true);
    await page.evaluate(({ BOOK, EDITION, QUOTE }) => { window.offer.source.bookId = BOOK; window.offer.source.editionId = EDITION; window.offer.quoteId = QUOTE; },
      { BOOK: uuid(13), EDITION: uuid(14), QUOTE: uuid(17) });
    await render(page, props({ bookId: uuid(13), editionId: uuid(14) })); await prepare(page);
    await expect(page.getByText("3,224", { exact: false })).toBeVisible();
    await page.evaluate(() => window.gates.old.resolve({ ...window.offer, quoteId: "a6700000-0000-4000-8000-000000000007",
      source: { ...window.offer.source, bookId: "a6700000-0000-4000-8000-000000000003", editionId: "a6700000-0000-4000-8000-000000000004" } }));
    const current = JSON.parse(await page.evaluate(key => sessionStorage.getItem(key), key(uuid(13), uuid(14))));
    assert.equal(current.quoteId, uuid(17));
    assert.equal(JSON.parse(await page.evaluate(key => sessionStorage.getItem(key), key())).quoteId, undefined);
  } finally { await page.close(); }
});

test("read-only members recover their own offers but cannot save new ones", async () => {
  const page = await fixture();
  try {
    await page.evaluate(key => sessionStorage.setItem(key, JSON.stringify({ quoteId: "a6700000-0000-4000-8000-000000000007" })), key());
    await render(page, props({ canEdit: false })); await expect(page.getByText("3,224", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Prepare another offer" }).click();
    await expect(page.getByRole("checkbox")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Review full chapter price" })).toBeDisabled();
    assert.equal((await page.evaluate(() => window.calls)).filter(call => call.operation === "save").length, 0);
  } finally { await page.close(); }
});

test("another authenticated account never consumes the previous account's offer pointer", async () => {
  const page = await fixture();
  try {
    await page.evaluate(({ key, account }) => {
      sessionStorage.setItem(key, JSON.stringify({ quoteId: "a6700000-0000-4000-8000-000000000007" })); window.account = account;
    }, { key: key(), account: uuid(11) });
    await render(page, props({ canEdit: false }));
    await expect(page.getByRole("checkbox")).toBeDisabled();
    await expect(page.getByText("3,224", { exact: false })).toHaveCount(0);
    assert.equal((await page.evaluate(() => window.calls)).length, 0);
    assert.equal(JSON.parse(await page.evaluate(key => sessionStorage.getItem(key), key())).quoteId, QUOTE);
  } finally { await page.close(); }
});

test("rapid clicks save once and an in-flight permission downgrade cannot reopen writing", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.createOverride = () => window.defer("save"); });
    await render(page); await expect(page.getByRole("checkbox")).toBeEnabled(); await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Review full chapter price" }).evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => page.evaluate(() => window.calls.filter(call => call.operation === "save").length)).toBe(1);
    await render(page, props({ canEdit: false }));
    await page.evaluate(() => window.gates.save.resolve(window.offer));
    await expect(page.getByText("3,224", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Prepare another offer" }).click();
    await expect(page.getByRole("checkbox")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Review full chapter price" })).toBeDisabled();
    assert.equal((await page.evaluate(() => window.calls)).filter(call => call.operation === "save").length, 1);
  } finally { await page.close(); }
});

test("unmount during save preserves the original key and recovers without a replacement write", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.createOverride = () => window.defer("save"); });
    await render(page); await prepare(page);
    await expect.poll(() => page.evaluate(() => Boolean(window.gates.save))).toBe(true);
    const saved = JSON.parse(await page.evaluate(key => sessionStorage.getItem(key), key()));
    await page.evaluate(() => window.unmountStudio());
    await expect(page.getByRole("heading", { name: "A voice for every word." })).toHaveCount(0);
    await page.evaluate(() => window.gates.save.resolve(window.offer));
    assert.deepEqual(JSON.parse(await page.evaluate(key => sessionStorage.getItem(key), key())), saved);
    await render(page); await expect(page.getByText("3,224", { exact: false })).toBeVisible();
    const calls = await page.evaluate(() => window.calls);
    assert.deepEqual(calls.map(call => call.operation), ["save", "recover", "status"]);
    assert.equal(calls[1].key, saved.idempotencyKey);
  } finally { await page.close(); }
});

test("Publishing Studio keeps chapter selection/history/export and uses only full-chapter quote review", async () => {
  const page = await fixture({ publishing: true });
  try {
    await page.evaluate(bookId => window.renderPublishing(bookId), BOOK);
    const chapter = page.getByRole("combobox", { name: "Saved chapter" });
    await expect(chapter).toBeEnabled();
    await expect(page.getByRole("button", { name: "Generate chapter narration" })).toHaveCount(0);
    await expect(page.getByText("One audio credit covers up to 1,000 source characters.", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Model: gpt-4o-mini-tts", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Narration history" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Google Play export · private download" })).toBeVisible();
    await chapter.selectOption(uuid(10));
    await prepare(page); await expect(page.getByText("3,224", { exact: false })).toBeVisible();
    const calls = await page.evaluate(() => window.calls);
    assert.equal(calls.length, 2); assert.equal(calls[0].body.chapterId, uuid(10));
    await expect(page.getByText("The morning ferry · gpt-realtime-2.1-mini", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Refresh progress" }).click();
    assert.equal((await page.evaluate(() => window.calls)).filter(call => call.operation === "save").length, 1);
    await expect(page.getByText("Paid narration not enabled", { exact: true })).toBeVisible();
  } finally { await page.close(); }
});

test("a late edition history response cannot replace the current edition's saved narration", async () => {
  const page = await fixture({ publishing: true });
  try {
    await page.evaluate(bookId => window.renderPublishing(bookId), BOOK);
    await expect(page.getByRole("combobox", { name: "Saved chapter" })).toBeEnabled();
    await page.evaluate(edition => { window.historyOverride = id => id === edition ? window.defer("history") : Promise.resolve({ projects: [window.project] }); }, uuid(14));
    await page.getByRole("button", { name: /audiobook.*fr/ }).click();
    await expect.poll(() => page.evaluate(() => Boolean(window.gates.history))).toBe(true);
    await page.getByRole("button", { name: /audiobook.*en/ }).click();
    await page.evaluate(({ chapter, edition, project }) => window.gates.history.resolve({ projects: [{ ...window.project, id: project, editionId: edition, chapterId: chapter }] }),
      { chapter: uuid(10), edition: uuid(14), project: uuid(30) });
    const history = page.getByRole("heading", { name: "Narration history" }).locator("..");
    await expect(history.getByText("The city after rain", { exact: true })).toBeVisible();
    await expect(history.getByText("The morning ferry", { exact: true })).toHaveCount(0);
  } finally { await page.close(); }
});

test("a late prior-book load cannot replace current edition or narration scope", async () => {
  const page = await fixture({ publishing: true });
  try {
    await page.evaluate(({ oldBook, newBook, workspace }) => {
      window.bookOverride = bookId => bookId === oldBook ? window.defer("book")
        : Promise.resolve({ book: { id: newBook, workspace_id: workspace, language: "fr" }, role: "writer" });
      window.api.listEditions = async bookId => ({ editions: bookId === oldBook ? window.editions : [] });
    }, { oldBook: BOOK, newBook: uuid(13), workspace: WORKSPACE });
    await page.evaluate(bookId => window.renderPublishing(bookId), BOOK);
    await expect.poll(() => page.evaluate(() => Boolean(window.gates.book))).toBe(true);
    await page.evaluate(bookId => window.renderPublishing(bookId), uuid(13));
    await expect(page.getByRole("textbox", { name: "Language", exact: true })).toHaveValue("fr");
    await page.evaluate(({ oldBook, workspace }) => window.gates.book.resolve({ book: { id: oldBook, workspace_id: workspace, language: "en" }, role: "writer" }),
      { oldBook: BOOK, workspace: WORKSPACE });
    await expect(page.getByRole("combobox", { name: "Format", exact: true })).toHaveValue("ebook");
    await expect(page.getByRole("textbox", { name: "Language", exact: true })).toHaveValue("fr");
    await expect(page.getByRole("heading", { name: "A voice for every word." })).toHaveCount(0);
  } finally { await page.close(); }
});

test("actual component CSS fits mobile/tablet/desktop, exposes keyboard focus and honours reduced motion", async () => {
  const page = await fixture();
  try {
    await render(page); await prepare(page); await expect(page.getByText("3,224", { exact: false })).toBeVisible();
    await page.getByText("2 ordered parts · full saved chapter").click();
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}px`);
      const refresh = page.getByRole("button", { name: "Refresh saved offer" });
      await page.keyboard.press("Tab"); await refresh.focus();
      assert.equal(await refresh.evaluate(element => getComputedStyle(element).outlineWidth), "2px");
      if ([375, 1440].includes(width)) await page.screenshot({ path: `.git/bookworm-tracking/narration-chapter-${width}-20261005.png`, fullPage: true });
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.getByRole("button", { name: "Refresh saved offer" }).evaluate(element => getComputedStyle(element).transitionDuration), "0s");
  } finally { await page.close(); }
});

test("paid chapter requires two separate consents, persists its attempt first and accepts only once", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.offer.purchaseAvailable = true; });
    await render(page); await prepare(page);
    const purchase = page.getByRole("button", { name: "Accept & generate chapter" });
    await expect(purchase).toBeDisabled();
    await page.getByRole("checkbox", { name: /AI-generated voice/ }).check();
    await expect(purchase).toBeDisabled();
    await page.getByRole("checkbox", { name: /Authorize up to 3,224/ }).check();
    await purchase.evaluate(button => { button.click(); button.click(); });
    await expect(page.getByText("Accepted narration · queued", { exact: true })).toBeVisible();
    const writes = (await page.evaluate(() => window.calls)).filter(call => call.operation === "accept");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].body, { expectedCredits: "3224", consentToAiVoice: true, consentToGenerate: true });
    assert.equal(writes[0].id, QUOTE);
    assert.deepEqual(JSON.parse(writes[0].stored[0]), { idempotencyKey: JSON.parse(writes[0].stored[0]).idempotencyKey, quoteId: QUOTE, purchaseAttempted: true });
    assert(!writes[0].stored[0].includes("PRIVATE"));
    assert.deepEqual(await page.evaluate(() => window.notified), [uuid(20)]);
  } finally { await page.close(); }
});

test("uncertain purchase survives reload and false status without reopening writes, then recovers the original", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.offer.purchaseAvailable = true;
      window.acceptOverride = async () => { throw new Error("Purchase reply lost"); };
    });
    await render(page); await prepare(page); await confirmPurchase(page);
    await page.getByRole("button", { name: "Accept & generate chapter" }).click();
    await expect(page.getByRole("alert")).toContainText("unconfirmed");
    await page.getByRole("button", { name: "Refresh saved offer" }).click();
    await expect(page.getByRole("button", { name: "Prepare another offer" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Accept & generate chapter" })).toBeDisabled();
    await page.evaluate(() => window.unmountStudio());
    await expect(page.getByRole("heading", { name: "A voice for every word." })).toHaveCount(0);
    await render(page);
    await expect(page.getByRole("button", { name: "Prepare another offer" })).toBeDisabled();
    await page.evaluate(({ quote, project }) => { window.acceptance = { quoteId: quote, accepted: true,
      project: { id: project, billingMode: "quoted", status: "running", reservedCredits: "3224" } };
      window.api.listNarrationModels = async () => { throw new Error("Catalog closed"); }; window.offer.purchaseAvailable = false;
    }, { quote: QUOTE, project: uuid(20) });
    await page.getByRole("button", { name: "Refresh saved offer" }).click();
    await expect(page.getByText("Accepted narration · running", { exact: true })).toBeVisible();
    const calls = await page.evaluate(() => window.calls);
    assert.equal(calls.filter(call => call.operation === "accept").length, 1);
    assert.equal(calls.filter(call => call.operation === "save").length, 1);
    assert.equal(JSON.parse(await page.evaluate(key => sessionStorage.getItem(key), key())).purchaseAttempted, true);
  } finally { await page.close(); }
});

test("unknown or malformed status blocks purchases and replacement offers until verified read-only recovery", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.offer.purchaseAvailable = true; window.statusOverride = async () => { throw new Error("Status unavailable"); }; });
    await render(page); await prepare(page);
    await expect(page.getByRole("alert")).toContainText("Status unavailable");
    await expect(page.getByRole("button", { name: "Accept & generate chapter" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Prepare another offer" })).toBeDisabled();
    await page.evaluate(() => { window.statusOverride = async (_workspace, quoteId) => ({ quoteId, accepted: true,
      project: { id: 'a6700000-0000-4000-8000-000000000020', billingMode: "quoted", status: "queued", reservedCredits: "1" } }); });
    await page.getByRole("button", { name: "Refresh saved offer" }).click();
    await expect(page.getByRole("alert")).toContainText("unconfirmed");
    await page.evaluate(() => { delete window.statusOverride; });
    await page.getByRole("button", { name: "Refresh saved offer" }).click(); await confirmPurchase(page);
    await expect(page.getByRole("button", { name: "Accept & generate chapter" })).toBeEnabled();
    assert.equal((await page.evaluate(() => window.calls)).filter(call => call.operation === "accept").length, 0);
  } finally { await page.close(); }
});

test("purchase storage failure sends nothing; a definite rejection requires another explicit recovery and consent", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.offer.purchaseAvailable = true; });
    await render(page); await prepare(page); await confirmPurchase(page);
    await page.evaluate(() => { window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error("Storage offline"); }; });
    await page.getByRole("button", { name: "Accept & generate chapter" }).click();
    await expect(page.getByRole("alert")).toContainText("Storage offline");
    assert.equal((await page.evaluate(() => window.calls)).filter(call => call.operation === "accept").length, 0);
    await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem;
      window.acceptOverride = async () => { throw new window.ApiClientError(409, "conflict", "Credits changed", "synthetic"); }; });
    await confirmPurchase(page); await page.getByRole("button", { name: "Accept & generate chapter" }).click();
    await expect(page.getByRole("alert")).toContainText("Credits changed");
    await expect(page.getByRole("button", { name: "Accept & generate chapter" })).toBeDisabled();
    await page.getByRole("button", { name: "Refresh saved offer" }).click();
    await expect(page.getByRole("checkbox", { name: /Authorize up to/ })).not.toBeChecked();
    await confirmPurchase(page); await expect(page.getByRole("button", { name: "Accept & generate chapter" })).toBeEnabled();
    assert.equal((await page.evaluate(() => window.calls)).filter(call => call.operation === "accept").length, 1);
  } finally { await page.close(); }
});

test("settings changes reset consent; expired, dirty and read-only views cannot purchase", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.offer.purchaseAvailable = true; });
    await render(page); await prepare(page); await confirmPurchase(page);
    await render(page, props({ instructions: "Changed voice direction" }));
    await expect(page.getByRole("checkbox", { name: /Authorize up to/ })).not.toBeChecked();
    await render(page, props({ disabled: true }));
    await expect(page.getByRole("checkbox", { name: /AI-generated voice/ })).toBeDisabled();
    await render(page, props({ canEdit: false }));
    await expect(page.getByRole("button", { name: "Accept & generate chapter" })).toBeDisabled();
    await render(page);
    await page.evaluate(() => { window.offer.expiresAt = "2026-01-01T00:00:00.000Z"; });
    await page.getByRole("button", { name: "Refresh saved offer" }).click();
    await expect(page.getByRole("button", { name: "Accept & generate chapter" })).toBeDisabled();
    assert.equal((await page.evaluate(() => window.calls)).filter(call => call.operation === "accept").length, 0);
  } finally { await page.close(); }
});

test("late acceptance cannot run stale callbacks after a permission downgrade", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.offer.purchaseAvailable = true; window.acceptOverride = () => window.defer("purchase"); });
    await render(page); await prepare(page); await confirmPurchase(page);
    await page.getByRole("button", { name: "Accept & generate chapter" }).click();
    await expect.poll(() => page.evaluate(() => Boolean(window.gates.purchase))).toBe(true);
    await render(page, props({ canEdit: false }));
    await page.evaluate(({ quoteId, project }) => window.gates.purchase.resolve({ quoteId, accepted: true,
      project: { id: project, billingMode: "quoted", status: "queued", reservedCredits: "3224" } }), { quoteId: QUOTE, project: uuid(20) });
    await expect(page.getByText("Accepted narration · queued", { exact: true })).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.notified), []);
    assert.equal((await page.evaluate(() => window.calls)).filter(call => call.operation === "accept").length, 1);
  } finally { await page.close(); }
});

test("cold accepted recovery remains read-only even after prices close and writing permission is lost", async () => {
  const page = await fixture();
  try {
    await page.evaluate(({ key, quote, project }) => {
      sessionStorage.setItem(key, JSON.stringify({ quoteId: quote, purchaseAttempted: true }));
      window.acceptance = { quoteId: quote, accepted: true,
        project: { id: project, billingMode: "quoted", status: "running", reservedCredits: "3224" } };
      window.api.listNarrationModels = async () => { throw new Error("Prices closed"); };
    }, { key: key(), quote: QUOTE, project: uuid(20) });
    await render(page, props({ canEdit: false }));
    await expect(page.getByText("Accepted narration · running", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept & generate chapter" })).toHaveCount(0);
    await expect(page.getByText("not the measured charge", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Refresh saved offer" }).click();
    assert.deepEqual((await page.evaluate(() => window.calls)).map(call => call.operation), ["get", "status", "get", "status"]);
    assert.equal(JSON.parse(await page.evaluate(key => sessionStorage.getItem(key), key())).purchaseAttempted, true);
  } finally { await page.close(); }
});

test("late acceptance across book, edition and unmount stays scoped and recovers the original without another POST", async () => {
  for (const change of ["book", "edition", "unmount"]) {
    const page = await fixture();
    try {
      await page.evaluate(() => { window.offer.purchaseAvailable = true; window.acceptOverride = () => window.defer("purchase"); });
      await render(page); await prepare(page); await confirmPurchase(page);
      await page.getByRole("button", { name: "Accept & generate chapter" }).click();
      await expect.poll(() => page.evaluate(() => Boolean(window.gates.purchase))).toBe(true);
      const original = await page.evaluate(key => sessionStorage.getItem(key), key());
      if (change === "unmount") {
        await page.evaluate(() => window.unmountStudio());
        await expect(page.getByRole("heading", { name: "A voice for every word." })).toHaveCount(0);
      } else {
        await render(page, props(change === "book" ? { bookId: uuid(13) } : { editionId: uuid(14) }));
        await expect(page.getByRole("checkbox", { name: /Save my private voice direction/ })).toBeEnabled();
      }
      await page.evaluate(({ quote, project }) => {
        window.acceptance = { quoteId: quote, accepted: true,
          project: { id: project, billingMode: "quoted", status: "queued", reservedCredits: "3224" } };
        window.gates.purchase.resolve(window.acceptance);
      }, { quote: QUOTE, project: uuid(20) });
      await settle(page);
      assert.deepEqual(await page.evaluate(() => window.notified), [], change);
      await expect(page.getByText("Accepted narration · queued", { exact: true })).toHaveCount(0);
      assert.equal(await page.evaluate(key => sessionStorage.getItem(key), key()), original);
      await render(page); await expect(page.getByText("Accepted narration · queued", { exact: true })).toBeVisible();
      assert.deepEqual(await page.evaluate(() => window.notified), [uuid(20)]);
      assert.equal((await page.evaluate(() => window.calls)).filter(call => call.operation === "accept").length, 1);
    } finally { await page.close(); }
  }
});

test("Publishing Studio refreshes the accepted project once and distinguishes maximum token budgets from legacy units", async () => {
  const page = await fixture({ publishing: true });
  try {
    await page.evaluate(({ bookId, projectId }) => { window.offer.purchaseAvailable = true; window.renderPublishing(bookId);
      window.acceptOverride = async (_workspace, quote) => {
        const project = { ...window.project, id: projectId, billingMode: "quoted", creditUnits: 3224 };
        window.projects = [...window.projects, project];
        window.acceptance = { quoteId: quote, accepted: true,
          project: { id: project.id, billingMode: "quoted", status: "queued", reservedCredits: "3224" } };
        return window.acceptance;
      };
    }, { bookId: BOOK, projectId: uuid(21) });
    const history = page.getByRole("heading", { name: "Narration history" }).locator("..");
    await expect(history.getByText("5 legacy audio units", { exact: false })).toBeVisible();
    await prepare(page); await confirmPurchase(page);
    await page.getByRole("button", { name: "Accept & generate chapter" }).click();
    await expect(history.getByText("Maximum budget: 3,224 token credits", { exact: false })).toBeVisible();
    await expect(history.getByText("5 legacy audio units", { exact: false })).toBeVisible();
    await expect(history.getByText("audio credits", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Accepted narration · queued", { exact: true })).toBeVisible();
    assert.equal((await page.evaluate(() => window.parentCalls)).filter(call => call.operation === "history").length, 2);
    assert.equal((await page.evaluate(() => window.calls)).filter(call => call.operation === "accept").length, 1);
  } finally { await page.close(); }
});

test("late manual history success or failure cannot replace a new book or release its loading lock", async () => {
  for (const fault of [false, true]) {
    const page = await fixture({ publishing: true });
    try {
      await page.evaluate(bookId => window.renderPublishing(bookId), BOOK);
      await expect(page.getByRole("combobox", { name: "Saved chapter" })).toBeEnabled();
      await page.evaluate(({ oldBook, newBook }) => {
        window.historyOverride = () => window.defer("manualHistory");
        window.bookOverride = bookId => bookId === newBook ? window.defer("newBook") : Promise.reject(new Error("Unexpected book"));
        window.api.listEditions = async bookId => ({ editions: bookId === oldBook ? window.editions : [] });
      }, { oldBook: BOOK, newBook: uuid(13) });
      await page.getByRole("button", { name: "Refresh progress" }).click();
      await expect.poll(() => page.evaluate(() => Boolean(window.gates.manualHistory))).toBe(true);
      await page.evaluate(bookId => window.renderPublishing(bookId), uuid(13));
      await expect.poll(() => page.evaluate(() => Boolean(window.gates.newBook))).toBe(true);
      await page.evaluate(fault => fault ? window.gates.manualHistory.reject(new Error("Old private history error"))
        : window.gates.manualHistory.resolve({ projects: [window.project] }), fault);
      await settle(page);
      assert.equal(await page.locator("fieldset").first().evaluate(element => element.disabled), true);
      await expect(page.getByRole("alert")).toHaveCount(0);
      const history = page.getByRole("heading", { name: "Narration history" }).locator("..");
      await expect(history.getByText("The city after rain", { exact: true })).toHaveCount(0);
      await page.evaluate(({ book, workspace }) => window.gates.newBook.resolve({ book: { id: book, workspace_id: workspace, language: "fr" }, role: "writer" }),
        { book: uuid(13), workspace: WORKSPACE });
      await expect(page.getByRole("textbox", { name: "Language", exact: true })).toHaveValue("fr");
      assert.equal(await page.locator("fieldset").first().evaluate(element => element.disabled), false);
      await expect(page.getByRole("heading", { name: "Narration history" })).toHaveCount(0);
    } finally { await page.close(); }
  }
});

test("paid consent panel fits narrow screens with full-size labels and visible keyboard focus", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.offer.purchaseAvailable = true; });
    await render(page); await prepare(page);
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `paid panel overflow at ${width}px`);
      const consent = page.getByRole("checkbox", { name: /Authorize up to/ });
      assert(await consent.locator("..").evaluate(element => element.getBoundingClientRect().height >= 44));
      await page.keyboard.press("Tab"); await consent.focus();
      assert.equal(await consent.evaluate(element => getComputedStyle(element).outlineWidth), "2px");
      await page.screenshot({ path: `.git/bookworm-tracking/narration-paid-${width}-20261005.png`, fullPage: true });
    }
  } finally { await page.close(); }
});
