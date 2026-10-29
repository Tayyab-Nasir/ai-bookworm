// Actual Tiptap/React editor and compiled project CSS; no server or external requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { chromium } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const bundle = await build({ stdin: { contents: `import React from "react";
  import { createRoot } from "react-dom/client";
  import Editor from "./apps/web/components/RichBookEditor";
  const root = createRoot(document.getElementById("root"));
  window.showEditor = (permissions = "editor") => root.render(React.createElement(Editor, {
    document: { chapterId: "chapter", version: 1, nodes: window.nodes }, permissions,
    workspaceId: "workspace", onChange: nodes => { window.saved = nodes; window.saves++; } }));`,
  loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  plugins: [{ name: "local-api", setup(builder) {
    builder.onResolve({ filter: /^\.\/api$/ }, args => args.importer.replaceAll("\\", "/").includes("/apps/web/components/")
      ? { path: "api", namespace: "fixture" } : undefined);
    builder.onLoad({ filter: /^api$/, namespace: "fixture" }, () => ({ contents: "export const apiClient = () => ({});" }));
  } }],
});
const parentBundle = await build({ stdin: { contents: `import React from "react";
  import { createRoot } from "react-dom/client";
  import BookEditor from "./apps/web/components/BookEditorClient";
  const root = createRoot(document.getElementById("root"));
  window.renderBookEditor = (props = {}) => root.render(React.createElement(BookEditor, { bookId: "book", ...props }));`,
  loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", outfile: "editor-page.js",
  plugins: [{ name: "parent-transports", setup(builder) {
    builder.onResolve({ filter: /^(\.\/api|next\/link|\.\/AiAssistantPanel)$/ }, args => ({ path: args.path, namespace: "parent-fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "parent-fixture" }, args => ({ resolveDir: process.cwd(), contents:
      args.path === "./api" ? "export const apiClient = () => window.bookwormApi;" : args.path === "next/link"
      ? 'import React from "react"; export default function Link({ children, ...props }) { return React.createElement("a", props, children); }'
      : 'import React from "react"; export default function Panel({ dirty }) { return React.createElement("aside", { "data-ai-dirty": String(dirty) }, "AI fixture"); }' }));
  } }],
});
const reviewBundle = await build({ stdin: { contents: `import React from "react";
  import { createRoot } from "react-dom/client";
  import BookEditor from "./apps/web/components/BookEditorClient";
  const root = createRoot(document.getElementById("root"));
  window.renderBookEditor = (props = {}) => root.render(React.createElement(BookEditor, { bookId: "book", ...props }));`,
  loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", outfile: "editor-review.js",
  plugins: [{ name: "review-transports", setup(builder) {
    builder.onResolve({ filter: /^(\.\/api|next\/link)$/ }, args => ({ path: args.path, namespace: "review-fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "review-fixture" }, args => ({ resolveDir: process.cwd(), contents: args.path === "./api"
      ? "export const apiClient = () => window.bookwormApi;"
      : 'import React from "react"; export default function Link({ children, ...props }) { return React.createElement("a", props, children); }' }));
  } }],
});
const stylePath = resolve("apps/web/styles/globals.css");
const styles = await postcss([tailwind({ base: resolve("apps/web"), optimize: false })]).process(await readFile(stylePath, "utf8"), { from: stylePath });
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
const artifacts = await mkdtemp(resolve(tmpdir(), "bookworm-numbering-mounted-"));
test.after(() => browser.close());

async function fixture(width = 1280, parent = false, realReview = false) {
  const page = await browser.newPage({ viewport: { width, height: 980 } });
  page.setDefaultTimeout(6000);
  await page.route("**/*", route => route.fulfill(new URL(route.request().url()).pathname === "/api/auth/session"
    ? { contentType: "application/json", body: JSON.stringify({ user: { id: "fixture-author" } }) }
    : { contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' }));
  await page.goto("http://127.0.0.1/bookworm-editor-numbering-fixture");
  await page.addStyleTag({ content: styles.css + "body {padding: 16px;}" });
  await page.evaluate(parent => {
    window.saves = 0;
    window.nodes = [
      { id: "first", type: "listItem", text: "Imported first step", attributes: { listStyle: "ordered", listDepth: 0, listStart: 7, listNumberStyle: "lower-roman" } },
      { id: "child", type: "listItem", text: "Nested step", attributes: { listStyle: "ordered", listDepth: 1, listStart: 3, listNumberStyle: "upper-alpha" } },
      { id: "next", type: "listItem", text: "Imported next step", attributes: { listStyle: "ordered", listDepth: 0, listStart: 8, listNumberStyle: "lower-roman" } },
      { id: "restart", type: "listItem", text: "Restarted list", attributes: { listStyle: "ordered", listDepth: 0, listStart: 2, listNumberStyle: "decimal" } },
    ];
    if (parent) window.nodes.push({ id: "table", type: "table", text: "Research facts", rows: [["Research facts"]] });
    window.saved = structuredClone(window.nodes);
    window.documentReads = []; window.requests = []; window.creations = 0; window.restores = 0;
    const chapters = [{ id: "chapter", book_id: "book", title: "First chapter" }, { id: "second", book_id: "book", title: "Second chapter" }];
    window.bookwormApi = {
      getBook: async () => ({ book: { id: "book", workspace_id: "workspace", title: "Author manuscript" }, role: "owner" }),
      listChapters: async () => ({ chapters }),
      getChapterTitle: async chapterId => ({ bookId: "book", chapterId, title: chapters.find(c => c.id === chapterId).title, revision: 0, updatedAt: "2026-10-23T15:00:00Z", role: "owner" }),
      getChapterDocument: async chapterId => { window.documentReads.push(chapterId); return { role: "owner", document: { chapterId, version: 1, nodes: structuredClone(window.nodes) } }; },
      listDocumentVersions: async () => ({ versions: [{ id: "version", version_number: 1, created_at: "2026-10-05T12:00:00Z", plain_text: "Saved source" }] }),
      saveChapterDocument: async (chapterId, body) => { window.requests.push(body); return { version: 2, document: { chapterId, version: 2, nodes: body.nodes } }; },
      createChapter: async () => { window.creations++; throw new Error("Unexpected chapter write"); },
      restoreDocumentVersion: async () => { window.restores++; throw new Error("Unexpected restore write"); },
      listAiJobs: async () => ({ jobs: [] }),
      listAiReviewModels: async () => ({ models: [{ id: "fixture-writer", label: "Fixture writer", model: "fixture-writer-model" }] }),
    };
  }, parent);
  const currentBundle = realReview ? reviewBundle : parentBundle;
  if (parent) for (const file of currentBundle.outputFiles.filter(file => file.path.endsWith(".css"))) await page.addStyleTag({ content: file.text });
  await page.addScriptTag({ content: parent ? currentBundle.outputFiles.find(file => file.path.endsWith(".js")).text : bundle.outputFiles[0].text });
  await page.evaluate(parent => parent ? window.renderBookEditor() : window.showEditor(), parent);
  await page.getByRole("textbox", { name: "Manuscript editor" }).waitFor();
  return page;
}

test("real editor renders imported starts, nesting and marker styles without a mount-time save", async () => {
  const page = await fixture();
  try {
    const lists = await page.locator(".ProseMirror ol").evaluateAll(items => items.map(el => ({ start: el.start, type: el.type || "1", style: getComputedStyle(el).listStyleType })));
    assert.deepEqual(lists, [{ start: 7, type: "i", style: "lower-roman" }, { start: 3, type: "A", style: "upper-alpha" }, { start: 2, type: "1", style: "decimal" }]);
    assert.equal(await page.evaluate(() => window.saves), 0);
    await page.screenshot({ path: resolve(artifacts, "editor-numbering-desktop.png"), fullPage: true });
  } finally { await page.close(); }
});

test("keyboard-edited numbering stays focused, saves canonical values and leaves nested lists intact", async () => {
  const page = await fixture();
  try {
    await page.getByText("Imported first step", { exact: true }).click();
    const start = page.getByRole("spinbutton", { name: "Start list at" });
    await start.focus(); await start.press("ControlOrMeta+A"); await start.press("Backspace"); await start.pressSequentially("12");
    assert.equal(await start.inputValue(), "12");
    assert.equal(await start.evaluate(el => el === document.activeElement), true);
    const style = page.getByRole("combobox", { name: "Numbering style" });
    await style.selectOption("upper-alpha");
    const saved = await page.evaluate(() => window.saved);
    assert.deepEqual(saved.filter(n => n.type === "listItem").map(n => [n.id, n.attributes.listStart, n.attributes.listNumberStyle]), [
      ["first", 12, "upper-alpha"], ["child", 3, "upper-alpha"], ["next", 13, "upper-alpha"], ["restart", 2, "decimal"]]);
    // Installed StarterKit adds an editable empty paragraph after a terminal list.
    assert.equal(saved.at(-1).type, "paragraph"); assert.equal(saved.at(-1).text, "");
    await page.getByText("Imported first step", { exact: true }).click();
    await page.keyboard.press("End"); await page.keyboard.type(" edited");
    assert.match(await page.evaluate(() => window.saved[0].text), /edited$/);
    assert.equal(await page.evaluate(() => window.saved[0].attributes.listStart), 12);
    await writeFile(resolve(artifacts, "edited-numbering.json"), JSON.stringify(await page.evaluate(() => window.saved)), { flag: "wx" });
    await style.focus(); await style.press("Tab");
    assert.equal(await start.evaluate(el => el === document.activeElement), true);
    assert.notEqual(await start.evaluate(el => getComputedStyle(el).outlineStyle), "none");
  } finally { await page.close(); }
});

test("author can reverse numbering and save descending values without a replacement manuscript", async () => {
  const page = await fixture();
  try {
    await page.getByText("Imported first step", { exact: true }).click();
    await page.getByRole("checkbox", { name: "Reverse list numbering" }).check();
    assert.equal(await page.locator(".ProseMirror > ol").first().evaluate(el => el.reversed), true);
    assert.deepEqual(await page.evaluate(() => window.saved.filter(n => n.attributes?.listReversed).map(n => n.attributes.listStart)), [7, 6]);
    assert.equal(await page.evaluate(() => window.saved.find(n => n.id === "child").attributes.listStart), 3);
  } finally { await page.close(); }
});

test("overflow blocks save visibly, correction recovers and permission loss disables manuscript editing", async () => {
  const page = await fixture();
  try {
    await page.getByText("Imported first step", { exact: true }).click();
    const before = await page.evaluate(() => window.saves);
    await page.getByRole("spinbutton", { name: "Start list at" }).fill("1000000");
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /not been sent to save/);
    assert.equal(await page.evaluate(() => window.saves), before);
    await page.getByRole("spinbutton", { name: "Start list at" }).fill("9");
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(await page.evaluate(() => window.saved[2].attributes.listStart), 10);
    const saves = await page.evaluate(() => window.saves);
    await page.evaluate(() => window.showEditor("viewer"));
    await page.getByText("Read-only access", { exact: true }).waitFor();
    assert.equal(await page.getByRole("spinbutton", { name: "Start list at" }).count(), 0);
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).getAttribute("contenteditable"), "false");
    assert.equal(await page.evaluate(() => window.saves), saves);
  } finally { await page.close(); }
});

test("actual compiled toolbar and numbering controls fit a narrow author screen", async () => {
  const page = await fixture(375);
  try {
    await page.getByText("Imported first step", { exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const field of [page.getByRole("combobox", { name: "Numbering style" }), page.getByRole("spinbutton", { name: "Start list at" })]) {
      const box = await field.boundingBox(); assert(box && box.x >= 0 && box.x + box.width <= 375 && box.height >= 32);
    }
    await page.screenshot({ path: resolve(artifacts, "editor-numbering-mobile.png"), fullPage: true });
  } finally { await page.close(); }
});

test("actual author page protects invalid unsaved text, blocks writes and recovers after correction", async () => {
  const page = await fixture(1280, true);
  try {
    const unload = () => page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
    assert.equal(await unload(), false);
    await page.getByText("Imported first step", { exact: true }).click();
    await page.getByRole("spinbutton", { name: "Start list at" }).fill("1000000");
    await page.getByRole("alert").waitFor();
    assert.equal(await unload(), true, "Invalid visible manuscript still has unsaved changes");
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).isDisabled(), true);
    assert.equal(await page.locator("[data-ai-dirty]").getAttribute("data-ai-dirty"), "true");
    await page.keyboard.press("ControlOrMeta+s");
    assert.equal(await page.evaluate(() => window.requests.length), 0);
    await page.evaluate(() => {
      window.confirmations = [];
      window.confirm = message => { window.confirmations.push(message); return message.startsWith("Restore this version"); };
    });
    const url = page.url();
    await page.getByRole("link", { name: "Plan", exact: true }).click();
    assert.equal(page.url(), url);
    await page.getByRole("button", { name: /02 Second chapter/ }).click();
    assert.deepEqual(await page.evaluate(() => window.documentReads), ["chapter"]);
    await page.getByLabel("New chapter", { exact: true }).fill("New draft");
    await page.getByRole("button", { name: "Add chapter", exact: true }).click();
    assert.equal(await page.evaluate(() => window.creations), 0);
    await page.getByRole("button", { name: "Restore version 1" }).click();
    assert.equal(await page.evaluate(() => window.restores), 0);
    await page.getByText("Imported first step", { exact: true }).click();
    await page.keyboard.press("End"); await page.keyboard.type(" unsaved while invalid");
    await page.evaluate(() => {
      URL.createObjectURL = blob => { window.downloadText = blob.text(); return "blob:fixture-draft"; };
      URL.revokeObjectURL = () => {};
      document.addEventListener("click", event => { if (event.target instanceof HTMLAnchorElement && event.target.hasAttribute("download")) event.preventDefault(); }, true);
    });
    await page.getByRole("button", { name: "Download draft text" }).click();
    assert.match(await page.evaluate(() => window.downloadText), /Imported first step unsaved while invalid/);
    assert.match(await page.evaluate(() => window.downloadText), /Research facts/);
    assert.equal(await page.getByText("15 words", { exact: true }).count(), 1, "Invalid draft word count reflects current visible text");
    await page.screenshot({ path: resolve(artifacts, "editor-invalid-draft-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 375, height: 980 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(artifacts, "editor-invalid-draft-mobile.png"), fullPage: true });
    await page.getByRole("spinbutton", { name: "Start list at" }).fill("9");
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.getByRole("button", { name: "Save chapter", exact: true }).click();
    await page.getByText("Saved · v2", { exact: true }).waitFor();
    assert.equal(await unload(), false);
    assert.equal(await page.locator("[data-ai-dirty]").getAttribute("data-ai-dirty"), "false");
    assert.equal(await page.evaluate(() => window.requests.length), 1);
    assert.match(await page.evaluate(() => window.requests[0].nodes[0].text), /unsaved while invalid$/);
  } finally { await page.close(); }
});

test("long native markers stay on paper with nested and continuation paragraphs", async () => {
  for (const width of [1280, 375]) {
    const page = await fixture(width, true);
    try {
      await page.getByText("Imported first step", { exact: true }).click();
      await page.getByRole("combobox", { name: "Numbering style" }).selectOption("decimal");
      await page.getByRole("spinbutton", { name: "Start list at" }).fill("999999");
      assert.equal(await page.getByRole("alert").count(), 0);
      await page.evaluate(() => {
        // The installed Tiptap Editor exposes its native handle on the view DOM.
        const editor = document.querySelector(".ProseMirror").editor;
        const doc = editor.getJSON();
        doc.content[0].content[0].content.splice(1, 0, { type: "paragraph", content: [{ type: "text", text: "Continuation paragraph stays separate." }] });
        editor.commands.setContent(doc);
      });
      const layout = await page.locator(".ProseMirror > ol").first().evaluate(list => {
        const paper = list.closest(".ProseMirror").parentElement.parentElement.getBoundingClientRect();
        const first = list.querySelector("li > p"), item = first.parentElement;
        const range = document.createRange(); range.selectNodeContents(first);
        const text = range.getClientRects()[0], style = getComputedStyle(item, "::marker");
        const context = document.createElement("canvas").getContext("2d");
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return { markerLeft: text.left - context.measureText("999999. ").width, paperLeft: paper.left,
          textTop: text.top, itemTop: item.getBoundingClientRect().top,
          continuationDisplay: getComputedStyle(item.querySelectorAll(":scope > p")[1]).display,
          nestedStart: item.querySelector("ol").start, nestedStyle: getComputedStyle(item.querySelector("ol")).listStyleType };
      });
      assert(layout.markerLeft >= layout.paperLeft, `Long marker paints outside the manuscript paper at ${width}px`);
      assert(layout.textTop - layout.itemTop < 32, "Native marker and first text share their first line");
      assert.equal(layout.continuationDisplay, "block");
      assert.equal(layout.nestedStart, 3); assert.equal(layout.nestedStyle, "upper-alpha");
      assert.equal(await page.evaluate(() => window.requests.length), 0);
      assert.match(await page.evaluate(() => document.querySelector(".ProseMirror").editor.getText()), /Continuation paragraph stays separate/);
      await page.getByRole("button", { name: "Save chapter", exact: true }).click();
      await page.getByText("Saved · v2", { exact: true }).waitFor();
      const saved = await page.evaluate(() => window.requests[0].nodes);
      assert.equal(saved[0].text, "Imported first step\nContinuation paragraph stays separate.");
      assert.deepEqual(saved.filter(node => node.type === "listItem").map(node => node.attributes.listStart), [999999, 3, 1000000, 2]);
      await page.screenshot({ path: resolve(artifacts, `editor-long-markers-${width}.png`), fullPage: true });
    } finally { await page.close(); }
  }
});

test("paper table preview has readable contrast against its actual composited background", async () => {
  const page = await fixture(375, true);
  try {
    const report = await page.getByText("Research facts", { exact: true }).evaluate(element => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
      const layers = []; for (let node = element; node; node = node.parentElement) layers.push(rgba(getComputedStyle(node).backgroundColor));
      const blend = (under, over) => under.map((value, i) => value * (1 - over[3] / 255) + over[i] * over[3] / 255);
      const background = layers.reverse().reduce(blend, [0, 0, 0]);
      const foreground = blend(background, rgba(getComputedStyle(element).color));
      const luminance = rgb => rgb.map(value => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
      const a = luminance(background), b = luminance(foreground);
      return { contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), mode: document.compatMode,
        colors: [element, element.closest("table"), element.closest("section")].map(node => [node.tagName, getComputedStyle(node).color]) };
    });
    assert.equal(report.mode, "CSS1Compat", "The fixture must match the application's standards-mode document");
    assert(report.contrast >= 4.5, `Paper table text needs 4.5:1 contrast; got ${JSON.stringify(report)}`);
  } finally { await page.close(); }
});

for (const outcome of ["success", "failure"]) for (const action of ["save", "history", "restore"]) test(`late ${action} ${outcome} does not replace a new same-book chapter view`, async () => {
  const page = await fixture(1280, true);
  try {
    await page.evaluate(([action, outcome]) => {
      const api = window.bookwormApi;
      api.getChapterDocument = async chapterId => ({ role: "owner", document: { chapterId, version: 1,
        nodes: chapterId === "second" ? [{ id: "second-node", type: "paragraph", text: "Second chapter manuscript" }] : structuredClone(window.nodes) } });
      const history = chapterId => ({ versions: [{ id: `${chapterId}-version`, version_number: 1,
        created_at: "2026-10-06T00:00:00Z", change_summary: chapterId === "second" ? "Second chapter revision" : "Late first chapter history" }] });
      api.listDocumentVersions = async chapterId => history(chapterId);
      const deferred = result => new Promise((resolve, reject) => { window.finishOldRequest = () => outcome === "failure" ? reject(new Error("Late previous chapter failure")) : resolve(result); });
      if (action === "history") api.listDocumentVersions = chapterId => chapterId === "chapter" ? deferred(history(chapterId)) : Promise.resolve(history(chapterId));
      else if (action === "restore") api.restoreDocumentVersion = (chapterId, body) => deferred({ version: 2,
        document: { chapterId, version: 2, nodes: [{ id: "old-restore", type: "paragraph", text: "Late restored first chapter" }] } });
      else api.saveChapterDocument = (chapterId, body) => deferred({ version: 2, document: { chapterId, version: 2, nodes: body.nodes } });
      window.confirm = () => true;
    }, [action, outcome]);
    if (action === "restore") await page.getByRole("button", { name: "Restore version 1" }).click();
    else {
      await page.getByText("Imported first step", { exact: true }).click(); await page.keyboard.press("End"); await page.keyboard.type(" changed");
      await page.getByRole("button", { name: "Save chapter", exact: true }).click();
    }
    await page.waitForFunction(() => typeof window.finishOldRequest === "function");
    await page.evaluate(() => window.renderBookEditor({ initialChapterId: "second" }));
    await page.getByText("Second chapter manuscript", { exact: true }).waitFor();
    await page.evaluate(async () => { window.finishOldRequest(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    assert.equal(await page.getByText("Second chapter manuscript", { exact: true }).count(), 1, `Late ${action} response must not reopen the previous chapter`);
    assert.equal(await page.getByText("Second chapter revision", { exact: true }).count(), 1, `Late ${action} history must not enter the selected chapter`);
    assert.equal(await page.getByText("Late first chapter history", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).getAttribute("contenteditable"), "true");
    assert.equal(await page.getByText("Saved · v1", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Saved version 2.", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Restored as version 2.", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("alert").count(), 0);
  } finally { await page.close(); }
});

test("restore is bound to the original account before sending and hides private manuscript on account change", async () => {
  const page = await fixture(1280, true); let actor = "different-author";
  try {
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.evaluate(() => { window.confirm = () => true; window.restoreCalls = []; window.bookwormApi.restoreDocumentVersion = async (...args) => {
      window.restoreCalls.push(args); throw new Error("unexpected restore"); }; });
    await page.getByRole("button", { name: "Restore version 1" }).click();
    await page.getByText(/original account could not be verified/i).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).count(), 0);
    assert.equal(await page.evaluate(() => window.restoreCalls.length), 0);
    actor = "fixture-author";
    await page.getByRole("button", { name: "Recheck original account" }).click();
    await page.getByRole("button", { name: "Retry original restore" }).waitFor();
  } finally { await page.close(); }
});

test("account switch after an uncertain restore keeps the original request and prevents private response adoption", async () => {
  const page = await fixture(1280, true); let actor = "fixture-author";
  try {
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.evaluate(() => { window.confirm = () => true; window.restoreCalls = [];
      window.bookwormApi.restoreDocumentVersion = (...args) => { window.restoreCalls.push(args); return new Promise(resolve => {
        window.finishRestore = () => resolve({ version: 2, versionId: "saved-version", document: { chapterId: "chapter", version: 2,
          nodes: [{ id: "restored", type: "paragraph", text: "Private restored manuscript" }] } }); }); }; });
    await page.getByText("Imported first step", { exact: true }).click(); await page.keyboard.press("End"); await page.keyboard.type(" unsaved");
    await page.getByRole("button", { name: "Restore version 1" }).click();
    await page.waitForFunction(() => typeof window.finishRestore === "function");
    actor = "different-author"; await page.evaluate(() => window.finishRestore());
    await page.getByText(/original account could not be verified/i).waitFor();
    assert.equal(await page.getByText("Private restored manuscript").count(), 0);
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).count(), 0);
    assert.equal(await page.evaluate(() => window.restoreCalls[0][3]), "fixture-author");
    actor = "fixture-author"; await page.getByRole("button", { name: "Recheck original account" }).click();
    await page.getByRole("button", { name: "Retry original restore" }).waitFor();
    assert.match(await page.getByRole("textbox", { name: "Manuscript editor" }).innerText(), /unsaved/);
    assert.equal(await page.evaluate(() => window.restoreCalls.length), 1);
  } finally { await page.close(); }
});

test("lost restore reply retries exactly the same account and operation before adopting the confirmed version", async () => {
  const page = await fixture(1280, true);
  try {
    await page.evaluate(() => { window.confirm = () => true; window.restoreCalls = [];
      window.bookwormApi.restoreDocumentVersion = async (...args) => { window.restoreCalls.push(args);
        if (window.restoreCalls.length === 1) throw new Error("synthetic lost response");
        window.bookwormApi.getChapterDocument = async chapterId => ({ role: "owner", document: { chapterId, version: 2,
          nodes: [{ id: "confirmed", type: "paragraph", text: "Confirmed restored text" }] } });
        return { version: 2, versionId: "restored-version", document: { chapterId: "chapter", version: 2,
          nodes: [{ id: "confirmed", type: "paragraph", text: "Confirmed restored text" }] } }; }; });
    await page.getByRole("button", { name: "Restore version 1" }).click();
    await page.getByRole("button", { name: "Retry original restore" }).waitFor();
    await page.getByRole("button", { name: "Retry original restore" }).click();
    await page.getByText("Confirmed restored text", { exact: true }).waitFor();
    const calls = await page.evaluate(() => window.restoreCalls);
    assert.deepEqual(calls[0], calls[1]); assert.equal(calls[0][3], "fixture-author");
  } finally { await page.close(); }
});

test("a replayed restore receipt cannot replace a newer saved chapter or local draft", async () => {
  const page = await fixture(1280, true);
  try {
    await page.evaluate(() => { window.confirm = () => true;
      window.bookwormApi.restoreDocumentVersion = async () => {
        window.bookwormApi.getChapterDocument = async chapterId => ({ role: "owner", document: { chapterId, version: 3,
          nodes: [{ id: "newer", type: "paragraph", text: "Newer collaborator text" }] } });
        return { version: 2, versionId: "saved-version", document: { chapterId: "chapter", version: 2,
          nodes: [{ id: "old", type: "paragraph", text: "Old restored text" }] } };
      }; });
    await page.getByText("Imported first step", { exact: true }).click(); await page.keyboard.press("End"); await page.keyboard.type(" unsaved");
    await page.getByRole("button", { name: "Restore version 1" }).click();
    await page.getByText(/current chapter is already at version 3/i).waitFor();
    assert.match(await page.getByRole("textbox", { name: "Manuscript editor" }).innerText(), /unsaved/);
    assert.equal(await page.getByText("Old restored text", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Restored as version 2.", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Retry original restore" }).waitFor();
  } finally { await page.close(); }
});

test("equal-version current content must match the restore receipt before adoption", async () => {
  const page = await fixture(1280, true);
  try {
    await page.evaluate(() => { window.confirm = () => true;
      window.bookwormApi.restoreDocumentVersion = async () => {
        window.bookwormApi.getChapterDocument = async chapterId => ({ role: "owner", document: { chapterId, version: 2,
          nodes: [{ id: "current", type: "paragraph", text: "Different current content" }] } });
        return { version: 2, versionId: "saved-version", document: { chapterId: "chapter", version: 2,
          nodes: [{ id: "receipt", type: "paragraph", text: "Receipt content" }] } };
      }; });
    await page.getByRole("button", { name: "Restore version 1" }).click();
    await page.getByText(/does not match the restore receipt/i).waitFor();
    assert.equal(await page.getByText("Receipt content", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Different current content", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Retry original restore" }).waitFor();
  } finally { await page.close(); }
});

test("chapter and history loads bind one account and refuse an account switch during the read", async () => {
  const page = await fixture(1280, true); let actor = "fixture-author";
  try {
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.evaluate(() => {
      window.loadActors = [];
      window.bookwormApi.getChapterDocument = (chapterId, expectedActor) => { window.loadActors.push(expectedActor);
        return new Promise(resolve => { window.finishLoad = () => resolve({ role: "owner", document: { chapterId, version: 1,
          nodes: [{ id: "old-account", type: "paragraph", text: "Old account private chapter" }] } }); }); };
      window.bookwormApi.listDocumentVersions = async (_chapterId, expectedActor) => { window.loadActors.push(expectedActor); return { versions: [] }; };
      window.renderBookEditor({ initialChapterId: "second" });
    });
    await page.waitForFunction(() => typeof window.finishLoad === "function");
    actor = "different-author";
    assert.equal(await page.getByText("Author manuscript", { exact: true }).isVisible(), false);
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).count(), 0);
    await page.evaluate(() => window.finishLoad());
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByText("Old account private chapter").count(), 0);
    assert.deepEqual(await page.evaluate(() => window.loadActors), ["fixture-author", "fixture-author"]);
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).count(), 0);
  } finally { await page.close(); }
});

test("chapter switching verifies the original editor account before loading or exposing metadata", async () => {
  const page = await fixture(1280, true); let actor = "different-author";
  try {
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.evaluate(() => { window.documentReads = []; window.confirm = () => true; });
    await page.getByRole("button", { name: "02 Second chapter", exact: true }).click();
    await page.getByText(/original account could not be verified/i).waitFor();
    assert.equal(await page.getByText("Author manuscript", { exact: true }).isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.documentReads), []);
    actor = "fixture-author"; await page.getByRole("button", { name: "Recheck original account" }).click();
    await page.getByRole("textbox", { name: "Manuscript editor" }).waitFor();
  } finally { await page.close(); }
});

test("ambiguous chapter reorder stays fenced after checking any observed order", async () => {
  for (const observed of ["requested", "previous", "different"]) {
    const page = await fixture(1280, true);
    try {
      await page.evaluate(observed => {
        window.reorderCalls = [];
        window.bookwormApi.reorderChapters = async (bookId, body, actor) => { window.reorderCalls.push({ bookId, body, actor }); throw new Error("lost order reply"); };
        window.bookwormApi.listChapters = async (_bookId, actor) => {
          window.orderReadActor = actor;
          const rows = [{ id: "chapter", book_id: "book", title: "First chapter" }, { id: "second", book_id: "book", title: "Second chapter" }];
          return { chapters: observed === "requested" ? rows.reverse() : observed === "previous" ? rows : [...rows, { id: "third", book_id: "book", title: "Third chapter" }] };
        };
      }, observed);
      await page.getByRole("button", { name: "Move Second chapter up" }).click();
      await page.getByRole("region", { name: "Unconfirmed chapter order" }).waitFor();
      await page.getByRole("button", { name: "Check saved chapter order" }).click();
      await page.getByText(observed === "requested" ? "The current order matches the requested order."
        : observed === "previous" ? "The current order matches the previous order."
        : "The current order differs from both the previous and requested orders.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Move Second chapter up" }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "Add chapter" }).isDisabled(), true);
      const result = await page.evaluate(() => ({ calls: window.reorderCalls, actor: window.orderReadActor }));
      assert.equal(result.calls.length, 1); assert.equal(result.calls[0].actor, "fixture-author"); assert.equal(result.actor, "fixture-author");
      assert.match(await page.getByRole("region", { name: "Unconfirmed chapter order" }).innerText(), /cannot prove who changed it or cancel/);
    } finally { await page.close(); }
  }
});

test("confirmed reorder binds the actor and refreshes the saved list before enabling changes", async () => {
  const page = await fixture(1280, true);
  try {
    await page.evaluate(() => {
      window.reorderCalls = [];
      const rows = [{ id: "second", book_id: "book", title: "Second chapter" }, { id: "chapter", book_id: "book", title: "First chapter" }];
      window.bookwormApi.reorderChapters = async (bookId, body, actor) => { window.reorderCalls.push({ bookId, body, actor }); return { chapters: rows }; };
      window.bookwormApi.listChapters = async (_bookId, actor) => { window.orderReadActor = actor; return { chapters: rows }; };
    });
    await page.getByRole("button", { name: "Move Second chapter up" }).click();
    await page.getByText("Chapter order was saved. The list shows the latest verified order.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Unconfirmed chapter order" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "01 Second chapter", exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => [window.reorderCalls[0].actor, window.orderReadActor]), ["fixture-author", "fixture-author"]);
  } finally { await page.close(); }
});

test("chapter reorder refuses an account switch before any structure write", async () => {
  const page = await fixture(1280, true); let actor = "different-author";
  try {
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.evaluate(() => { window.reorderCalls = 0; window.bookwormApi.reorderChapters = async () => { window.reorderCalls++; throw new Error(); }; });
    await page.getByRole("button", { name: "Move Second chapter up" }).click();
    await page.getByText(/original account could not be verified/i).waitFor();
    assert.equal(await page.evaluate(() => window.reorderCalls), 0);
  } finally { await page.close(); }
});

test("transient account check failure before reorder sends nothing and allows a fresh attempt", async () => {
  const page = await fixture(1280, true); let first = true;
  try {
    await page.locator('button:has-text("Edit chapter title"):not([disabled])').waitFor();
    await page.route("**/api/auth/session", route => {
      if (first) { first = false; return route.fulfill({ status: 503, json: { error: "unavailable" } }); }
      return route.fulfill({ json: { user: { id: "fixture-author" } } });
    });
    await page.evaluate(() => {
      window.reorderCalls = [];
      const rows = [{ id: "second", book_id: "book", title: "Second chapter" }, { id: "chapter", book_id: "book", title: "First chapter" }];
      window.bookwormApi.reorderChapters = async (bookId, body, actor) => { window.reorderCalls.push({ bookId, body, actor }); return { chapters: rows }; };
      window.bookwormApi.listChapters = async () => ({ chapters: rows });
    });
    await page.getByRole("button", { name: "Move Second chapter up" }).click();
    await page.getByText("Could not verify your account. No chapter reorder was sent. Try again.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.reorderCalls.length), 0);
    assert.equal(await page.getByRole("region", { name: "Unconfirmed chapter order" }).count(), 0);
    const move = page.getByRole("button", { name: "Move Second chapter up" });
    assert.equal(await move.isDisabled(), false);
    await move.click();
    await page.getByText("Chapter order was saved. The list shows the latest verified order.", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.reorderCalls.map(call => call.actor)), ["fixture-author"]);
  } finally { await page.close(); }
});

test("chapter creation keeps the original actor and request after an account switch", async () => {
  const page = await fixture(1280, true); let actor = "fixture-author";
  try {
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.evaluate(() => { window.createCalls = [];
      window.bookwormApi.createChapter = (bookId, body, expectedActor) => { window.createCalls.push({ bookId, body, expectedActor });
        return new Promise(resolve => { window.finishCreate = () => resolve({ chapter: { id: "created", book_id: "book", title: body.title } }); }); }; });
    await page.getByLabel("New chapter", { exact: true }).fill("New synthetic chapter");
    await page.getByRole("button", { name: "Add chapter", exact: true }).click();
    await page.waitForFunction(() => typeof window.finishCreate === "function");
    actor = "different-author"; await page.evaluate(() => window.finishCreate());
    await page.getByText(/original account could not be verified/i).waitFor();
    assert.equal(await page.evaluate(() => window.createCalls[0].expectedActor), "fixture-author");
    actor = "fixture-author"; await page.getByRole("button", { name: "Recheck original account" }).click();
    await page.getByRole("button", { name: "Retry chapter creation", exact: true }).waitFor();
    assert.match(await page.locator("#chapter-creation-recovery").innerText(), /deleted.*create it again/);
    assert.equal(await page.evaluate(() => window.createCalls.length), 1);
  } finally { await page.close(); }
});

test("a pending chapter account check blocks the save keyboard shortcut synchronously", async () => {
  const page = await fixture(1280, true); let releaseSession, first = true;
  try {
    await page.getByText("Imported first step", { exact: true }).click(); await page.keyboard.press("End"); await page.keyboard.type(" unsaved");
    await page.route("**/api/auth/session", route => {
      if (!first) return route.fulfill({ json: { user: { id: "fixture-author" } } });
      first = false;
      return new Promise(resolve => { releaseSession = () => { route.fulfill({ json: { user: { id: "fixture-author" } } }); resolve(); }; });
    });
    await page.evaluate(() => { window.confirm = () => true; window.requests = []; });
    await page.getByRole("button", { name: "02 Second chapter", exact: true }).click();
    while (!releaseSession) await new Promise(resolve => setTimeout(resolve, 10));
    await page.keyboard.press("Control+s");
    assert.equal(await page.evaluate(() => window.requests.length), 0);
    releaseSession();
    await page.getByRole("textbox", { name: "Manuscript editor" }).waitFor();
    assert.equal(await page.evaluate(() => window.requests.length), 0);
  } finally { await page.close(); }
});

test("superseded chapter load cannot leave the next empty or failed book hidden", async () => {
  for (const mode of ["empty", "error"]) {
    const page = await fixture(1280, true);
    try {
      await page.evaluate(mode => {
        window.bookwormApi.getChapterDocument = chapterId => new Promise(resolve => {
          window.finishSuperseded = () => resolve({ role: "owner", document: { chapterId, version: 1,
            nodes: [{ id: "old", type: "paragraph", text: "Superseded private manuscript" }] } }); });
        window.bookwormApi.getBook = async id => {
          if (id === "next-book" && mode === "error") throw new Error("Next book unavailable");
          return { book: { id, workspace_id: "workspace", title: "Next empty book" }, role: "owner" }; };
        window.bookwormApi.listChapters = async id => ({ chapters: id === "next-book" ? [] : [{ id: "chapter", title: "First chapter" }, { id: "second", title: "Second chapter" }] });
      }, mode);
      await page.getByRole("button", { name: "02 Second chapter", exact: true }).click();
      await page.waitForFunction(() => typeof window.finishSuperseded === "function");
      await page.evaluate(() => window.renderBookEditor({ bookId: "next-book" }));
      if (mode === "empty") await page.getByText("Add your first chapter to start writing.").waitFor();
      else await page.getByRole("alert").waitFor();
      assert.equal(await page.getByText("Checking the original account…").count(), 0);
      await page.evaluate(() => window.finishSuperseded());
      assert.equal(await page.getByText("Superseded private manuscript").count(), 0);
    } finally { await page.close(); }
  }
});

test("intentional book change clears the old account overlay before loading the new account", async () => {
  const page = await fixture(1280, true); let actor = "different-author";
  try {
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.getByRole("button", { name: "02 Second chapter", exact: true }).click();
    await page.getByText(/original account could not be verified/i).waitFor();
    await page.evaluate(() => {
      window.bookwormApi.getBook = async id => ({ book: { id, workspace_id: "workspace", title: "New account book" }, role: "owner" });
      window.bookwormApi.listChapters = async () => ({ chapters: [] });
      window.renderBookEditor({ bookId: "next-book" });
    });
    await page.getByText("Add your first chapter to start writing.").waitFor();
    assert.equal(await page.getByText(/original account could not be verified/i).count(), 0);
  } finally { await page.close(); }
});

test("manual save hides an old draft when the account changes before the write", async () => {
  const page = await fixture(1280, true); let actor = "different-author";
  try {
    await page.getByText("Imported first step", { exact: true }).click(); await page.keyboard.press("End"); await page.keyboard.type(" private draft");
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.getByRole("button", { name: "Save chapter", exact: true }).click();
    await page.getByText(/original account could not be verified/i).waitFor();
    assert.equal(await page.evaluate(() => window.requests.length), 0);
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).count(), 0);
    actor = "fixture-author"; await page.getByRole("button", { name: "Recheck original account" }).click();
    await page.getByRole("textbox", { name: "Manuscript editor" }).waitFor();
    assert.match(await page.getByRole("textbox", { name: "Manuscript editor" }).innerText(), /private draft/);
  } finally { await page.close(); }
});

test("manual save retains its recovery pointer and hides a response after an account switch", async () => {
  const page = await fixture(1280, true); let actor = "fixture-author";
  try {
    await page.getByText("Imported first step", { exact: true }).click(); await page.keyboard.press("End"); await page.keyboard.type(" private draft");
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.evaluate(() => { window.requests = [];
      window.bookwormApi.saveChapterDocument = (chapterId, body, expectedActor) => {
        window.requests.push({ body, expectedActor }); return new Promise(resolve => { window.finishSave = () => resolve({ version: 2,
          document: { chapterId, version: 2, nodes: body.nodes } }); }); }; });
    await page.getByRole("button", { name: "Save chapter", exact: true }).click();
    await page.waitForFunction(() => typeof window.finishSave === "function");
    actor = "different-author"; await page.evaluate(() => window.finishSave());
    await page.getByText(/original account could not be verified/i).waitFor();
    assert.equal(await page.evaluate(() => window.requests[0].expectedActor), "fixture-author");
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith("bookworm:manual-save:"))), true);
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).count(), 0);
  } finally { await page.close(); }
});

test("comparison version reads retain original actor and hide late responses after account switch", async () => {
  const page = await fixture(1280, true); let actor = "fixture-author";
  try {
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.evaluate(() => {
      window.versionActors = [];
      window.bookwormApi.listDocumentVersions = async () => ({ versions: [
        { id: "v1", version_number: 1, created_at: "2026-10-05T12:00:00Z", plain_text: "A" },
        { id: "v2", version_number: 2, created_at: "2026-10-05T12:00:00Z", plain_text: "B" }] });
      window.bookwormApi.getDocumentVersion = (_chapter, versionId, expectedActor) => {
        window.versionActors.push(expectedActor);
        return new Promise(resolve => { (window.versionReleases ??= []).push(() => resolve({
          version: { id: versionId, version_number: versionId === "v1" ? 1 : 2 },
          document: { chapterId: "chapter", version: versionId === "v1" ? 1 : 2,
            nodes: [{ id: "private", type: "paragraph", text: "Private version detail" }] } })); }); };
      window.renderBookEditor({ initialChapterId: "chapter" });
    });
    await page.getByRole("checkbox", { name: "Select version 1" }).check();
    await page.getByRole("checkbox", { name: "Select version 2" }).check();
    await page.getByRole("button", { name: "Compare selected" }).click();
    await page.getByRole("button", { name: "Compare blocks & formatting" }).click();
    await page.waitForFunction(() => window.versionReleases?.length === 2);
    actor = "different-author"; await page.evaluate(() => window.versionReleases.forEach(release => release()));
    await page.getByText(/original account could not be verified/i).waitFor();
    assert.deepEqual(await page.evaluate(() => window.versionActors), ["fixture-author", "fixture-author"]);
    assert.equal(await page.getByText("Private version detail", { exact: true }).isVisible().catch(() => false), false);
  } finally { await page.close(); }
});

test("book and chapter list reads reject account changes before private metadata is shown", async () => {
  const page = await fixture(1280, true); let actor = "fixture-author";
  try {
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.evaluate(() => {
      window.bookActors = [];
      window.bookwormApi.getBook = (_id, expectedActor) => { window.bookActors.push(expectedActor);
        return new Promise(resolve => { window.finishBook = () => resolve({ book: { id: "book", workspace_id: "workspace",
          title: "Private old account book" }, role: "owner" }); }); };
      window.bookwormApi.listChapters = async (_id, expectedActor) => { window.bookActors.push(expectedActor);
        return { chapters: [{ id: "second", title: "Private old account chapter" }] }; };
      window.renderBookEditor({ initialChapterId: "second" });
    });
    await page.waitForFunction(() => typeof window.finishBook === "function");
    actor = "different-author"; await page.evaluate(() => window.finishBook());
    await page.getByRole("alert").waitFor();
    assert.deepEqual(await page.evaluate(() => window.bookActors), ["fixture-author", "fixture-author"]);
    assert.equal(await page.getByText("Private old account book").count(), 0);
    assert.equal(await page.getByText("Private old account chapter").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).count(), 0);
  } finally { await page.close(); }
});

test("story plan load retains the original account fence before revealing book metadata", async () => {
  const page = await fixture(1280, true); let actor = "fixture-author";
  try {
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.evaluate(() => {
      window.bookwormApi.getStoryBlueprint = (_id, expectedActor) => { window.planActor = expectedActor;
        return new Promise(resolve => { window.finishPlan = () => resolve({ blueprint: null }); }); };
      window.renderBookEditor({ initialChapterId: "second", initialDraftPlanItemId: "plan" });
    });
    await page.waitForFunction(() => typeof window.finishPlan === "function");
    actor = "different-author"; await page.evaluate(() => window.finishPlan());
    await page.getByRole("alert").waitFor();
    assert.equal(await page.evaluate(() => window.planActor), "fixture-author");
    assert.equal(await page.getByText("Author manuscript", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).count(), 0);
  } finally { await page.close(); }
});

test("restore rejects wrong chapter or revision without adopting the response", async () => {
  for (const bad of ["chapter", "version"]) {
    const page = await fixture(1280, true);
    try {
      await page.evaluate(bad => { window.confirm = () => true;
        window.bookwormApi.restoreDocumentVersion = async () => ({ version: 2, versionId: "saved-version",
          document: { chapterId: bad === "chapter" ? "second" : "chapter", version: bad === "version" ? 3 : 2,
            nodes: [{ id: "bad", type: "paragraph", text: "Wrong restored manuscript" }] } }); }, bad);
      await page.getByRole("button", { name: "Restore version 1" }).click();
      await page.getByRole("button", { name: "Retry original restore" }).waitFor();
      assert.equal(await page.getByText("Wrong restored manuscript").count(), 0);
      assert.equal(await page.getByText("Restored as version 2.").count(), 0);
    } finally { await page.close(); }
  }
});

test("failed chapter deep-link stays empty/read-only and retries the requested chapter", async () => {
  const page = await fixture(375, true);
  try {
    await page.evaluate(() => {
      const original = window.bookwormApi.getChapterDocument;
      window.bookwormApi.getChapterDocument = chapterId => chapterId === "second" ? Promise.reject(new Error("Requested chapter is temporarily unavailable")) : original(chapterId);
      window.renderBookEditor({ initialChapterId: "second" });
    });
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).count(), 0, "Failed new target must not reveal the previous manuscript");
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Restore version 1" }).count(), 0);
    await page.evaluate(() => { window.bookwormApi.getChapterDocument = async chapterId => ({ role: "viewer", document: { chapterId, version: 3,
      nodes: [{ id: "recovered", type: "paragraph", text: "Recovered requested chapter" }] } }); });
    await page.getByRole("button", { name: "Retry loading chapter", exact: true }).click();
    await page.getByText("Recovered requested chapter", { exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).getAttribute("contenteditable"), "false");
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).count(), 0);
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(artifacts, "editor-recovered-read-only-mobile.png"), fullPage: true });
  } finally { await page.close(); }
});

test("unconfirmed chapter creation keeps its original request across a chapter deep-link", async () => {
  const page = await fixture(1280, true);
  try {
    await page.evaluate(() => {
      window.createBodies = [];
      window.bookwormApi.getChapterDocument = async chapterId => ({ role: "owner", document: { chapterId, version: 1,
        nodes: [{ id: `${chapterId}-node`, type: "paragraph", text: `${chapterId} saved manuscript` }] } });
      window.bookwormApi.createChapter = async (bookId, body) => {
        window.createBodies.push(structuredClone(body));
        if (window.createBodies.length === 1) return new Promise((resolve, reject) => { window.failOriginalCreation = () => reject(new Error("Original creation outcome unconfirmed")); });
        return { chapter: { id: "created", book_id: bookId, title: body.title } };
      };
    });
    await page.getByLabel("New chapter", { exact: true }).fill("Original chapter intent");
    await page.getByLabel("Optional AI drafting brief", { exact: true }).fill("Original author brief");
    await page.getByRole("button", { name: "Add & review AI brief", exact: true }).click();
    await page.waitForFunction(() => typeof window.failOriginalCreation === "function");
    await page.evaluate(() => { window.bookwormApi.listChapters = async () => ({ chapters: [
      { id: "chapter", book_id: "book", title: "First chapter" }, { id: "second", book_id: "book", title: "Second chapter" }, { id: "created", book_id: "book", title: "Original chapter intent" },
    ] }); });
    await page.evaluate(() => window.renderBookEditor({ initialChapterId: "second" }));
    await page.getByText("second saved manuscript", { exact: true }).waitFor();
    await page.evaluate(async () => { window.failOriginalCreation(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(await page.getByLabel("New chapter", { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel("Optional AI drafting brief", { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel("New chapter", { exact: true }).inputValue(), "Original chapter intent");
    assert.equal(await page.getByLabel("Optional AI drafting brief", { exact: true }).inputValue(), "Original author brief");
    assert.match(await page.locator("#chapter-creation-recovery").innerText(), /Original chapter intent.*not confirmed/);
    assert.equal(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
    await page.evaluate(() => { window.creationNavigationWarnings = []; window.confirm = message => { window.creationNavigationWarnings.push(message); return false; }; });
    const originalUrl = page.url();
    await page.getByRole("link", { name: "Plan", exact: true }).click();
    assert.equal(page.url(), originalUrl);
    assert.match((await page.evaluate(() => window.creationNavigationWarnings))[0], /Chapter creation is unconfirmed/);
    await page.getByRole("button", { name: "Retry chapter creation", exact: true }).click();
    await page.getByText("Chapter created. Review the draft brief and request a price in the AI assistant. Nothing was generated or charged.", { exact: true }).waitFor();
    const bodies = await page.evaluate(() => window.createBodies);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].idempotencyKey, bodies[0].idempotencyKey, "Changing chapter view must not create a replacement request for unconfirmed creation");
    assert.equal(bodies[1].title, "Original chapter intent");
    assert.equal(await page.getByText("created saved manuscript", { exact: true }).count(), 1);
    assert.equal(await page.getByRole("navigation", { name: "Chapters" }).getByRole("button", { name: /^\d+ Original chapter intent$/ }).count(), 1, "Recovery must not duplicate a chapter already returned by the server list");
    assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes("Original author brief"))), false);
    assert.equal(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false);
  } finally { await page.close(); }
});

for (const outcome of ["success", "failure"]) for (const action of ["create", "reorder"]) test(`late ${action} ${outcome} preserves the selected chapter and current save lock`, async () => {
  const page = await fixture(1280, true);
  try {
    await page.evaluate(([action, outcome]) => {
      const api = window.bookwormApi;
      api.getChapterDocument = async chapterId => ({ role: "owner", document: { chapterId, version: 1,
        nodes: [{ id: `${chapterId}-node`, type: "paragraph", text: `${chapterId} manuscript` }] } });
      const deferred = result => new Promise((resolve, reject) => { window.finishOldMutation = () => outcome === "success" ? resolve(result) : reject(new Error("Previous chapter mutation failed")); });
      if (action === "create") api.createChapter = async () => deferred({ chapter: { id: "late-created", title: "Late created chapter" } });
      else api.reorderChapters = async () => deferred({ chapters: [{ id: "second", title: "Stale reordered second" }, { id: "chapter", title: "Stale reordered first" }] });
      api.saveChapterDocument = (chapterId, body) => new Promise(resolve => { window.finishCurrentSave = () => resolve({ version: 2, document: { chapterId, version: 2, nodes: body.nodes } }); });
    }, [action, outcome]);
    if (action === "create") { await page.getByLabel("New chapter", { exact: true }).fill("Pending original chapter"); await page.getByRole("button", { name: "Add chapter", exact: true }).click(); }
    else await page.getByRole("button", { name: "Move First chapter down", exact: true }).click();
    await page.waitForFunction(() => typeof window.finishOldMutation === "function");
    await page.evaluate(() => window.renderBookEditor({ initialChapterId: "second" }));
    await page.getByText("second manuscript", { exact: true }).waitFor();
    await page.getByText("second manuscript", { exact: true }).click(); await page.keyboard.press("End"); await page.keyboard.type(" current edit");
    await page.getByRole("button", { name: "Save chapter", exact: true }).click();
    await page.waitForFunction(() => typeof window.finishCurrentSave === "function");
    await page.evaluate(async () => { window.finishOldMutation(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    assert.equal(await page.getByText("second manuscript current edit", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Saving…", { exact: true }).count(), 1, "Old finally must not unlock the active save");
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).getAttribute("contenteditable"), "false");
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(await page.getByRole("button", { name: /Stale reordered/ }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /Late created chapter/ }).count(), 0);
    if (action === "create") assert.equal(await page.getByRole("button", { name: "Retry chapter creation", exact: true }).count(), 1);
    await page.evaluate(() => window.finishCurrentSave());
    await page.getByText("Saved · v2", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Manuscript editor"]').getAttribute("contenteditable") === "true");
    assert.equal(await page.getByText("second manuscript current edit", { exact: true }).count(), 1);
  } finally { await page.close(); }
});

for (const outcome of ["success", "failure"]) test(`late old save ${outcome} does not unlock a newer chapter save`, async () => {
  const page = await fixture(1280, true);
  try {
    await page.evaluate(outcome => {
      const api = window.bookwormApi;
      api.getChapterDocument = async chapterId => ({ role: "owner", document: { chapterId, version: 1,
        nodes: [{ id: `${chapterId}-node`, type: "paragraph", text: `${chapterId} manuscript` }] } });
      api.saveChapterDocument = (chapterId, body) => new Promise((resolve, reject) => {
        const result = { version: 2, document: { chapterId, version: 2, nodes: body.nodes } };
        if (chapterId === "chapter") window.finishOldSave = () => outcome === "success" ? resolve(result) : reject(new Error("Old save failure"));
        else window.finishCurrentSave = () => resolve(result);
      });
    }, outcome);
    await page.getByText("Imported first step", { exact: true }).click(); await page.keyboard.press("End"); await page.keyboard.type(" old edit");
    await page.getByRole("button", { name: "Save chapter", exact: true }).click();
    await page.waitForFunction(() => typeof window.finishOldSave === "function");
    await page.evaluate(() => window.renderBookEditor({ initialChapterId: "second" }));
    await page.getByText("second manuscript", { exact: true }).waitFor();
    await page.getByText("second manuscript", { exact: true }).click(); await page.keyboard.press("End"); await page.keyboard.type(" current edit");
    await page.getByRole("button", { name: "Save chapter", exact: true }).click();
    await page.waitForFunction(() => typeof window.finishCurrentSave === "function");
    await page.evaluate(async () => { window.finishOldSave(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    assert.equal(await page.getByText("Saving…", { exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).getAttribute("contenteditable"), "false");
    assert.equal(await page.getByText("second manuscript current edit", { exact: true }).count(), 1);
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.evaluate(() => window.finishCurrentSave());
    await page.getByText("Saved · v2", { exact: true }).waitFor();
  } finally { await page.close(); }
});

test("an unavailable explicit chapter does not silently open the first chapter", async () => {
  const page = await fixture(375, true);
  try {
    await page.evaluate(() => window.renderBookEditor({ initialChapterId: "missing" }));
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /requested chapter is not available/);
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.documentReads), ["chapter"]);
    await page.getByRole("button", { name: "Chapters · 2" }).click();
    await page.getByRole("button", { name: /02 Second chapter/ }).click();
    await page.getByRole("textbox", { name: "Manuscript editor" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.documentReads), ["chapter", "second"]);
    assert.equal(await page.getByRole("alert").count(), 0);
  } finally { await page.close(); }
});

test("book identity retry cannot reveal the previous manuscript or editable role", async () => {
  const page = await fixture(1280, true);
  try {
    await page.evaluate(() => { window.bookwormApi.getBook = async () => { throw new Error("Book connection unavailable"); }; window.renderBookEditor({ initialChapterId: "second" }); });
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).count(), 0);
    await page.evaluate(() => {
      window.bookwormApi.getBook = async () => ({ book: { id: "book", workspace_id: "workspace", title: "Recovered book identity" }, role: "viewer" });
      window.bookwormApi.getChapterDocument = async chapterId => ({ role: "viewer", document: { chapterId, version: 4, nodes: [{ id: "recovered", type: "paragraph", text: "Recovered selected manuscript" }] } });
    });
    await page.getByRole("button", { name: "Retry loading book", exact: true }).click();
    await page.getByText("Recovered selected manuscript", { exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).getAttribute("contenteditable"), "false");
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).count(), 0);
    assert.equal(await page.getByRole("alert").count(), 0);
  } finally { await page.close(); }
});

for (const refreshFails of [false, true]) test(`actual chapter creation opens price review, recovers acceptance once and handles Apply refresh ${refreshFails ? "failure" : "success"}`, async () => {
  const page = await fixture(1280, true, true);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.evaluate(refreshFails => {
      const api = window.bookwormApi;
      window.paidFlow = { creations: [], quotes: [], acceptances: [], statusReads: 0, applies: 0, review: null };
      const flow = window.paidFlow;
      const document = { chapterId: "paid-chapter", version: 1, nodes: [{ id: "paid-node", type: "paragraph", text: "" }] };
      const original = api.getChapterDocument;
      api.getChapterDocument = chapterId => {
        if (chapterId !== "paid-chapter") return original(chapterId);
        if (refreshFails && document.version === 2 && !flow.failedRefresh) { flow.failedRefresh = true; return Promise.reject(new Error("Confirmed Apply saved; chapter refresh unavailable")); }
        return Promise.resolve({ role: "owner", document: structuredClone(document) });
      };
      api.createChapter = async (bookId, body) => {
        flow.creations.push({ bookId, ...structuredClone(body) });
        if (flow.creations.length === 1) throw new Error("Creation reply unconfirmed");
        api.listChapters = async () => ({ chapters: [{ id: "chapter", book_id: bookId, title: "First chapter" },
          { id: "second", book_id: bookId, title: "Second chapter" }, { id: "paid-chapter", book_id: bookId, title: body.title }] });
        return { chapter: { id: "paid-chapter", book_id: bookId, title: body.title } };
      };
      api.listAiJobs = async () => ({ jobs: flow.review ? [structuredClone(flow.review)] : [] });
      const quote = { requestId: crypto.randomUUID(), status: "ready", agentType: "writer", model: "fixture-writer-model",
        countedInputTokens: 420, maxOutputTokens: 1200, reservedCredits: 24, expiresAt: new Date(Date.now() + 600000).toISOString() };
      api.createAiReviewQuote = async (bookId, body) => { flow.quotes.push({ bookId, ...structuredClone(body) }); return { quote }; };
      api.acceptAiReviewQuote = async (bookId, requestId, expectedCredits) => {
        flow.acceptances.push({ bookId, requestId, expectedCredits });
        const jobId = crypto.randomUUID();
        flow.review = { id: jobId, book_id: bookId, chapter_ids: [document.chapterId], agent_type: "writer", status: "succeeded",
          context_source_count: 0, usage_json: {}, created_at: new Date().toISOString(), suggestions: [{
            id: "paid-suggestion", ai_job_id: jobId, entity_type: "chapter", entity_id: document.chapterId, status: "pending", rationale: "Opening scene for author review",
            operation_json: { operationId: crypto.randomUUID(), type: "replace_text", expectedVersion: 1,
              target: { chapterId: document.chapterId, nodeId: "paid-node" }, payload: { nodeId: "paid-node", from: 0, to: 0, text: "Mara reached the harbor before dawn." } },
          }] };
        throw new Error("Accepted review reply unconfirmed");
      };
      api.getAiReviewQuote = async () => { flow.statusReads++; return { quote, ...(flow.review ? { job: { id: flow.review.id, status: flow.review.status } } : {}) }; };
      api.getAiJob = async () => structuredClone(flow.review);
      api.getChapterSaveStatus = async (chapterId, operationId) => ({ status: "saved", operationId, versionId: "paid-version-2", document: structuredClone(document) });
      api.applySuggestion = async () => { flow.applies++; document.version = 2; document.nodes[0].text = "Mara reached the harbor before dawn."; flow.review.suggestions[0].status = "accepted"; return { version: 2 }; };
    }, refreshFails);
    await page.getByLabel("New chapter", { exact: true }).fill("Paid author chapter");
    await page.getByLabel("Optional AI drafting brief", { exact: true }).fill("Private author brief: Mara follows the letter.");
    await page.getByRole("button", { name: "Add & review AI brief", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "recover the original chapter request" }).waitFor();
    await page.getByRole("button", { name: "Retry chapter creation", exact: true }).click();
    await page.getByLabel("Drafting instruction", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector("#ai-instruction").value === "Private author brief: Mara follows the letter.");
    assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "writer");
    assert.deepEqual(await page.evaluate(() => [window.paidFlow.quotes.length, window.paidFlow.acceptances.length, window.paidFlow.applies]), [0, 0, 0]);
    const creations = await page.evaluate(() => window.paidFlow.creations);
    assert.equal(creations.length, 2); assert.equal(creations[0].idempotencyKey, creations[1].idempotencyKey);
    assert.equal(await page.getByRole("button", { name: "Prepare usage quote", exact: true }).isDisabled(), true);
    await page.getByRole("checkbox", { name: /I agree to send .*OpenAI for token counting/ }).check();
    await page.getByRole("button", { name: "Prepare usage quote", exact: true }).click();
    await page.getByText("24 credits on acceptance", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.paidFlow.quotes.length), 1);
    assert.deepEqual(await page.evaluate(() => [window.paidFlow.acceptances.length, window.paidFlow.applies]), [0, 0]);
    assert.equal((await page.getByRole("textbox", { name: "Manuscript editor" }).innerText()).trim(), "");
    assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes("Private author brief") || value.includes("Mara follows the letter"))), false);
    await page.getByRole("button", { name: "Accept · 24 credits", exact: true }).click();
    await page.getByText("Recovered the accepted review after an uncertain reply. No second charge was made.", { exact: true }).waitFor();
    await page.getByRole("region", { name: "Proposed manuscript text change" }).getByText("Mara reached the harbor before dawn.", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => [window.paidFlow.acceptances.length, window.paidFlow.statusReads, window.paidFlow.applies]), [1, 1, 0]);
    assert.equal((await page.getByRole("textbox", { name: "Manuscript editor" }).innerText()).trim(), "");
    if (!refreshFails) await page.evaluate(() => {
      const original = window.bookwormApi.applySuggestion;
      window.bookwormApi.applySuggestion = () => new Promise(resolve => { window.finishApply = () => resolve(original()); });
    });
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    if (!refreshFails) {
      await page.waitForFunction(() => !!window.finishApply);
      await page.waitForFunction(() => document.querySelector('[role="textbox"][aria-label="Manuscript editor"]')?.getAttribute("contenteditable") === "false");
      assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).isDisabled(), true);
      assert.equal(await page.getByLabel("New chapter", { exact: true }).isDisabled(), true);
      await page.getByRole("textbox", { name: "Manuscript editor" }).press("x");
      assert.equal((await page.getByRole("textbox", { name: "Manuscript editor" }).innerText()).trim(), "");
      await page.evaluate(() => window.finishApply());
    }
    if (refreshFails) {
      await page.getByRole("alert").filter({ hasText: "chapter refresh unavailable" }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).count(), 0);
      await page.getByRole("button", { name: "Retry loading chapter", exact: true }).click();
      await page.getByText("accepted", { exact: true }).waitFor();
    }
    await page.getByRole("textbox", { name: "Manuscript editor" }).getByText("Mara reached the harbor before dawn.", { exact: true }).waitFor();
    await page.getByText("Saved · v2", { exact: true }).waitFor();
    assert.equal(await page.getByText("accepted", { exact: true }).count(), 1, "Same-chapter refresh must retain the confirmed review instead of silently discarding it");
    assert.deepEqual(await page.evaluate(() => [window.paidFlow.quotes.length, window.paidFlow.acceptances.length, window.paidFlow.applies]), [1, 1, 1]);
    await page.setViewportSize({ width: 375, height: 980 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(artifacts, `editor-paid-review-refresh-${refreshFails ? "failure" : "success"}-mobile.png`), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const outcome of ["success", "failure"]) test(`late actual AI Apply ${outcome} cannot reopen its old chapter`, async () => {
  const page = await fixture(1280, true, true);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.evaluate(outcome => {
      const api = window.bookwormApi;
      const original = api.getChapterDocument;
      window.scopeReads = [];
      api.getChapterDocument = async chapterId => { window.scopeReads.push(chapterId); return chapterId === "second"
        ? { role: "owner", document: { chapterId, version: 1, nodes: [{ id: "second-node", type: "paragraph", text: "Current second manuscript" }] } } : original(chapterId); };
      const job = { id: "old-job", book_id: "book", chapter_ids: ["chapter"], agent_type: "writer", status: "succeeded", context_source_count: 0,
        usage_json: {}, created_at: new Date().toISOString(), suggestions: [{ id: "old-suggestion", entity_type: "chapter", entity_id: "chapter", status: "pending", rationale: "Old chapter proposal",
          operation_json: { operationId: crypto.randomUUID(), type: "replace_text", expectedVersion: 1,
            target: { chapterId: "chapter", nodeId: "first" }, payload: { nodeId: "first", from: 0, to: 0, text: "Old AI insertion. " } } }] };
      api.getAiJob = async () => structuredClone(job);
      api.applySuggestion = () => new Promise((resolve, reject) => { window.finishOldApply = () => outcome === "success" ? resolve({ version: 2 }) : reject(new Error("Old AI apply failure")); });
      window.renderBookEditor({ initialAiJobId: "old-job" });
    }, outcome);
    await page.getByText("Old chapter proposal", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForFunction(() => typeof window.finishOldApply === "function");
    await page.evaluate(() => window.renderBookEditor({ initialChapterId: "second" }));
    await page.getByText("Current second manuscript", { exact: true }).waitFor();
    const reads = await page.evaluate(() => window.scopeReads);
    await page.evaluate(async () => { window.finishOldApply(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    assert.equal(await page.getByText("Current second manuscript", { exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => window.scopeReads), reads, "An unmounted old review must not reload its old chapter");
    assert.equal(await page.getByText("Old chapter proposal", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).getAttribute("contenteditable"), "true");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test.after(() => { console.log(JSON.stringify({ mountedNumberingArtifacts: artifacts })); });

test("explicit local draft backup preserves rows-only tables, captions, styles and never saves", async () => {
  const page = await fixture(375, true);
  try {
    await page.evaluate(() => {
      window.nodes.push({ id: "rows-only", type: "table", rows: [["River", "Three bridges"], ["City", "Two towers"]] },
        { id: "captioned-image", type: "image", assetId: "11111111-1111-4111-8111-111111111111", assetVersionNumber: 7,
          caption: "A moonlit harbour", altText: "Private accessibility description" });
      window.bookwormApi.getAssetDownloadUrl = async () => { throw new Error("Synthetic preview unavailable"); };
      window.renderBookEditor({ initialChapterId: "second" });
      window.localBackups = [];
      URL.createObjectURL = blob => { window.localBackups.push(blob); return `blob:synthetic-backup-${window.localBackups.length}`; };
      HTMLAnchorElement.prototype.click = function () { window.downloadName = this.download; };
    });
    await page.getByRole("textbox", { name: "Manuscript editor" }).waitFor();
    await page.getByText("Back up chapter draft", { exact: true }).click();
    for (const width of [375, 320, 640, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 980 });
      const menu = await page.locator("details[open] > div").boundingBox();
      assert(menu && menu.x >= 0 && menu.x + menu.width <= width, `Draft menu must remain visible at ${width}px; got ${JSON.stringify(menu)}`);
      const button = await page.getByRole("button", { name: "Download JSON backup", exact: true }).boundingBox();
      assert(button && button.height >= 44 && button.x >= 0 && button.x + button.width <= width);
    }
    await page.setViewportSize({ width: 375, height: 980 });
    await page.getByRole("button", { name: "Download JSON backup", exact: true }).click();
    const backup = await page.evaluate(async () => JSON.parse(await window.localBackups[0].text()));
    assert.equal(backup.chapterId, "second");
    assert.deepEqual(backup.nodes, await page.evaluate(() => window.nodes));
    assert.equal(backup.nodes.find(node => node.id === "first").attributes.listStart, 7);
    assert.match(backup.plainText, /River\tThree bridges\nCity\tTwo towers/);
    assert.match(backup.plainText, /A moonlit harbour/);
    assert.doesNotMatch(backup.plainText, /Private accessibility/);
    await page.getByRole("button", { name: "Download draft text", exact: true }).click();
    assert.equal(await page.evaluate(async () => window.localBackups[1].text()), backup.plainText);
    assert.equal(await page.evaluate(() => window.requests.length), 0);
    assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes("moonlit harbour"))), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(artifacts, "chapter-backup-mobile.png"), fullPage: true });
  } finally { await page.close(); }
});

test("invalid live list numbering JSON backup keeps unsaved editor document, table and visible text", async () => {
  const page = await fixture(1280, true);
  try {
    await page.getByText("Imported first step", { exact: true }).click();
    await page.getByRole("spinbutton", { name: "Start list at" }).fill("1000000");
    await page.getByRole("alert").waitFor();
    await page.keyboard.press("Escape");
    await page.getByText("Imported first step", { exact: true }).click();
    await page.keyboard.press("End"); await page.keyboard.type(" latest invalid edit");
    await page.evaluate(() => {
      window.localBackups = [];
      URL.createObjectURL = blob => { window.localBackups.push(blob); return "blob:synthetic-invalid-backup"; };
      HTMLAnchorElement.prototype.click = function () {};
    });
    await page.getByText("Back up chapter draft", { exact: true }).click();
    await page.getByRole("button", { name: "Download JSON backup", exact: true }).click();
    const backup = await page.evaluate(async () => JSON.parse(await window.localBackups[0].text()));
    assert.equal(backup.canonicalState, "last-valid-draft");
    assert.match(JSON.stringify(backup.editorDocument), /latest invalid edit/);
    assert.match(backup.plainText, /Research facts/);
    assert.match(backup.plainText, /latest invalid edit/);
    assert.equal(await page.evaluate(() => window.requests.length), 0);
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).isDisabled(), true);
  } finally { await page.close(); }
});

async function manualSaveFixture({ stored = true, width = 1280 } = {}) {
  const page = await fixture(width, true);
  await page.evaluate(stored => {
    window.manualReads = 0; window.manualClosures = 0; window.originalSave = null;
    window.apiDocument = { chapterId: "chapter", version: 1, nodes: structuredClone(window.nodes) };
    window.bookwormApi.getChapterDocument = async () => ({ role: "owner", document: structuredClone(window.apiDocument) });
    window.bookwormApi.saveChapterDocument = async (chapterId, body, actor) => {
      if (actor !== "fixture-author") throw Error("Missing original actor");
      window.requests.push(structuredClone(body));
      if (stored || window.retryConfirmed) {
        window.originalSave = { chapterId, version: body.expectedVersion + 1, nodes: structuredClone(body.nodes) };
        window.apiDocument = structuredClone(window.originalSave);
      }
      if (window.retryConfirmed) return { version: window.originalSave.version, versionId: "saved-version", document: structuredClone(window.originalSave) };
      throw Error("Save reply lost in fixture");
    };
    window.manualStatus = (chapterId, operationId, expectedVersion) => ({
      chapterId, bookId: "book", operationId, expectedVersion, currentVersion: window.apiDocument.version,
      status: window.originalSave ? "saved" : window.closedSave ? "closed" : "not_found",
      receipt: window.originalSave || window.closedSave ? { versionId: "receipt-version", document: structuredClone(window.originalSave ?? window.closedSave) } : null,
    });
    window.bookwormApi.getManualChapterSaveStatus = async (chapterId, operationId, expectedVersion, actor) => {
      if (actor !== "fixture-author") throw Error("Wrong recovery actor"); window.manualReads++;
      return window.manualStatus(chapterId, operationId, expectedVersion);
    };
    window.bookwormApi.closeManualChapterSave = async (chapterId, operationId, expectedVersion, actor) => {
      if (actor !== "fixture-author") throw Error("Wrong closure actor"); window.manualClosures++;
      if (!window.originalSave && !window.closedSave) {
        window.closedSave = { ...structuredClone(window.apiDocument), version: expectedVersion + 1 };
        window.apiDocument = structuredClone(window.closedSave);
      }
      if (window.closeReplyLost) throw Error("Closure reply lost in fixture");
      return window.manualStatus(chapterId, operationId, expectedVersion);
    };
  }, stored);
  await page.getByText("Imported first step", { exact: true }).click();
  await page.keyboard.press("End"); await page.keyboard.insertText(" PRIVATE LOST SAVE");
  await page.getByRole("button", { name: "Save chapter", exact: true }).click();
  await page.getByText("Save reply lost in fixture", { exact: true }).waitFor();
  return page;
}

test("manual saved outcome survives remount without manuscript storage or another write", async () => {
  const page = await manualSaveFixture({ width: 320 });
  try {
    assert.equal(await page.locator(".ProseMirror").getAttribute("contenteditable"), "false");
    const raw = await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith("bookworm:manual-save:"))?.[1]);
    assert.ok(raw); assert.equal(raw.includes("PRIVATE"), false); assert.equal(raw.includes("Imported"), false);
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["schema", "userId", "bookId", "chapterId", "operationId", "expectedVersion", "digest"].sort());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(artifacts, "manual-save-recovery-mobile.png"), fullPage: true });
    await page.evaluate(() => window.renderBookEditor({ key: "reload-manual" }));
    await page.getByRole("region", { name: "Manual save recovery" }).waitFor();
    assert.equal(await page.evaluate(() => window.requests.length), 1);
    await page.getByRole("button", { name: "Check saved status", exact: true }).click();
    await page.getByText("Original save confirmed. Loaded saved version 2.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.requests.length), 1);
    assert.equal(await page.evaluate(() => window.manualReads), 1);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith("bookworm:manual-save:"))), false);
    assert.match(await page.locator(".ProseMirror").innerText(), /PRIVATE LOST SAVE/);
  } finally { await page.close(); }
});

test("missing manual save can only retry the identical retained body and operation", async () => {
  const page = await manualSaveFixture({ stored: false });
  try {
    assert.equal(await page.getByRole("button", { name: "Retry original save" }).count(), 0);
    await page.getByRole("button", { name: "Check saved status", exact: true }).click();
    await page.getByRole("button", { name: "Retry original save" }).waitFor();
    await page.evaluate(() => { window.retryConfirmed = true; });
    await page.getByRole("button", { name: "Retry original save" }).click();
    await page.getByText("Saved version 2.", { exact: true }).waitFor();
    const requests = await page.evaluate(() => window.requests);
    assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]);
    assert.equal(await page.evaluate(() => window.manualClosures), 0);
  } finally { await page.close(); }
});

test("missing manual save after remount needs explicit closure and recovers a lost closure reply", async () => {
  const page = await manualSaveFixture({ stored: false });
  try {
    await page.evaluate(() => { window.closeReplyLost = true; window.renderBookEditor({ key: "reload-missing" }); });
    await page.getByRole("button", { name: "Check saved status", exact: true }).click();
    await page.getByRole("button", { name: "Close unconfirmed save" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Retry original save" }).count(), 0);
    assert.equal(await page.evaluate(() => window.manualClosures), 0);
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Close unconfirmed save" }).click();
    await page.getByText("Closure reply lost in fixture", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Check saved status", exact: true }).click();
    await page.getByText("Original request closed or superseded. Loaded saved version 2.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.manualClosures), 1);
    assert.equal(await page.evaluate(() => window.requests.length), 1);
    assert.doesNotMatch(await page.locator(".ProseMirror").innerText(), /PRIVATE LOST SAVE/);
  } finally { await page.close(); }
});

test("recovered original never replaces a local draft with later collaborator text", async () => {
  const page = await manualSaveFixture();
  try {
    await page.evaluate(() => { window.apiDocument = { chapterId: "chapter", version: 3, nodes: [{ id: "n", type: "paragraph", text: "Collaborator revision" }] }; });
    await page.getByRole("button", { name: "Check saved status", exact: true }).click();
    await page.getByText(/Your original save is confirmed at version 2/).waitFor();
    assert.match(await page.locator(".ProseMirror").innerText(), /PRIVATE LOST SAVE/);
    assert.doesNotMatch(await page.locator(".ProseMirror").innerText(), /Collaborator revision/);
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.requests.length), 1);
  } finally { await page.close(); }
});

test("inconsistent current content cannot clear a confirmed original save pointer", async () => {
  const page = await manualSaveFixture();
  try {
    await page.evaluate(() => { window.apiDocument.nodes = [{ id: "wrong", type: "paragraph", text: "Wrong content at the same immutable version" }]; });
    await page.getByRole("button", { name: "Check saved status", exact: true }).click();
    await page.getByText(/current chapter could not be verified/i).waitFor();
    assert.equal(await page.getByRole("region", { name: "Manual save recovery" }).count(), 1);
    assert.match(await page.locator(".ProseMirror").innerText(), /PRIVATE LOST SAVE/);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith("bookworm:manual-save:"))), true);
    assert.equal(await page.evaluate(() => window.requests.length), 1);
  } finally { await page.close(); }
});

test("account switch blocks manual recovery before any API call and keeps the original pointer", async () => {
  const page = await manualSaveFixture(); let actor = "another-author";
  try {
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.getByRole("button", { name: "Check saved status", exact: true }).click();
    await page.getByText(/original account could not be verified/i).waitFor();
    assert.equal(await page.evaluate(() => window.manualReads), 0);
    assert.equal(await page.evaluate(() => window.requests.length), 1);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith("bookworm:manual-save:"))), true);
    actor = "fixture-author"; await page.getByRole("button", { name: "Recheck original account" }).click();
    assert.equal(await page.locator(".ProseMirror").getAttribute("contenteditable"), "false");
  } finally { await page.close(); }
});

test("manual recovery binds current reads and hides a late response after an account switch", async () => {
  const page = await manualSaveFixture(); let actor = "fixture-author";
  try {
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: actor } } }));
    await page.evaluate(() => {
      const original = window.bookwormApi.getChapterDocument;
      window.recoveryActors = [];
      window.bookwormApi.getChapterDocument = (chapterId, expectedActor) => { window.recoveryActors.push(expectedActor);
        return new Promise(resolve => { window.finishCurrentRecovery = async () => resolve(await original(chapterId, expectedActor)); }); };
      window.bookwormApi.listDocumentVersions = async (_chapterId, expectedActor) => { window.recoveryActors.push(expectedActor); return { versions: [] }; };
    });
    await page.getByRole("button", { name: "Check saved status", exact: true }).click();
    await page.waitForFunction(() => typeof window.finishCurrentRecovery === "function");
    actor = "another-author"; await page.evaluate(() => window.finishCurrentRecovery());
    await page.getByText(/original account could not be verified/i).waitFor();
    assert.deepEqual(await page.evaluate(() => window.recoveryActors), ["fixture-author", "fixture-author"]);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith("bookworm:manual-save:"))), true);
    assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).count(), 0);
  } finally { await page.close(); }
});

test("corrupt recovery metadata never unlocks a new save after remount", async () => {
  const page = await manualSaveFixture();
  try {
    await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(key => key.startsWith("bookworm:manual-save:"));
      sessionStorage.setItem(key, "invalid metadata"); window.renderBookEditor({ key: "reload-corrupt" });
    });
    await page.getByText(/manual save recovery record is invalid/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).isDisabled(), true);
    assert.equal(await page.locator(".ProseMirror").getAttribute("contenteditable"), "false");
    assert.equal(await page.evaluate(() => window.requests.length), 1);
  } finally { await page.close(); }
});

test("renaming a chapter preserves its unsaved manuscript and updates the chapter tree", async () => {
  const page = await fixture(1280, true);
  try {
    await page.evaluate(() => {
      window.titleRequests = [];
      window.bookwormApi.changeChapterTitle = async (chapterId, operationId, body) => {
        window.titleRequests.push(body);
        const titleDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.title))), b => b.toString(16).padStart(2, "0")).join("");
        return { chapterId, bookId: "book", operationId, expectedRevision: body.expectedRevision, titleDigest, status: "saved", receipt: { title: body.title, revision: 1 }, current: { title: body.title, revision: 1, updatedAt: "2026-10-23T15:01:00Z" } };
      };
    });
    const manuscript = page.getByRole("textbox", { name: "Manuscript editor" });
    await page.waitForFunction(() => document.querySelector(".ProseMirror")?.getAttribute("contenteditable") === "true");
    await manuscript.getByText("Imported first step", { exact: true }).click();
    await page.keyboard.press("End"); await page.keyboard.insertText(" Local unsaved ending.");
    // Compare the document model, not table controls rendered inside the editor.
    const before = await manuscript.evaluate(element => element.editor.getJSON());
    await page.getByRole("button", { name: "Edit chapter title", exact: true }).click();
    await page.getByLabel("New chapter title", { exact: true }).fill("A revised opening");
    await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Save chapter")?.disabled === true);
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Save title", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Chapter title saved" }).waitFor();
    assert.deepEqual(await manuscript.evaluate(element => element.editor.getJSON()), before);
    assert.equal(await page.getByRole("navigation", { name: "Chapters" }).getByText("A revised opening", { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => window.requests.length), 0);
    assert.equal(await page.evaluate(() => window.titleRequests.length), 1);
    await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Save chapter")?.disabled === false);
    await page.waitForFunction(() => document.querySelector(".ProseMirror")?.getAttribute("contenteditable") === "true");
    await page.getByRole("button", { name: "Edit table", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).isEnabled(), true);
    await page.getByRole("button", { name: "Save chapter", exact: true }).click();
    await page.waitForFunction(() => window.requests.length === 1);
    const { saved, original } = await page.evaluate(() => ({ saved: window.requests[0].nodes, original: window.nodes }));
    const savedLists = saved.filter(node => node.type === "listItem");
    assert.deepEqual(savedLists.map(({ attributes: { richText, ...attributes }, ...node }) => ({ ...node, attributes })),
      original.filter(node => node.type === "listItem").map(node => node.id === "first" ? { ...node, text: `${node.text} Local unsaved ending.` } : node));
    for (const node of savedLists) assert.deepEqual(node.attributes.richText, [{ type: "text", text: node.text, marks: [] }]);
    assert.deepEqual(saved.find(node => node.type === "table"), original.find(node => node.type === "table"));
    assert.equal(saved.at(-1).type, "paragraph");
    assert.equal(saved.at(-1).text, "");
    await page.screenshot({ path: resolve(artifacts, "chapter-title-keeps-manuscript.png"), fullPage: true });
  } finally { await page.close(); }
});

test("late save recovery cannot adopt an old chapter or remove its recovery pointer", async () => {
  const page = await manualSaveFixture();
  try {
    await page.evaluate(() => {
      const original = window.bookwormApi.getManualChapterSaveStatus;
      window.bookwormApi.getManualChapterSaveStatus = (...args) => new Promise(resolve => { window.finishRecovery = async () => resolve(await original(...args)); });
      window.bookwormApi.getChapterDocument = async chapterId => ({ role: "owner", document: chapterId === "chapter" ? window.apiDocument
        : { chapterId, version: 1, nodes: [{ id: "second", type: "paragraph", text: "Second chapter manuscript" }] } });
    });
    await page.getByRole("button", { name: "Check saved status", exact: true }).click();
    await page.waitForFunction(() => typeof window.finishRecovery === "function");
    await page.evaluate(() => window.renderBookEditor({ initialChapterId: "second" }));
    await page.getByText("Second chapter manuscript", { exact: true }).waitFor();
    await page.evaluate(async () => { await window.finishRecovery(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    assert.equal(await page.getByText("Second chapter manuscript", { exact: true }).count(), 1);
    assert.equal(await page.locator(".ProseMirror").getAttribute("contenteditable"), "true");
    assert.equal(await page.getByRole("region", { name: "Manual save recovery" }).count(), 0);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith("bookworm:manual-save:"))), true);
  } finally { await page.close(); }
});

for (const scenario of ["wrong-book", "foreign-chapter", "duplicate-chapter", "malformed-list"]) {
  test("initial author load refuses " + scenario + " without opening a chapter", async () => {
    const page = await fixture(1280, true);
    try {
      await page.evaluate(kind => {
        window.documentReads = [];
        window.bookwormApi.getBook = async () => ({ book: { id: kind === "wrong-book" ? "book" : "other", workspace_id: "workspace", title: "Other manuscript" }, role: "owner" });
        window.bookwormApi.listChapters = async () => kind === "malformed-list" ? { chapters: null } : { chapters: kind === "duplicate-chapter" ? [{ id: "chapter", book_id: "other", title: "One" }, { id: "chapter", book_id: "other", title: "Two" }] : [{ id: "chapter", book_id: kind === "foreign-chapter" ? "book" : "other", title: "One" }] };
        window.renderBookEditor({ bookId: "other" });
      }, scenario);
      await page.getByRole("alert").filter({ hasText: "The book or chapter list could not be verified. Try loading this book again." }).waitFor({ timeout: 4000 });
      assert.deepEqual(await page.evaluate(() => window.documentReads), []);
      assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).count(), 0);
    } finally { await page.close(); }
  });
}

test("a verified retry loads the intended book after a mismatched chapter response", async () => {
  const page = await fixture(1280, true);
  try {
    await page.evaluate(() => {
      window.documentReads = [];
      window.bookwormApi.getBook = async () => ({ book: { id: "other", workspace_id: "workspace", title: "Other manuscript" }, role: "owner" });
      window.bookwormApi.listChapters = async () => ({ chapters: [{ id: "chapter", book_id: "book", title: "Wrong book" }] });
      window.renderBookEditor({ bookId: "other" });
    });
    await page.getByRole("alert").filter({ hasText: "The book or chapter list could not be verified." }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.documentReads), []);
    await page.evaluate(() => { window.bookwormApi.listChapters = async () => ({ chapters: [{ id: "chapter", book_id: "other", title: "Intended chapter" }] }); });
    await page.getByRole("button", { name: "Retry loading book" }).click();
    await page.getByRole("textbox", { name: "Manuscript editor" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.documentReads), ["chapter"]);
    assert.equal(await page.getByRole("heading", { name: "Other manuscript" }).count(), 1);
  } finally { await page.close(); }
});


test("uppercase book and chapter UUIDs load canonical manuscript scope", async () => {
  const page = await fixture(1280, true);
  try {
    await page.evaluate(() => {
      const book = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", chapter = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      window.scopeCalls = []; window.documentReads = [];
      window.bookwormApi.getBook = async id => { window.scopeCalls.push(["book", id]); return { book: { id: book, workspace_id: "workspace", title: "Canonical manuscript" }, role: "owner" }; };
      window.bookwormApi.listChapters = async id => { window.scopeCalls.push(["chapters", id]); return { chapters: [{ id: chapter, book_id: book, title: "Canonical chapter" }] }; };
      window.bookwormApi.getChapterTitle = async id => ({ bookId: book, chapterId: id, title: "Canonical chapter", revision: 0, updatedAt: "2026-10-23T15:00:00Z", role: "owner" });
      window.bookwormApi.getChapterDocument = async id => { window.documentReads.push(id); return { role: "owner", document: { chapterId: id, version: 1, nodes: structuredClone(window.nodes) } }; };
      window.renderBookEditor({ bookId: book.toUpperCase(), initialChapterId: chapter.toUpperCase() });
    });
    await page.getByRole("heading", { name: "Canonical manuscript" }).waitFor();
    await page.getByRole("textbox", { name: "Manuscript editor" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.scopeCalls), [["book", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"], ["chapters", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]]);
    assert.deepEqual(await page.evaluate(() => window.documentReads), ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
    assert.equal(await page.getByRole("navigation", { name: "Chapters" }).getByText("Canonical chapter", { exact: true }).count(), 1);
  } finally { await page.close(); }
});
