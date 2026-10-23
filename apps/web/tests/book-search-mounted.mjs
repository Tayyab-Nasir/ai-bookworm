// Actual React source search/reader, isolated synthetic transport; no real users,
// manuscript, database, provider calls, charges or localhost app changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { chromium } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const BOOK = "11111111-1111-4111-8111-111111111111", OTHER = "99999999-9999-4999-8999-999999999999";
const bundle = await build({ stdin: { contents: `import React from "react";
import { createRoot } from "react-dom/client";
import Panel from "./apps/web/components/BookSearchPanel";
const root = createRoot(document.getElementById("root"));
window.mount = bookId => root.render(React.createElement(Panel, {bookId, onOpenBibleEntry:id=>{window.openedBible=id;}}));`,
  resolveDir: process.cwd(), loader: "tsx" }, write: false, bundle: true, format: "iife", platform: "browser", jsx: "automatic",
  plugins: [{ name: "synthetic-search-transport", setup(builder) {
    builder.onResolve({ filter: /^\.\/api$/ }, () => ({ path: "api", namespace: "fixture" }));
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ resolveDir: process.cwd(), contents: args.path === "api"
      ? "export const apiClient = () => window.bookwormApi;"
      : 'import React from "react"; export default function Link(props) {return React.createElement("a",props);}' }));
  } }],
});
const stylePath = resolve("apps/web/styles/globals.css");
const styles = await postcss([tailwind({ base: resolve("apps/web"), optimize: false })]).process(await readFile(stylePath, "utf8"), { from: stylePath });
const artifacts = await mkdtemp(resolve(tmpdir(), "bookworm-search-reader-"));
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
test.after(() => browser.close());

async function fixture(width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(6000);
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><main id="root"></main></body></html>' }));
  await page.goto("http://127.0.0.1/source-reader-fixture");
  await page.addStyleTag({ content: styles.css + "body{background:#050505;color:#fff;padding:12px;} main{max-width:1100px;margin:0 auto;}" });
  await page.evaluate(() => {
    window.calls = []; window.searchMode = "normal"; window.sourceMode = "normal"; window.historical = false;
    window.sourceText = ("🌙 Elara opened the atlas. The silver compass pointed toward the lantern harbor.\n").repeat(120);
    window.row = { id: "44444444-4444-4444-8444-444444444444", source_type: "manuscript",
      chapter_id: "22222222-2222-4222-8222-222222222222", document_version_id: "33333333-3333-4333-8333-333333333333",
      bible_item_id: null, node_id: "p1", chunk_index: 0, text_hash: "a".repeat(32), title: "The Lantern Harbor",
      excerpt: Array.from(window.sourceText).slice(0, 1800).join(""), score: 0.8 };
    window.bookwormApi = {
      searchBook: async (bookId, body) => {
        window.calls.push({ kind: "search", bookId, body });
        const result = { query: body.query, strategy: "postgres_full_text", results: [ { ...window.row },
          { ...window.row, id: "55555555-5555-4555-8555-555555555555", source_type: "bible",
            bible_item_id: "66666666-6666-4666-8666-666666666666", chapter_id: null, document_version_id: null,
            node_id: null, title: "Elara · Cartographer", excerpt: "Keeps the silver compass in her coat pocket." } ] };
        if (window.searchMode === "hold") return new Promise(resolve => { window.releaseSearch = () => resolve(result); });
        if (window.searchMode === "wrong") return { ...result, query: "foreign query" };
        if (window.searchMode === "empty") return { ...result, results: [] };
        return result;
      },
      readSearchPassage: async (bookId, body) => {
        window.calls.push({ kind: "source", bookId, body });
        const { offset, ...citation } = body, points = Array.from(window.sourceText);
        const startOffset = offset ?? Math.max(0, body.chunkIndex - 300), endOffset = Math.min(points.length, startOffset + 6000);
        const result = { bookId, citation, chapterTitle: "The Lantern Harbor", versionNumber: 3, isCurrentVersion: !window.historical,
          text: points.slice(startOffset, endOffset).join(""), startOffset, endOffset, totalLength: points.length,
          previousOffset: startOffset ? Math.max(0, startOffset - 6000) : null,
          nextOffset: endOffset < points.length ? endOffset : null, matchedStart: body.chunkIndex, matchedEnd: Math.min(points.length, body.chunkIndex + 1800) };
        if (window.sourceMode === "hold") return new Promise(resolve => { window.releaseSource = () => resolve(result); });
        if (window.sourceMode === "error") throw Error("Source unavailable. Retry reading the source.");
        if (window.sourceMode === "wrong") return { ...result, bookId: "99999999-9999-4999-8999-999999999999" };
        if (window.sourceMode === "changed") return { ...result, versionNumber: 4 };
        return result;
      },
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(bookId => window.mount(bookId), BOOK);
  await page.getByRole("heading", { name: "Search your book" }).waitFor();
  return page;
}
async function search(page, phrase = "silver compass") {
  await page.getByLabel("Words or phrase").fill(phrase);
  await page.getByRole("button", { name: "Search saved sources", exact: true }).click();
}
const sources = page => page.evaluate(() => window.calls.filter(call => call.kind === "source"));

test("search loads excerpts only; explicit read returns exact saved context and Bible navigation remains separate", async () => {
  const p = await fixture(); try {
    assert.equal((await sources(p)).length, 0); await search(p);
    await p.getByRole("status").filter({ hasText: "2 matching" }).waitFor(); assert.equal((await sources(p)).length, 0);
    await p.getByRole("button", { name: "Open Book Bible entry" }).click();
    assert.equal(await p.evaluate(() => window.openedBible), "66666666-6666-4666-8666-666666666666");
    const reader = p.getByRole("button", { name: "Read cited source", exact: true }); await reader.focus(); await p.keyboard.press("Enter");
    await p.getByRole("status").filter({ hasText: "current when loaded" }).waitFor();
    assert.equal((await sources(p)).length, 1);
    assert.equal(await p.getByLabel("Cited source text", { exact: true }).innerText(), await p.evaluate(() => Array.from(window.sourceText).slice(0,6000).join("")));
    assert.equal(await p.locator("mark").innerText(), await p.evaluate(() => Array.from(window.sourceText).slice(0,1800).join("")));
    assert.equal(await p.getByRole("link", { name: "Open current chapter" }).getAttribute("href"), `/books/${BOOK}?chapter=22222222-2222-4222-8222-222222222222`);
    await p.screenshot({ path: resolve(artifacts, "search-source-desktop.png"), fullPage: true });
    await p.getByRole("button", { name: "Hide cited source" }).click(); await p.getByRole("button", { name: "Read cited source", exact: true }).click();
    assert.equal((await sources(p)).length, 1, "local hide/show must not refetch");
  } finally { await p.close(); }
});
test("historical source stays historical with safe Unicode pagination and no mobile overflow", async () => {
  const p = await fixture(320); try {
    await p.evaluate(() => { window.historical = true; }); await search(p);
    await p.getByRole("button", { name: "Read cited source", exact: true }).click();
    await p.getByRole("status").filter({ hasText: "earlier version; the chapter has changed" }).waitFor();
    await p.getByLabel("Cited source text", { exact: true }).focus(); await p.keyboard.press("PageDown");
    assert(await p.getByLabel("Cited source text", { exact: true }).evaluate(node=>node.scrollTop)>0);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.getByRole("button", { name: "Hide cited source" }).scrollIntoViewIfNeeded();
    await p.screenshot({ path: resolve(artifacts, "search-source-mobile.png"), fullPage: true });
    await p.getByRole("button", { name: "Next source section" }).click();
    await p.waitForFunction(()=>document.querySelector('[aria-label="Cited source text"]')?.textContent===Array.from(window.sourceText).slice(6000).join(""));
    assert.equal(await p.locator("mark").count(), 0); assert.equal((await sources(p)).at(-1).body.offset, 6000);
    assert.equal(await p.getByRole("button", { name: "Next source section" }).getAttribute("aria-disabled"), "true");
    await p.getByRole("button", { name: "Previous source section" }).click();
    await p.waitForFunction(()=>document.querySelector('[aria-label="Cited source text"]')?.textContent===Array.from(window.sourceText).slice(0,6000).join(""));
    assert.equal((await sources(p)).at(-1).body.offset, 0);
  } finally { await p.close(); }
});
test("source double-click cannot dispatch a duplicate read", async () => {
  const p = await fixture(); try {
    await p.evaluate(()=>{window.sourceMode="hold";}); await search(p);
    await p.getByRole("button",{name:"Read cited source",exact:true}).evaluate(button=>{button.click();button.click();});
    await p.getByRole("button",{name:"Loading cited source…"}).waitFor(); assert.equal((await sources(p)).length,1);
    await p.evaluate(()=>window.releaseSource()); await p.getByLabel("Cited source text",{exact:true}).waitFor();
  } finally { await p.close(); }
});
test("failed read can be explicitly retried; mismatched source never renders", async () => {
  const p=await fixture(); try {
    await p.evaluate(()=>{window.sourceMode="error";}); await search(p);
    await p.getByRole("button",{name:"Read cited source",exact:true}).click(); await p.getByRole("alert").filter({hasText:"Source unavailable"}).waitFor();
    assert.equal(await p.getByLabel("Cited source text",{exact:true}).count(),0);
    await p.evaluate(()=>{window.sourceMode="wrong";}); await p.getByRole("button",{name:"Read cited source",exact:true}).click();
    await p.getByRole("alert").filter({hasText:"could not be verified"}).waitFor();
    assert.equal(await p.getByLabel("Cited source text",{exact:true}).count(),0);
    await p.evaluate(()=>{window.sourceMode="normal";}); await p.getByRole("button",{name:"Read cited source",exact:true}).click();
    await p.getByLabel("Cited source text",{exact:true}).waitFor(); assert.equal((await sources(p)).length,3);
  } finally { await p.close(); }
});
test("late source response cannot survive a book switch", async () => {
  const p=await fixture(); try {
    await p.evaluate(()=>{window.sourceMode="hold";}); await search(p); await p.getByRole("button",{name:"Read cited source",exact:true}).click();
    await p.evaluate(bookId=>window.mount(bookId),OTHER); await p.waitForFunction(()=>document.querySelector('input[type="search"]')?.value==='');
    await p.evaluate(()=>window.releaseSource()); await p.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(await p.getByLabel("Cited source text",{exact:true}).count(),0); assert.equal(await p.locator("article").count(),0);
    await p.evaluate(()=>{window.sourceMode="normal";}); await search(p); await p.getByRole("button",{name:"Read cited source",exact:true}).click();
    await p.getByLabel("Cited source text",{exact:true}).waitFor(); assert.equal((await sources(p)).at(-1).bookId,OTHER);
  } finally { await p.close(); }
});
test("late search and malformed envelope cannot appear under a new phrase", async () => {
  const p=await fixture(); try {
    await p.evaluate(()=>{window.searchMode="hold";}); await search(p); await p.getByRole("button",{name:"Searching…"}).waitFor();
    await p.getByLabel("Words or phrase").fill("lantern"); await p.evaluate(()=>window.releaseSearch()); await p.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(await p.locator("article").count(),0);
    await p.evaluate(()=>{window.searchMode="wrong";}); await p.getByRole("button",{name:"Search saved sources",exact:true}).click();
    await p.getByRole("alert").filter({hasText:"could not be verified"}).waitFor(); assert.equal(await p.locator("article").count(),0);
    await p.evaluate(()=>{window.searchMode="empty";}); await p.getByRole("button",{name:"Search saved sources",exact:true}).click();
    await p.getByRole("status").filter({hasText:"No matching passage"}).waitFor();
  } finally { await p.close(); }
});
test("inconsistent immutable version on pagination keeps the previous verified page and reports failure", async () => {
  const p=await fixture(); try {
    await search(p); await p.getByRole("button",{name:"Read cited source",exact:true}).click(); await p.getByLabel("Cited source text",{exact:true}).waitFor();
    const initial=await p.getByLabel("Cited source text",{exact:true}).innerText(); await p.evaluate(()=>{window.sourceMode="changed";});
    await p.getByRole("button",{name:"Next source section"}).click(); await p.getByRole("alert").filter({hasText:"changed unexpectedly"}).waitFor();
    assert.equal(await p.getByLabel("Cited source text",{exact:true}).innerText(),initial);
  } finally { await p.close(); }
});
test("manuscript-like HTML is text, never an executable browser node", async () => {
  const p=await fixture(320); try {
    await p.evaluate(()=>{window.sourceText='<img src=x onerror="window.injected=true">'.repeat(40);window.row.excerpt=window.sourceText;});
    await search(p); await p.getByRole("button",{name:"Read cited source",exact:true}).click(); await p.getByLabel("Cited source text",{exact:true}).waitFor();
    assert.equal(await p.locator("article img").count(),0); assert.equal(await p.evaluate(()=>!!window.injected),false);
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  } finally { await p.close(); }
});
console.log(`Search source browser artifacts: ${artifacts}`);
