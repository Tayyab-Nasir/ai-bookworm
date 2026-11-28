// Actual React title editor, synthetic transport; no real account, API or provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { chromium } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const bundle = await build({ stdin: { contents: `import React from "react";
import { createRoot } from "react-dom/client";
import Editor from "./apps/web/components/ChapterTitleEditor";
const root = createRoot(document.getElementById("root")); let key = 0;
window.mount = (props = {}) => root.render(React.createElement(Editor, { key: ++key, bookId: "book", chapterId: "chapter", userId: "author", initialTitle: "Imported chapter", canEdit: true, disabled: false, onTitle: t => { window.visibleTitle = t; }, onState: s => { window.editorState = s; }, ...props }));`,
  resolveDir: process.cwd(), loader: "tsx" }, write: false, bundle: true, format: "iife", platform: "browser", jsx: "automatic",
  plugins: [{ name: "local-title-api", setup(builder) {
    builder.onResolve({ filter: /^\.\/api$/ }, () => ({ path: "api", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const apiClient = () => window.bookwormApi;" }));
  } }],
});
const stylePath = resolve("apps/web/styles/globals.css");
const styles = await postcss([tailwind({ base: resolve("apps/web"), optimize: false })]).process(await readFile(stylePath, "utf8"), { from: stylePath });
const artifacts = await mkdtemp(resolve(tmpdir(), "bookworm-chapter-title-mounted-"));
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
test.after(() => browser.close());

async function fixture(mode = "normal", width = 1280, props = {}) {
  const page = await browser.newPage({ viewport: { width, height: 800 } }); page.setDefaultTimeout(6000);
  await page.route("**/*", route => route.fulfill(new URL(route.request().url()).pathname === "/api/auth/session"
    ? { contentType: "application/json", body: JSON.stringify({ user: { id: "author" } }) }
    : { contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><main id="root"></main></body></html>' }));
  await page.goto("http://127.0.0.1/chapter-title-fixture");
  await page.addStyleTag({ content: styles.css + "body {background:#000;color:#fff;padding:16px;} main {max-width:720px;margin:0 auto;}" });
  await page.evaluate(mode => {
    window.mode = mode; window.calls = []; window.receipt = null;
    window.current = { title: "Imported chapter", revision: 0, updatedAt: "2026-10-23T15:00:00Z" };
    const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), b => b.toString(16).padStart(2, "0")).join("");
    const result = (operationId, expectedRevision, titleDigest, status = "not_found") => ({ operationId, expectedRevision, titleDigest, chapterId: "chapter", bookId: "book", status, receipt: null, current: { ...window.current } });
    window.bookwormApi = {
      getChapterTitle: async () => ({ ...window.current, bookId: "book", chapterId: "chapter", role: "writer" }),
      changeChapterTitle: async (id, op, body, actor) => {
        window.calls.push({ mode: "save", id, op, body, actor });
        const d = await hash(body.title);
        if (window.mode === "pending") throw Error("Response lost before outcome was confirmed");
        if (window.mode === "conflict") { window.current = { ...window.current, title: "Collaborator chapter", revision: 1 }; return result(op, body.expectedRevision, d, "conflict"); }
        window.current = { ...window.current, title: body.title, revision: 1 };
        window.receipt = { ...result(op, body.expectedRevision, d, "saved"), receipt: { title: body.title, revision: 1 } };
        if (window.mode === "lost") throw Error("Response lost after commit");
        if (window.mode === "wrong") return { ...window.receipt, operationId: "wrong" };
        return window.receipt;
      },
      getChapterTitleChange: async (id, op, revision, d, actor) => { window.calls.push({ mode: "read", id, op, actor }); return window.receipt ?? result(op, revision, d); },
      closeChapterTitleChange: async (id, op, revision, d, actor) => { window.calls.push({ mode: "close", id, op, actor }); return window.receipt ?? result(op, revision, d, "closed"); },
    };
  }, mode);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(props => window.mount(props), props);
  if (props.canEdit !== false) await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Edit chapter title")?.disabled);
  return page;
}
async function rename(page, title = "The Arrival") { await page.getByRole("button", { name: "Edit chapter title", exact: true }).click(); await page.getByLabel("New chapter title", { exact: true }).fill(title); await page.getByRole("button", { name: "Save title", exact: true }).click(); }

test("title editor saves one explicit rename and renders the returned canonical title", async () => {
  const p = await fixture(); try {
    assert.equal(await p.evaluate(() => window.calls.length), 0); await rename(p, "باب اوّل — 🌙");
    await p.getByRole("status").filter({ hasText: "Chapter title saved" }).waitFor();
    assert.equal(await p.getByRole("heading", { level: 2 }).innerText(), "باب اوّل — 🌙");
    assert.equal(await p.evaluate(() => window.calls.length), 1); assert.equal(await p.evaluate(() => sessionStorage.length), 0);
    await p.screenshot({ path: resolve(artifacts, "title-saved-desktop.png"), fullPage: true });
  } finally { await p.close(); }
});
test("lost title response survives remount without storing text or replaying the write", async () => {
  const p = await fixture("lost"); try {
    await rename(p); await p.getByRole("button", { name: "Check title status" }).waitFor();
    assert.equal(await p.evaluate(() => JSON.stringify(sessionStorage).includes("The Arrival")), false);
    await p.evaluate(() => window.mount()); await p.getByRole("button", { name: "Check title status" }).click();
    await p.getByRole("status").filter({ hasText: "Chapter title saved" }).waitFor();
    assert.deepEqual(await p.evaluate(() => window.calls.map(c => c.mode)), ["save", "read"]);
  } finally { await p.close(); }
});
test("missing title result stays unresolved; explicit closure never overwrites the current title", async () => {
  const p = await fixture("pending", 320); try {
    await rename(p); await p.getByRole("button", { name: "Check title status" }).click();
    await p.getByRole("button", { name: "Close unconfirmed rename" }).waitFor();
    assert.equal(await p.evaluate(() => window.editorState.pending), true);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.screenshot({ path: resolve(artifacts, "title-recovery-mobile.png"), fullPage: true });
    await p.getByRole("button", { name: "Close unconfirmed rename" }).click();
    await p.getByRole("status").filter({ hasText: "Unconfirmed rename closed" }).waitFor();
    assert.equal(await p.getByRole("heading", { level: 2 }).innerText(), "Imported chapter");
    assert.deepEqual(await p.evaluate(() => window.calls.map(c => c.mode)), ["save", "read", "close"]);
  } finally { await p.close(); }
});
test("retry retains the exact operation, title and revision, and never invents a second request", async () => {
  const p = await fixture("pending"); try {
    await rename(p); await p.getByRole("button", { name: "Check title status" }).click();
    await p.getByRole("button", { name: "Retry original rename" }).waitFor(); await p.evaluate(() => { window.mode = "normal"; });
    await p.getByRole("button", { name: "Retry original rename" }).click(); await p.getByRole("status").filter({ hasText: "Chapter title saved" }).waitFor();
    const calls = await p.evaluate(() => window.calls.filter(c => c.mode === "save")); assert.deepEqual(calls[1], calls[0]);
  } finally { await p.close(); }
});
test("reloaded missing rename cannot retry lost title text and requires explicit closure", async () => {
  const p = await fixture("pending"); try {
    await rename(p); await p.getByRole("button", { name: "Check title status" }).waitFor(); await p.evaluate(() => window.mount());
    await p.getByRole("button", { name: "Check title status" }).click(); await p.getByRole("button", { name: "Close unconfirmed rename" }).waitFor();
    assert.equal(await p.getByRole("button", { name: "Retry original rename" }).count(), 0);
    assert.equal(await p.evaluate(() => window.calls.filter(c => c.mode === "save").length), 1);
  } finally { await p.close(); }
});
test("conflict preserves the proposed title for explicit review, without overwriting a collaborator", async () => {
  const p = await fixture("conflict"); try {
    await rename(p); await p.getByRole("status").filter({ hasText: "Another edit changed" }).waitFor();
    assert.equal(await p.getByRole("heading", { level: 2 }).innerText(), "Collaborator chapter");
    assert.equal(await p.getByLabel("New chapter title", { exact: true }).inputValue(), "The Arrival");
    assert.equal(await p.evaluate(() => window.calls.length), 1);
    await p.getByRole("button", { name: "Cancel title edit" }).click(); assert.equal(await p.getByLabel("New chapter title", { exact: true }).count(), 0);
  } finally { await p.close(); }
});
test("malformed receipt leaves title recovery locked instead of reporting success", async () => {
  const p = await fixture("wrong"); try {
    await rename(p); await p.getByRole("alert").filter({ hasText: "does not match" }).waitFor();
    assert.equal(await p.evaluate(() => window.editorState.pending), true); assert.equal(await p.evaluate(() => sessionStorage.length), 1);
  } finally { await p.close(); }
});
test("changed account cannot dispatch or recover the previous author's title request", async () => {
  const p = await fixture("pending"); try {
    await rename(p); await p.getByRole("button", { name: "Check title status" }).waitFor();
    await p.route("**/api/auth/session", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ user: { id: "different-author" } }) }));
    await p.getByRole("button", { name: "Check title status" }).click(); await p.getByRole("alert").filter({ hasText: "account changed" }).waitFor();
    assert.equal(await p.evaluate(() => window.calls.length), 1); assert.equal(await p.evaluate(() => sessionStorage.length), 1);
  } finally { await p.close(); }
});
test("failed recovery storage prevents a title write", async () => {
  const p = await fixture(); try {
    await p.evaluate(() => { Storage.prototype.setItem = () => { throw Error("Storage denied"); }; });
    await rename(p); await p.getByRole("alert").filter({ hasText: "Storage denied" }).waitFor();
    assert.equal(await p.evaluate(() => window.calls.length), 0); assert.equal(await p.getByLabel("New chapter title", { exact: true }).inputValue(), "The Arrival");
  } finally { await p.close(); }
});
test("read-only title view has no mutation controls", async () => {
  const p = await fixture("normal", 320, { canEdit: false }); try {
    await p.getByRole("heading", { name: "Imported chapter" }).waitFor(); assert.equal(await p.getByRole("button").count(), 0);
    assert.equal(await p.evaluate(() => window.calls.length), 0);
  } finally { await p.close(); }
});
console.log(`Chapter title browser artifacts: ${artifacts}`);
