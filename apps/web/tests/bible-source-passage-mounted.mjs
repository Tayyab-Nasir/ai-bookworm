// Mounted reader with synthetic private transport; no provider or database calls.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const bundle = await build({
  stdin: { contents: `import React from "react";
    import { createRoot } from "react-dom/client";
    import Reader from "./apps/web/components/BibleSourcePassage";
    const root = createRoot(document.getElementById("root"));
    window.mountReader = (actor, jobId = "job-a") => root.render(React.createElement(Reader, {
      actorId: actor, bookId: "book-a", jobId, title: "Arrival",
      citation: { chapterId: "chapter-a", documentVersionId: "version-a", nodeId: "node-a", textHash: "a".repeat(64) },
      readRequest: (path, method, body) => window.readEvidence(actor, path, method, body),
    }));`, loader: "tsx", resolveDir: process.cwd() },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
});
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
test.after(() => browser.close());

async function fixture() {
  const page = await browser.newPage();
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div>' }));
  await page.goto("http://127.0.0.1/");
  await page.evaluate(() => {
    window.calls = []; window.mode = "verified";
    const prefix = "Earlier text. ".repeat(2100) + "😀";
    const excerpt = "Elara carries the silver compass.";
    window.readingStart = prefix.length;
    window.readingEnd = prefix.length + excerpt.length;
    window.sourceText = prefix + excerpt + " Later text.".repeat(2300);
    window.readEvidence = async (actor, path, method, body) => {
      window.calls.push({ actor, path, method, body });
      if (window.mode === "denied") throw Object.assign(new Error("Access to this source was revoked."), { status: 403 });
      const held = window.mode === "hold" && actor === "actor-a";
      if (held) await new Promise(resolve => { window.releaseOldRead = resolve; });
      const source = held ? window.sourceText.slice(0, window.readingStart)
        + "PRIVATE OLD ACCOUNT".padEnd(excerpt.length, ".") + window.sourceText.slice(window.readingEnd) : window.sourceText;
      if (held) window.oldReadResolved = true;
      const batchRange = window.mode === "unavailable" ? null : { startOffset: window.readingStart, endOffset: window.readingEnd };
      const startOffset = body.offset ?? batchRange?.startOffset ?? 0;
      let endOffset = Math.min(window.sourceText.length, startOffset + 24000);
      if (endOffset < window.sourceText.length && /[\uDC00-\uDFFF]/u.test(window.sourceText.charAt(endOffset))
        && /[\uD800-\uDBFF]/u.test(window.sourceText.charAt(endOffset - 1))) endOffset--;
      return { chapterTitle: "Arrival", versionNumber: 3, isCurrentVersion: false,
        text: source.slice(startOffset, endOffset), startOffset, endOffset, totalLength: window.sourceText.length,
        truncated: endOffset < window.sourceText.length, nextOffset: endOffset < window.sourceText.length ? endOffset : null,
        batchRange: window.mode === "invalid" ? { startOffset: -1, endOffset: 2 } : batchRange };
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.mountReader("actor-a"));
  return page;
}

test("candidate reader opens and highlights the verified batch and keeps the full source reachable", async () => {
  const page = await fixture();
  try {
    await page.getByRole("button", { name: "Read source passage" }).click();
    await expect(page.locator("mark")).toHaveText("Elara carries the silver compass.");
    await expect(page.getByText(/citation does not verify the candidate/)).toBeVisible();
    const first = (await page.evaluate(() => window.calls))[0];
    assert.equal(first.actor, "actor-a");
    assert.equal(first.method, "POST");
    assert.equal(first.body.jobId, "job-a");
    assert.equal(Object.hasOwn(first.body, "offset"), false);
    await page.getByRole("button", { name: "Start of saved passage" }).click();
    await expect(page.locator("mark")).toHaveCount(0);
    await page.getByRole("button", { name: "Show AI reading batch" }).click();
    await expect(page.locator("mark")).toHaveText("Elara carries the silver compass.");
    await page.getByRole("button", { name: "Next passage section" }).click();
    await expect(page.locator("mark")).toHaveCount(0);
    await page.getByRole("button", { name: "Previous passage section" }).click();
    await expect(page.locator("mark")).toHaveText("Elara carries the silver compass.");
    await expect(page.getByText(/earlier version; the chapter has changed/)).toBeVisible();
  } finally { await page.close(); }
});

test("unavailable batch can be rechecked without claiming or generating evidence", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.mode = "unavailable"; });
    await page.getByRole("button", { name: "Read source passage" }).click();
    await expect(page.getByText(/reading range is unavailable/)).toBeVisible();
    await expect(page.locator("mark")).toHaveCount(0);
    await page.evaluate(() => { window.mode = "verified"; });
    await page.getByRole("button", { name: "Recheck AI reading range" }).click();
    await expect(page.locator("mark")).toHaveText("Elara carries the silver compass.");
    assert.equal((await page.evaluate(() => window.calls)).length, 2);
  } finally { await page.close(); }
});

test("malformed positions and late prior-account results never replace the visible passage", async () => {
  const page = await fixture();
  try {
    await page.getByRole("button", { name: "Read source passage" }).click();
    await expect(page.locator("mark")).toHaveText("Elara carries the silver compass.");
    await page.evaluate(() => { window.mode = "invalid"; });
    await page.getByRole("button", { name: "Next passage section" }).click();
    await expect(page.getByRole("alert")).toContainText("could not be verified");
    await expect(page.locator("mark")).toHaveText("Elara carries the silver compass.");
    await page.evaluate(() => { window.mode = "hold"; window.mountReader("actor-b"); window.mountReader("actor-a", "job-b"); });
    await page.getByRole("button", { name: "Read source passage" }).click();
    await page.waitForFunction(() => typeof window.releaseOldRead === "function");
    await page.evaluate(() => { window.mode = "verified"; window.mountReader("actor-b"); });
    await page.getByRole("button", { name: "Read source passage" }).click();
    await expect(page.locator("mark")).toHaveText("Elara carries the silver compass.");
    await page.evaluate(() => window.releaseOldRead());
    await page.waitForFunction(() => window.oldReadResolved === true);
    await expect(page.locator("mark")).toHaveText("Elara carries the silver compass.");
    await expect(page.locator("body")).not.toContainText("PRIVATE OLD ACCOUNT");
    assert.deepEqual((await page.evaluate(() => window.calls)).slice(-2).map(call => call.actor), ["actor-a", "actor-b"]);
  } finally { await page.close(); }
});

test("a revoked source clears the previously visible private passage", async () => {
  const page = await fixture();
  try {
    await page.getByRole("button", { name: "Read source passage" }).click();
    await expect(page.locator("mark")).toHaveText("Elara carries the silver compass.");
    await page.evaluate(() => { window.mode = "denied"; });
    await page.getByRole("button", { name: "Next passage section" }).click();
    await expect(page.getByRole("alert")).toContainText("Access to this source was revoked.");
    await expect(page.getByLabel("Saved source passage")).toHaveCount(0);
    await page.evaluate(() => { window.mode = "verified"; });
    await page.getByRole("button", { name: "Read source passage" }).click();
    await expect(page.locator("mark")).toHaveText("Elara carries the silver compass.");
  } finally { await page.close(); }
});
