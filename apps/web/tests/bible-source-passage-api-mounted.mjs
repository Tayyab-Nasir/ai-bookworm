// Real React reader and Fastify route; identity and database are synthetic fixtures.
// Run: node --import tsx --test apps/web/tests/bible-source-passage-api-mounted.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { makeAuthPlugin } from "../../../services/api/src/plugins/auth.ts";
import { errorHandlerPlugin } from "../../../services/api/src/plugins/error-handler.ts";
import { bookMemoryRoutes } from "../../../services/api/src/routes/book-memory.ts";
const Fastify = createRequire(new URL("../../../services/api/package.json", import.meta.url))("fastify");

const BOOK = "11111111-1111-4111-8111-111111111111", WORKSPACE = "22222222-2222-4222-8222-222222222222";
const CHAPTER = "33333333-3333-4333-8333-333333333333", VERSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555", JOB = "66666666-6666-4666-8666-666666666666";
const QUOTE = "77777777-7777-4777-8777-777777777777";
const prefix = "Earlier manuscript context. ".repeat(1100) + "😀";
const excerpt = "Elara keeps the silver compass.";
const text = prefix + excerpt + " Later manuscript context.".repeat(1100);
const ref = { chapterId: CHAPTER, documentVersionId: VERSION, nodeId: "node-1", textHash: createHash("sha256").update(text).digest("hex") };
const reading = { fingerprint: "a".repeat(64), pageIndex: 1 };
const versions = [{ chapterId: CHAPTER, documentVersionId: VERSION, version: 3 }];
const generationRequest = { jobId: JOB, workspaceId: WORKSPACE, bookId: BOOK, agentType: "bookbible", input: {
  chapters: { [CHAPTER]: { id: CHAPTER, documentVersionId: VERSION, nodes: [{ id: ref.nodeId, textHash: ref.textHash,
    text: excerpt, excerptStart: prefix.length, excerptEnd: prefix.length + excerpt.length, fullTextLength: text.length }] } },
} };

function database() {
  const state = {
    authenticated: true,
    books: [{ id: BOOK, workspace_id: WORKSPACE }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, role: "viewer", status: "active" }],
    chapters: [{ id: CHAPTER, book_id: BOOK, title: "Arrival", current_document_version_id: VERSION }],
    document_versions: [{ id: VERSION, chapter_id: CHAPTER, version_number: 3, content_json: { nodes: [{ id: ref.nodeId, type: "paragraph", text }] } }],
    ai_jobs: [{ id: JOB, workspace_id: WORKSPACE, book_id: BOOK, created_by: USER, agent_type: "bookbible", billing_mode: "quoted", status: "succeeded",
      input_ref: { bookBibleQuoteRequestId: QUOTE, sourceSha256: "b".repeat(64), generationRequestSha256: "c".repeat(64),
        generationRequest, chapterVersions: versions, reading, contextSources: [ref] }, output_ref: { candidates: [{ sourceRefs: [ref] }] } }],
    book_bible_token_quote_requests: [{ id: QUOTE, user_id: USER, workspace_id: WORKSPACE, book_id: BOOK, generation_job_id: JOB,
      accepted_job_id: JOB, status: "ready", source_sha256: "b".repeat(64), generation_request_sha256: "c".repeat(64),
      source_versions_json: { versions, reading }, generation_request_json: generationRequest }],
  };
  const calls = [];
  const client = { auth: { getUser: async token => ({ data: { user: token === "fixture" && state.authenticated ? { id: USER } : null }, error: null }) },
    from(table) {
      calls.push(table); const filters = [];
      return { select() { return this; }, eq(key, value) { filters.push(row => row[key] === value); return this; },
        async maybeSingle() { return { data: (state[table] ?? []).find(row => filters.every(filter => filter(row))) ?? null, error: null }; } };
    } };
  return { state, calls, client };
}

const bundle = await build({ stdin: { contents: `import React from "react";
  import { createRoot } from "react-dom/client";
  import Reader from "./apps/web/components/BibleSourcePassage";
  const root = createRoot(document.getElementById("root"));
  window.mountReader = props => root.render(React.createElement(Reader, { ...props, title: "Arrival",
    readRequest: async (path, method, body) => {
      const result = await window.injectEvidence(path, method, body);
      if (result.status !== 200) throw Object.assign(new Error(result.body.error.message), { status: result.status });
      return result.body;
    } }));`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });

test("candidate source reader uses the real scoped API and clears text when membership is revoked", async () => {
  const fixture = database(), app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(makeAuthPlugin(() => fixture.client));
  await app.register(async scope => bookMemoryRoutes(scope), { prefix: "/v1" });
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
  const page = await browser.newPage();
  const responses = [];
  try {
    await page.exposeFunction("injectEvidence", async (path, method, body) => {
      const result = await app.inject({ method, url: `/v1${path}`, headers: { authorization: "Bearer fixture", "x-bookworm-actor": USER }, payload: body });
      responses.push({ status: result.statusCode, cache: result.headers["cache-control"] });
      return { status: result.statusCode, body: result.json() };
    });
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div>' }));
    await page.goto("http://127.0.0.1/");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(props => window.mountReader(props), { actorId: USER, bookId: BOOK, jobId: JOB, citation: ref });
    await page.getByRole("button", { name: "Read source passage" }).click();
    await expect(page.locator("mark")).toHaveText(excerpt);
    assert.deepEqual(responses[0], { status: 200, cache: "private, no-store" });
    assert.ok(fixture.calls.includes("book_bible_token_quote_requests"));
    fixture.state.workspace_members[0].status = "suspended";
    await page.getByRole("button", { name: "Next passage section" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByLabel("Saved source passage")).toHaveCount(0);
    assert.deepEqual(responses[1], { status: 403, cache: "private, no-store" });
    fixture.state.workspace_members[0].status = "active";
    await page.getByRole("button", { name: "Read source passage" }).click();
    await expect(page.locator("mark")).toHaveText(excerpt);
    fixture.state.authenticated = false;
    await page.getByRole("button", { name: "Next passage section" }).click();
    await expect(page.getByLabel("Saved source passage")).toHaveCount(0);
    assert.deepEqual(responses[3], { status: 401, cache: "private, no-store" });
    assert.equal(fixture.state.ai_jobs.length, 1);
  } finally { await page.close(); await browser.close(); await app.close(); }
});
