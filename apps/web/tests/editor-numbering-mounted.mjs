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
    const chapters = [{ id: "chapter", title: "First chapter" }, { id: "second", title: "Second chapter" }];
    window.bookwormApi = {
      getBook: async () => ({ book: { id: "book", workspace_id: "workspace", title: "Author manuscript" }, role: "owner" }),
      listChapters: async () => ({ chapters }),
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
        return { chapter: { id: "created", title: body.title } };
      };
    });
    await page.getByLabel("New chapter", { exact: true }).fill("Original chapter intent");
    await page.getByLabel("Optional AI drafting brief", { exact: true }).fill("Original author brief");
    await page.getByRole("button", { name: "Add & review AI brief", exact: true }).click();
    await page.waitForFunction(() => typeof window.failOriginalCreation === "function");
    await page.evaluate(() => { window.bookwormApi.listChapters = async () => ({ chapters: [
      { id: "chapter", title: "First chapter" }, { id: "second", title: "Second chapter" }, { id: "created", title: "Original chapter intent" },
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
        return { chapter: { id: "paid-chapter", title: body.title } };
      };
      api.listAiJobs = async () => ({ jobs: flow.review ? [structuredClone(flow.review)] : [] });
      const quote = { requestId: crypto.randomUUID(), status: "ready", agentType: "writer", model: "fixture-writer-model",
        countedInputTokens: 420, maxOutputTokens: 1200, reservedCredits: 24, expiresAt: new Date(Date.now() + 600000).toISOString() };
      api.createAiReviewQuote = async (bookId, body) => { flow.quotes.push({ bookId, ...structuredClone(body) }); return { quote }; };
      api.acceptAiReviewQuote = async (bookId, requestId, expectedCredits) => {
        flow.acceptances.push({ bookId, requestId, expectedCredits });
        flow.review = { id: "paid-job", book_id: bookId, chapter_ids: [document.chapterId], agent_type: "writer", status: "succeeded",
          context_source_count: 0, usage_json: {}, created_at: new Date().toISOString(), suggestions: [{
            id: "paid-suggestion", entity_type: "chapter", entity_id: document.chapterId, status: "pending", rationale: "Opening scene for author review",
            operation_json: { operationId: crypto.randomUUID(), type: "replace_text", expectedVersion: 1,
              target: { chapterId: document.chapterId, nodeId: "paid-node" }, payload: { nodeId: "paid-node", from: 0, to: 0, text: "Mara reached the harbor before dawn." } },
          }] };
        throw new Error("Accepted review reply unconfirmed");
      };
      api.getAiReviewQuote = async () => { flow.statusReads++; return { quote, ...(flow.review ? { job: { id: flow.review.id, status: flow.review.status } } : {}) }; };
      api.getAiJob = async () => structuredClone(flow.review);
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
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    if (refreshFails) {
      await page.getByRole("alert").filter({ hasText: "chapter refresh unavailable" }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Manuscript editor" }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Save chapter", exact: true }).count(), 0);
      await page.getByRole("button", { name: "Retry loading chapter", exact: true }).click();
      await page.getByText("Recent saved reviews", { exact: true }).click();
      await page.getByRole("button", { name: "Open", exact: true }).click();
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
