// Real mounted Book Bible and author header; transports and SPA navigation are local fixtures.
// Run: node --test apps/web/tests/book-memory-navigation-mounted.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const bundle = await build({
  stdin: { contents: `import React from "react";
    import { createRoot } from "react-dom/client";
    import Memory from "./apps/web/components/BookMemoryClient";
    import { AuthorHeader } from "./apps/web/components/AuthorShell";
    const root = createRoot(document.getElementById("root"));
    window.renderMemory = (bookId = "11111111-1111-4111-8111-111111111111") => root.render(React.createElement(React.Fragment, null,
      React.createElement(AuthorHeader, {workspaceId: "workspace"}),
      React.createElement(Memory, { key: bookId, bookId })));
    window.clearMemory = () => root.render(null);`, loader: "tsx", resolveDir: process.cwd() },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  plugins: [{ name: "navigation-fixtures", setup(builder) {
    builder.onResolve({ filter: /^(next\/link|next\/navigation|\.\/api)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ resolveDir: process.cwd(), contents:
      args.path === "./api" ? "export const apiClient = () => window.bookwormApi;" : args.path === "next/navigation"
      ? "export const usePathname = () => window.location.pathname;"
      : `import React from "react";
        export default function Link({ href, onClick, children, ...props }) {
          return React.createElement("a", { ...props, href, onClick: event => {
            onClick?.(event);
            if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || props.target === "_blank" || props.download !== undefined) return;
            event.preventDefault();
            window.history.pushState({}, "", href);
            window.navigations++;
            window.clearMemory();
          } }, children);
        }` }));
  } }],
});
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
test.after(() => browser.close());

async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 980 } });
  page.setDefaultTimeout(6000);
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div></body></html>' }));
  await page.goto("http://127.0.0.1/books/11111111-1111-4111-8111-111111111111/memory");
  await page.evaluate(() => {
    window.prompts = []; window.confirmAnswer = false; window.navigations = 0; window.writes = [];
    window.actor = "33333333-3333-4333-8333-333333333333";
    window.confirm = message => { window.prompts.push(message); return window.confirmAnswer; };
    window.bookwormApi = { adminAccess: async () => ({ admin: false }), claimReferral: async () => ({ claimed: true }) };
    window.savedMemory = bookId => ({
      book: { id: bookId, workspace_id: "workspace", title: `Saved ${bookId}`, author_name: "Author", language: "en", updated_at: "2026-10-13T00:00:00.000Z" },
      metadata: { description: "Saved metadata", keywords: ["saved"], categories: ["fiction"], updated_at: "2026-10-13T00:00:00.000Z" },
      items: [], chapters: [], imageAssets: [], canEdit: true,
    });
    window.fetch = async (path, init) => {
      if (path === "/api/auth/session") return Response.json({ user: { id: window.actor, email: "author@example.test" } });
      const method = init?.method ?? "GET";
      const url = new URL(path, window.location.origin);
      const bookId = url.pathname.split("/")[5];
      if (method === "GET" && url.pathname.endsWith("/memory")) return Response.json(window.savedMemory(bookId));
      if (method === "GET" && url.pathname.endsWith("/models")) return Response.json({ models: [], catalogVersion: "fixture" });
      if (method === "GET" && url.pathname.endsWith("/drafts")) return Response.json({ drafts: [], pending: [] });
      const body = JSON.parse(init.body);
      window.writes.push({ path: url.pathname, method, body, actor: init?.headers?.["X-Bookworm-Actor"] });
      if (method === "POST" && url.pathname.endsWith("/bible")) return Response.json({ receipt: {
        requestId: body.requestId, bookId, action: "create", itemId: "44444444-4444-4444-8444-444444444444",
        intentHash: "a".repeat(64), resultHash: "b".repeat(64), resultUpdatedAt: "2026-10-13T00:01:00.000Z", committedAt: "2026-10-13T00:01:00.000Z",
      }, disposition: "unchanged", replayed: false, closed: false, item: {
        id: "44444444-4444-4444-8444-444444444444", book_id: bookId, type: body.type, name: body.name, description: body.description,
        attributes_json: { ...body.attributes, imageAssetIds: body.imageAssetIds }, source_refs_json: body.sourceRefs, mutation_incarnation_id: "55555555-5555-4555-8555-555555555555",
        updated_at: "2026-10-13T00:01:00.000Z",
      } });
      if (method === "PUT" && url.pathname.endsWith("/metadata")) {
        if (window.holdMetadataSave) await new Promise(resolve => { window.releaseMetadataSave = resolve; });
        return Response.json({ metadata: { ...body, publication_date: body.publicationDate, updated_at: "2026-10-13T00:01:00.000Z" } });
      }
      if (method === "PATCH") return Response.json({ book: { ...window.savedMemory(bookId).book, title: body.title } });
      throw new Error(`Unexpected fixture request: ${method} ${path}`);
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.renderMemory());
  await expect(page.getByRole("button", { name: "Reload saved data", exact: true })).toBeEnabled();
  return page;
}

test("cancelled manuscript navigation keeps an unsaved Book Bible entry available for explicit save", async () => {
  const page = await fixture();
  try {
    await page.getByRole("button", { name: "Add memory entry", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Elara Vale");
    await page.getByRole("textbox", { name: "Description", exact: true }).fill("The unsaved character description.");
    await page.getByRole("link", { name: "← Back to manuscript", exact: true }).click();
    assert.equal(page.url(), "http://127.0.0.1/books/11111111-1111-4111-8111-111111111111/memory");
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Elara Vale");
    assert.deepEqual(await page.evaluate(() => window.prompts), ["Leave Book Bible and discard your unsaved changes?"]);
    assert.equal(await page.evaluate(() => window.writes.length), 0);
    await page.getByRole("button", { name: "Save memory entry", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "saved to this book’s memory" })).toBeVisible();
    const writes = await page.evaluate(() => window.writes);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.name, "Elara Vale");
    assert.equal(writes[0].body.description, "The unsaved character description.");
    assert.equal(await page.evaluate(() => document.dispatchEvent(new Event("beforeunload", { cancelable: true }))), true);
  } finally { await page.close(); }
});

test("header navigation protects metadata during an in-flight save and releases the guard after success", async () => {
  const page = await fixture();
  try {
    await page.getByRole("textbox", { name: "Book description", exact: true }).fill("Unsaved publishing description");
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), false);
    await page.evaluate(() => { window.holdMetadataSave = true; });
    await page.getByRole("button", { name: "Save metadata", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    assert.equal(page.url(), "http://127.0.0.1/books/11111111-1111-4111-8111-111111111111/memory");
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveValue("Unsaved publishing description");
    await page.evaluate(() => window.releaseMetadataSave());
    await expect(page.getByRole("status").filter({ hasText: "Publishing metadata saved." })).toBeVisible();
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    assert.equal(page.url(), "http://127.0.0.1/dashboard?ws=workspace");
    assert.equal(await page.evaluate(() => window.prompts.length), 1);
    const writes = await page.evaluate(() => window.writes);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.description, "Unsaved publishing description");
  } finally { await page.close(); }
});

test("author can explicitly discard unsaved book details while pristine navigation needs no confirmation", async () => {
  const page = await fixture();
  try {
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Unsaved new title");
    await page.evaluate(() => { window.confirmAnswer = true; });
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    assert.equal(page.url(), "http://127.0.0.1/dashboard?ws=workspace");
    assert.deepEqual(await page.evaluate(() => window.prompts), ["Leave Book Bible and discard your unsaved changes?"]);
    assert.equal(await page.evaluate(() => window.writes.length), 0);
    await page.evaluate(() => { window.history.replaceState({}, "", "/books/22222222-2222-4222-8222-222222222222/memory"); window.renderMemory("22222222-2222-4222-8222-222222222222"); });
    await expect(page.getByRole("button", { name: "Reload saved data", exact: true })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Saved 22222222-2222-4222-8222-222222222222");
    await page.getByRole("link", { name: "← Back to manuscript", exact: true }).click();
    assert.equal(page.url(), "http://127.0.0.1/books/22222222-2222-4222-8222-222222222222");
    assert.equal(await page.evaluate(() => window.prompts.length), 1);
  } finally { await page.close(); }
});

test("modified, new-tab, download and same-destination links retain the draft without prompting", async () => {
  const page = await fixture();
  try {
    await page.getByRole("textbox", { name: "Book description", exact: true }).fill("Keep this metadata draft");
    const outcomes = await page.evaluate(() => {
      const outcomes = [];
      const cases = [
        { options: { ctrlKey: true } }, { options: { metaKey: true } }, { options: { shiftKey: true } }, { options: { altKey: true } },
        { options: { button: 1 } }, { attributes: { target: "_blank" } }, { attributes: { download: "draft.txt" } },
        { href: "/books/11111111-1111-4111-8111-111111111111/memory#bible-title" }, { prevented: true },
      ];
      for (const item of cases) {
        const anchor = document.createElement("a"); anchor.href = item.href ?? "/dashboard";
        for (const [key, value] of Object.entries(item.attributes ?? {})) anchor.setAttribute(key, value);
        anchor.addEventListener("click", event => event.preventDefault());
        document.body.append(anchor);
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...item.options });
        if (item.prevented) event.preventDefault();
        const count = window.prompts.length;
        anchor.dispatchEvent(event);
        outcomes.push(window.prompts.length === count);
        anchor.remove();
      }
      return outcomes;
    });
    assert.equal(outcomes.every(Boolean), true);
    assert.equal(await page.evaluate(() => window.prompts.length), 0);
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveValue("Keep this metadata draft");
    assert.equal(page.url(), "http://127.0.0.1/books/11111111-1111-4111-8111-111111111111/memory");
  } finally { await page.close(); }
});


test("account change prevents metadata write and retains the unsaved draft", async () => {
  const page = await fixture();
  try {
    await page.getByRole("textbox", { name: "Book description", exact: true }).fill("Original account private draft");
    await page.evaluate(() => { window.actor = "55555555-5555-4555-8555-555555555555"; });
    await page.getByRole("button", { name: "Save metadata", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Your account changed" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.writes.length), 0);
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveCount(0);
    await page.evaluate(() => { window.actor = "33333333-3333-4333-8333-333333333333"; });
    await page.getByRole("button", { name: "Verify original account" }).click();
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveValue("Original account private draft");
  } finally { await page.close(); }
});

test("legacy paid checkpoints are quarantined when ownership cannot be verified", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.clearMemory());
    await expect(page.getByRole("button", { name: "Reload saved data", exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      const book = "11111111-1111-4111-8111-111111111111";
      const intent = { idempotencyKey: "legacy-key-12345", body: { modelId: "writer", idempotencyKey: "legacy-key-12345", allowProviderTokenCounting: true, chapterIds: ["chapter"], maxTokens: 12000, audience: "Original owner audience" } };
      sessionStorage.setItem(`bookworm:metadata-quote:v1:${book}`, JSON.stringify(intent));
      sessionStorage.setItem(`bookworm:bible-quote:v1:${book}`, JSON.stringify(intent));
      window.actor = "55555555-5555-4555-8555-555555555555";
      window.recoveryCalls = [];
      const next = window.fetch;
      window.fetch = async (path, init) => {
        if (String(path).endsWith("/quotes/recover")) {
          window.recoveryCalls.push({ path, actor: init?.headers?.["X-Bookworm-Actor"] });
          return Response.json({ error: { message: "No saved quote found" } }, { status: 404 });
        }
        if (String(path).endsWith("/quotes")) throw new Error("unexpected paid quote");
        return next(path, init);
      };
      window.renderMemory();
    });
    await expect(page.getByText(/Quote requests are paused until browser recovery is available/)).toBeVisible();
    await expect(page.getByText(/The saved quote pointer is retained/)).toBeVisible();
    const result = await page.evaluate(() => ({ calls: window.recoveryCalls, keys: Object.keys(sessionStorage), writes: window.writes.length }));
    assert.equal(result.calls.length, 2);
    assert.ok(result.calls.every(call => call.actor === "55555555-5555-4555-8555-555555555555"));
    assert.ok(result.keys.some(key => key.startsWith("bookworm:metadata-quote:v1:")));
    assert.ok(result.keys.some(key => key.startsWith("bookworm:bible-quote:v1:")));
    assert.equal(result.writes, 0);
    assert.equal(await page.getByText("Original owner audience").count(), 0);
  } finally { await page.close(); }
});

test("legacy quote keys migrate only after owner-scoped read-only recovery", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.clearMemory());
    await expect(page.getByRole("button", { name: "Reload saved data", exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      const book = "11111111-1111-4111-8111-111111111111";
      const intent = { idempotencyKey: "legacy-key-12345", body: { modelId: "writer", idempotencyKey: "legacy-key-12345", allowProviderTokenCounting: true, chapterIds: ["chapter"], maxTokens: 12000 } };
      sessionStorage.setItem(`bookworm:metadata-quote:v1:${book}`, JSON.stringify(intent));
      sessionStorage.setItem(`bookworm:bible-quote:v1:${book}`, JSON.stringify(intent));
      window.recoveryCalls = [];
      const next = window.fetch;
      window.fetch = async (path, init) => {
        const p = String(path);
        if (p.endsWith("/metadata/quotes/recover")) { window.recoveryCalls.push(p); return Response.json({ request: { id: "metadata-request", status: "counting" }, quote: null }); }
        if (p.endsWith("/bible/quotes/recover")) { window.recoveryCalls.push(p); return Response.json({ quote: { requestId: "bible-request", status: "counting" }, job: null }); }
        if (p.endsWith("/bible/quotes/bible-request")) { window.recoveryCalls.push(p); return Response.json({ quote: { requestId: "bible-request", status: "counting" }, job: null }); }
        if (p.endsWith("/quotes")) throw new Error("unexpected paid quote");
        return next(path, init);
      };
      window.renderMemory();
    });
    await expect(page.getByRole("button", { name: "Reload saved data", exact: true })).toBeEnabled();
    await page.waitForFunction(() => window.recoveryCalls.length === 3);
    const result = await page.evaluate(() => ({ keys: Object.keys(sessionStorage), writes: window.writes.length, calls: window.recoveryCalls }));
    assert.ok(result.keys.some(key => key.startsWith("bookworm:metadata-quote:v2:33333333-3333-4333-8333-333333333333:")));
    assert.ok(result.keys.some(key => key.startsWith("bookworm:bible-quote:v2:33333333-3333-4333-8333-333333333333:")));
    assert.equal(result.keys.some(key => key.includes("-quote:v1:")), false);
    assert.equal(result.writes, 0);
  } finally { await page.close(); }
});


test("late metadata reply is not adopted after the account changes", async () => {
  const page = await fixture();
  try {
    await page.getByRole("textbox", { name: "Book description", exact: true }).fill("Draft held for the original author");
    await page.evaluate(() => { window.holdMetadataSave = true; });
    await page.getByRole("button", { name: "Save metadata", exact: true }).click();
    await page.waitForFunction(() => typeof window.releaseMetadataSave === "function");
    assert.equal(await page.evaluate(() => window.writes[0].actor), "33333333-3333-4333-8333-333333333333");
    await page.evaluate(() => { window.actor = "55555555-5555-4555-8555-555555555555"; window.releaseMetadataSave(); });
    await expect(page.getByRole("alert").filter({ hasText: "Your account changed" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveCount(0);
    await page.evaluate(() => { window.actor = "33333333-3333-4333-8333-333333333333"; });
    await page.getByRole("button", { name: "Verify original account" }).click();
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveValue("Draft held for the original author");
    assert.equal(await page.getByText("Publishing metadata saved.").count(), 0);
  } finally { await page.close(); }
});


test("account-scoped checkpoints are not read or changed by a second account", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.clearMemory());
    await expect(page.getByRole("button", { name: "Reload saved data", exact: true })).toHaveCount(0);
    const original = await page.evaluate(() => {
      const book="11111111-1111-4111-8111-111111111111", owner="33333333-3333-4333-8333-333333333333";
      const key=`bookworm:metadata-quote:v2:${owner}:${book}`;
      const pointer=JSON.stringify({idempotencyKey:"private-key-12345",body:{idempotencyKey:"private-key-12345",modelId:"writer",chapterIds:["chapter"],allowProviderTokenCounting:true,audience:"Original account audience"}});
      sessionStorage.setItem(key,pointer);window.actor="55555555-5555-4555-8555-555555555555";window.renderMemory();return {key,pointer};
    });
    await expect(page.getByRole("button", { name: "Reload saved data", exact: true })).toBeEnabled();
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), original.key), original.pointer);
    assert.equal(await page.getByText("Original account audience").count(), 0);
    assert.equal(await page.evaluate(() => window.writes.length), 0);
  } finally { await page.close(); }
});


test("late response from an earlier book does not hide or overwrite the new book", async () => {
  const page = await fixture();
  try {
    await page.getByRole("textbox", { name: "Book description", exact: true }).fill("Older book draft");
    await page.evaluate(() => { window.holdMetadataSave = true; });
    await page.getByRole("button", { name: "Save metadata", exact: true }).click();
    await page.waitForFunction(() => typeof window.releaseMetadataSave === "function");
    await page.evaluate(() => window.renderMemory("22222222-2222-4222-8222-222222222222"));
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Saved 22222222-2222-4222-8222-222222222222");
    await page.evaluate(() => window.releaseMetadataSave());
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Saved 22222222-2222-4222-8222-222222222222");
    assert.equal(await page.getByText("Your account changed or could not be verified.").count(), 0);
  } finally { await page.close(); }
});

test("book search checks the original account before reading private sources", async () => {
  const page = await fixture();
  try {
    await page.getByRole("searchbox", { name: "Words or phrase" }).fill("private name");
    await page.evaluate(() => { window.actor = "55555555-5555-4555-8555-555555555555"; });
    await page.getByRole("button", { name: "Search saved sources" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Your account changed" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.writes.length), 0);
    await expect(page.getByRole("searchbox", { name: "Words or phrase" })).toHaveCount(0);
  } finally { await page.close(); }
});


test("original account cannot reveal hidden draft after book access is revoked", async () => {
  const page = await fixture();
  try {
    await page.getByRole("textbox", { name: "Book description", exact: true }).fill("Draft remains in this tab");
    await page.evaluate(() => { window.actor = "55555555-5555-4555-8555-555555555555"; });
    await page.getByRole("button", { name: "Save metadata", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Your account changed" })).toBeVisible();
    await page.evaluate(() => {
      window.actor = "33333333-3333-4333-8333-333333333333";
      const next=window.fetch; window.denyMemory=true;
      window.fetch=async(path,init) => window.denyMemory && String(path).endsWith("/memory")
        ? Response.json({error:{message:"Access revoked"}},{status:403}) : next(path,init);
    });
    await page.getByRole("button", { name: "Verify original account" }).click();
    await expect(page.getByText("Access revoked")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveCount(0);
    await page.evaluate(() => { window.denyMemory=false; });
    await page.getByRole("button", { name: "Verify original account" }).click();
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveValue("Draft remains in this tab");
  } finally { await page.close(); }
});


test("returning to a tab after account switch hides private book data and preserves its draft", async () => {
  const page = await fixture();
  try {
    await page.getByRole("textbox", { name: "Book description", exact: true }).fill("Private unsaved material");
    await page.evaluate(() => { window.actor="55555555-5555-4555-8555-555555555555"; window.dispatchEvent(new Event("focus")); });
    await expect(page.getByRole("alert").filter({ hasText: "Your account changed" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveCount(0);
    await page.evaluate(() => { window.actor="33333333-3333-4333-8333-333333333333"; });
    await page.getByRole("button", { name: "Verify original account" }).click();
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveValue("Private unsaved material");
  } finally { await page.close(); }
});


test("recovered accepted Bible quote never offers another acceptance", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.clearMemory());
    await expect(page.getByRole("button", { name: "Reload saved data", exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      const book="11111111-1111-4111-8111-111111111111", owner="33333333-3333-4333-8333-333333333333", key="accepted-key-12345";
      sessionStorage.setItem(`bookworm:bible-quote:v2:${owner}:${book}`,JSON.stringify({idempotencyKey:key,requestId:"bible-request",body:{modelId:"writer",idempotencyKey:key,allowProviderTokenCounting:true,chapterIds:["chapter"],maxTokens:12000}}));
      const next=window.fetch;
      window.fetch=async(path,init)=>String(path).endsWith("/bible/quotes/bible-request")
        ? Response.json({quote:{requestId:"bible-request",status:"ready",model:"writer",countedInputTokens:10,maxOutputTokens:100,reservedCredits:5,expiresAt:"2099-01-01T00:00:00.000Z"},job:{id:"existing-job",status:"queued"}})
        : next(path,init);
      window.renderMemory();
    });
    await expect(page.getByText(/Accepted extraction.*existing-job/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept quote and start extraction" })).toHaveCount(0);
  } finally { await page.close(); }
});


test("failed metadata save retains draft and warns that the outcome may be unconfirmed", async () => {
  const page = await fixture();
  try {
    await page.getByRole("textbox", { name: "Book description", exact: true }).fill("Unsaved draft after lost reply");
    await page.evaluate(() => { const next=window.fetch; window.fetch=async(path,init) => String(path).endsWith("/metadata") && init?.method === "PUT" ? Promise.reject(new Error("Connection lost")) : next(path,init); });
    await page.getByRole("button", { name: "Save metadata", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Save outcome may be unconfirmed" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Book description", exact: true })).toHaveValue("Unsaved draft after lost reply");
  } finally { await page.close(); }
});
