// Actual BookMemoryClient with real project styles and in-memory HTTP/Auth fixtures.
// No Next server, operator cookie, hosted database, provider or paid request.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333", OTHER = "44444444-4444-4444-8444-444444444444";
const ITEM = "55555555-5555-4555-8555-555555555555";
const bodyText = "ORIGINAL PRIVATE CANON retained only in page memory";
const bundle = await build({
  stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client";
    import Memory from "./apps/web/components/BookMemoryClient";
    const root = createRoot(document.getElementById("root"));
    window.renderMemory = bookId => root.render(React.createElement(Memory, {bookId}));
    window.clearMemory = () => root.render(null);`, loader: "tsx", resolveDir: process.cwd() },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  plugins: [{ name: "navigation-fixture", setup(builder) {
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
    builder.onLoad({ filter: /^link$/, namespace: "fixture" }, () => ({ resolveDir: process.cwd(), contents: 'import React from "react"; export default props => React.createElement("a", props);' }));
  } }],
});
const stylePath = resolve("apps/web/styles/globals.css");
const styles = await postcss([tailwind({ base: resolve("apps/web"), optimize: false })]).process(await readFile(stylePath, "utf8"), { from: stylePath });
const instrument = (await readFile("apps/web/app/fonts/instrument-serif-italic.ttf")).toString("base64");
const artifacts = await mkdtemp(resolve(tmpdir(), "bookworm-manual-bible-mounted-"));
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
test.after(async () => { await browser.close(); console.log(JSON.stringify({ manualBibleArtifacts: artifacts })); });

async function fixture({ seeded = false, width = 1280, holdMemory = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 980 } }); page.setDefaultTimeout(6000);
  await page.context().route("**/*", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' }));
  await page.goto(`http://127.0.0.1/books/${A}/memory`);
  await page.addStyleTag({ content: styles.css + `@font-face {font-family:BookwormInstrument;src:url(data:font/ttf;base64,${instrument});font-style:italic;font-weight:400} :root {--font-inter:Arial,sans-serif;--font-instrument-serif:BookwormInstrument,serif} body {font-family:var(--font-inter);color:white}` });
  await page.evaluate(({ A, B, USER, OTHER, ITEM, seeded, holdMemory }) => {
    window.actor = USER; window.otherActor = OTHER; window.editable = true; window.calls = []; window.writes = []; window.commits = [];
    window.receipts = {}; window.closedRequests = {}; window.closeCalls = []; window.gates = {}; window.holdMemory = holdMemory;
    window.defer = name => new Promise((resolve, reject) => { window.gates[name] = { resolve, reject }; });
    window.confirm = () => true;
    window.entry = (book = A) => ({ id: ITEM, book_id: book, type: "character", name: "Existing canon", description: "Established private appearance", attributes_json: {}, source_refs_json: [], updated_at: "2026-10-13T00:00:00Z", mutation_incarnation_id: "77777777-7777-4777-8777-777777777777" });
    window.rows = { [A]: seeded ? [window.entry()] : [], [B]: [] };
    window.directLegacyEdit = book => { const row = window.rows[book][0]; window.rows[book] = [{ ...row, name: "Directly revised canon", description: "A newer direct edit", updated_at: new Date(Date.parse(row.updated_at) + 60_000).toISOString() }]; };
    window.recreateEntry = book => { window.rows[book] = [{ ...window.rows[book][0], name: "Replacement canon", description: "Different row incarnation", mutation_incarnation_id: "99999999-9999-4999-8999-999999999999" }]; };
    window.memory = book => ({ book: { id: book, workspace_id: "66666666-6666-4666-8666-666666666666", title: book === A ? "Author world A" : "Author world B", author_name: "Author", language: "en", updated_at: "2026-10-13T00:00:00Z" },
      metadata: { description: "Saved listing", keywords: [], categories: [], updated_at: "2026-10-13T00:00:00Z" }, items: window.rows[book], chapters: [], imageAssets: [], canEdit: window.editable });
    window.pointer = (user = USER, book = A) => sessionStorage.getItem(`bookworm:manual-bible:v1:${user}:${book}`);
    window.result = (saved, replayed = true) => {
      const current = window.rows[saved.receipt.bookId].find(item => item.id === saved.receipt.itemId) ?? null;
      const disposition = !current ? "deleted" : saved.receipt.action === "delete" || JSON.stringify(current) !== JSON.stringify(saved.item) ? "changed" : "unchanged";
      return { receipt: saved.receipt, disposition, item: current, replayed, closed: false, closure: null };
    };
    window.fetch = async (path, init) => {
      const method = init?.method ?? "GET";
      if (path === "/api/auth/session") return Response.json({ user: { id: window.actor } });
      const url = new URL(path, location.origin); const parts = url.pathname.split("/"); const book = parts[5];
      window.calls.push({ path: url.pathname, method });
      if (method === "GET" && url.pathname.endsWith("/memory")) {
        const snapshot = JSON.parse(JSON.stringify(window.memory(book)));
        if (window.holdMemory) { window.holdMemory = false; await window.defer("memory"); }
        return Response.json(snapshot);
      }
      if (method === "GET" && url.pathname.endsWith("/models")) return Response.json({ models: [], catalogVersion: "fixture" });
      if (method === "GET" && url.pathname.endsWith("/drafts")) return Response.json({ drafts: [], pending: [] });
      const manual = /^\/api\/backend\/v1\/books\/[^/]+\/bible(?:\/requests\/[^/]+(?:\/close)?|\/[^/]+)?$/.test(url.pathname);
      if (!manual) throw new Error(`Unexpected fixture request: ${method} ${path}`);
      const actor = new Headers(init?.headers).get("X-Bookworm-Actor");
      if (window.switchAtDispatch && method !== "GET") { window.switchAtDispatch = false; window.actor = OTHER; }
      if (actor !== window.actor) return Response.json({ error: { message: "The manual request account changed." } }, { status: 409 });
      if (!window.editable) return Response.json({ error: { message: "Editing permission was revoked." } }, { status: 403 });
      if (method === "GET") {
        const saved = window.receipts[parts[8]];
        if (window.recoveryOverride) return Response.json(window.recoveryOverride(saved));
        return Response.json(saved ? window.result(saved) : { receipt: null, disposition: null, item: null, replayed: false, closed: Boolean(window.closedRequests[parts[8]]), closure: window.closedRequests[parts[8]]?.closure ?? null });
      }
      if (url.pathname.endsWith("/close")) {
        const requestId = parts[8];
        window.closeCalls.push({ requestId, book, actor, body: JSON.parse(init.body), pointerBeforeDispatch: window.pointer(actor, book) });
        const saved = window.receipts[requestId];
        if (!saved) window.closedRequests[requestId] ??= { book, actor, closure: { requestId, bookId: book, closedAt: "2026-10-13T00:02:00Z" } };
        if (window.holdCloseReply) { window.holdCloseReply = false; await window.defer("close"); }
        if (window.loseCloseReply) { window.loseCloseReply = false; return Response.json({ error: { message: "Closure reply lost after its durable outcome." } }, { status: 503 }); }
        if (window.closeOverride) return Response.json(window.closeOverride());
        return Response.json(saved ? window.result(saved) : { receipt: null, disposition: null, item: null, replayed: false, closed: true, closure: window.closedRequests[requestId].closure });
      }
      const body = JSON.parse(init.body); const action = method === "POST" ? "create" : method === "PUT" ? "update" : "delete";
      window.writes.push({ action, book, target: action === "create" ? null : parts[7], body, actor, pointerBeforeDispatch: window.pointer(actor, book) });
      if (window.closedRequests[body.requestId]) return Response.json({ error: { message: "This original request is closed. Recover its saved status." } }, { status: 409 });
      if (window.rejectManualValidation) return Response.json({ error: { message: "A referenced source is unavailable; review the original details." } }, { status: 422 });
      const loss = window.loss?.action === action ? window.loss.stage : null; window.loss = null;
      if (loss === "before") return Response.json({ error: { message: "Reply lost before this request was saved." } }, { status: 503 });
      let saved = window.receipts[body.requestId];
      if (saved && saved.body !== JSON.stringify(body)) return Response.json({ error: { message: "Original request body mismatch." } }, { status: 409 });
      if (!saved) {
        const previous = window.rows[book].find(item => item.id === parts[7]);
        if (action !== "create" && (!previous || previous.mutation_incarnation_id !== body.expectedIncarnationId || Date.parse(previous.updated_at) !== Date.parse(body.expectedUpdatedAt))) {
          return Response.json({ error: { message: "This entry version changed. Recover or close the original request before reviewing current canon." } }, { status: 409 });
        }
        const item = action === "delete" ? previous : { id: action === "create" ? ITEM : parts[7], book_id: book, type: body.type, name: body.name, description: body.description,
          attributes_json: { ...body.attributes, imageAssetIds: body.imageAssetIds }, source_refs_json: body.sourceRefs, updated_at: action === "create" ? "2026-10-13T00:01:00Z" : new Date(Date.parse(previous.updated_at) + 60_000).toISOString(), mutation_incarnation_id: action === "create" ? "88888888-8888-4888-8888-888888888888" : previous.mutation_incarnation_id };
        if (!item) return Response.json({ error: { message: "Target unavailable." } }, { status: 409 });
        window.rows[book] = window.rows[book].filter(row => row.id !== item.id);
        if (action !== "delete") window.rows[book].push(item);
        saved = { body: JSON.stringify(body), item: action === "delete" ? null : item, receipt: { requestId: body.requestId, bookId: book, action, itemId: item.id,
          intentHash: "a".repeat(64), resultHash: "b".repeat(64), resultUpdatedAt: item.updated_at, committedAt: "2026-10-13T00:01:00Z" } };
        window.receipts[body.requestId] = saved; window.commits.push({ requestId: body.requestId, action, book });
      }
      if (window.holdWriteReply) { window.holdWriteReply = false; await window.defer("write"); }
      if (loss === "after") return Response.json({ error: { message: "Reply lost after this request was saved." } }, { status: 503 });
      if (window.legacyWriteReply) return Response.json({ item: saved.item });
      if (window.missingWriteReceipt) return Response.json({ receipt: null, item: null, disposition: null, replayed: false, closed: false, closure: null });
      return Response.json(window.result(saved, false));
    };
  }, { A, B, USER, OTHER, ITEM, seeded, holdMemory });
  await page.addScriptTag({ content: bundle.outputFiles[0].text }); await page.evaluate(book => window.renderMemory(book), A);
  if (!holdMemory) await expect(page.getByRole("button", { name: "Reload saved data", exact: true })).toBeEnabled();
  return page;
}

async function prepare(page, action) {
  if (action === "create") await page.getByRole("button", { name: "Add memory entry", exact: true }).click();
  else await page.getByRole("button", { name: /Existing canon/ }).click();
  if (action === "delete") { await page.getByRole("button", { name: "Delete entry", exact: true }).click(); return; }
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(action === "create" ? "New canon" : "Edited canon");
  await page.getByRole("textbox", { name: "Description", exact: true }).fill(bodyText);
}
async function submit(page, action) { await page.getByRole("button", { name: action === "delete" ? "Confirm delete" : "Save memory entry", exact: true }).click(); }
async function uncertain(page) {
  await expect(page.getByRole("region", { name: "Manual Book Bible request recovery", exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "outcome is unconfirmed" })).toBeVisible();
}
async function reload(page) {
  await page.getByRole("button", { name: "Reload saved data", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reload saved data", exact: true })).toBeEnabled();
}
async function confirmClosure(page) {
  await page.getByRole("button", { name: "Close unresolved request", exact: true }).click();
  await expect(page.getByRole("region", { name: "Confirm request closure", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm close request", exact: true }).click();
}

for (const action of ["create", "update", "delete"]) for (const stage of ["before", "after"]) {
  test(`${action}: lost reply ${stage} commit preserves a durable private-body-free pointer and recovers without a duplicate`, async () => {
    const page = await fixture({ seeded: action !== "create" });
    try {
      await prepare(page, action); await page.evaluate(({ action, stage }) => { window.loss = { action, stage }; }, { action, stage });
      await submit(page, action); await uncertain(page);
      const before = await page.evaluate(() => ({ pointer: window.pointer(), writes: window.writes }));
      assert(before.pointer); assert(!before.pointer.includes("PRIVATE")); assert(!before.pointer.includes("New canon"));
      assert.equal(before.writes.length, 1); assert.equal(before.writes[0].actor, USER); assert(before.writes[0].pointerBeforeDispatch);
      const pointer = JSON.parse(before.pointer); assert.equal(pointer.schema, 2);
      if (action === "create") { assert.equal(pointer.expectedIncarnationId, null); assert.equal(Object.hasOwn(before.writes[0].body, "expectedIncarnationId"), false); }
      else { assert.equal(pointer.expectedIncarnationId, "77777777-7777-4777-8777-777777777777"); assert.equal(before.writes[0].body.expectedIncarnationId, pointer.expectedIncarnationId); }
      if (action !== "delete") await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeDisabled();
      if (action === "create" && stage === "before") await page.screenshot({ path: resolve(artifacts, "desktop-manual-recovery.png"), fullPage: true });
      await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
      if (stage === "before") {
        await expect(page.getByRole("status").filter({ hasText: "No saved receipt was found" })).toBeVisible();
        assert.equal(await page.evaluate(() => window.writes.length), 1);
        await page.getByRole("button", { name: "Retry same saved request", exact: true }).click();
      }
      await expect(page.getByRole("region", { name: "Manual Book Bible request recovery", exact: true })).toHaveCount(0);
      const state = await page.evaluate(() => ({ rows: Object.values(window.rows)[0], commits: window.commits, writes: window.writes, pointer: window.pointer() }));
      assert.equal(state.commits.length, 1); assert.equal(state.pointer, null); assert.equal(state.rows.length, action === "delete" ? 0 : 1);
      assert.equal(state.writes.length, stage === "before" ? 2 : 1);
      if (stage === "before") assert.deepEqual(state.writes[1].body, state.writes[0].body);
      await expect(page.getByRole("button", { name: "Add memory entry", exact: true })).toBeEnabled();
      if (action !== "delete") await expect(page.getByRole("button", { name: "Save memory entry", exact: true })).toBeEnabled();
    } finally { await page.close(); }
  });
}

for (const action of ["create", "update", "delete"]) test(`${action}: reload with a missing receipt requires explicit original intent verification before same-key retry`, async () => {
  const page = await fixture({ seeded: action !== "create" });
  try {
    await prepare(page, action); await page.evaluate(action => { window.loss = { action, stage: "before" }; }, action); await submit(page, action); await uncertain(page);
    const original = await page.evaluate(() => window.writes[0].body);
    await reload(page); await expect(page.getByRole("button", { name: "Retry same saved request", exact: true })).toBeDisabled();
    assert.equal(await page.evaluate(() => window.writes.length), 1);
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
    await page.getByRole("button", { name: action === "delete" ? "Review original deletion intent" : "Re-enter original details", exact: true }).click();
    if (action === "delete") await page.getByRole("button", { name: "Confirm original deletion intent", exact: true }).click();
    else {
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("Wrong original details");
      await page.getByRole("textbox", { name: "Description", exact: true }).fill(bodyText);
      await page.getByRole("button", { name: "Check original details", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "do not match the original request" })).toBeVisible();
      assert.equal(await page.evaluate(() => window.writes.length), 1);
      await page.getByRole("textbox", { name: "Name", exact: true }).fill(original.name);
      await page.getByRole("button", { name: "Check original details", exact: true }).click();
    }
    await expect(page.getByRole("button", { name: "Retry same saved request", exact: true })).toBeEnabled();
    assert.equal(await page.evaluate(() => window.writes.length), 1, "checking original details is read-only");
    await page.getByRole("button", { name: "Retry same saved request", exact: true }).click();
    await expect(page.getByRole("region", { name: "Manual Book Bible request recovery", exact: true })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.writes[1].body), original);
  } finally { await page.close(); }
});

for (const action of ["update", "delete"]) for (const intervening of ["direct-edit", "recreated-same-timestamp"]) test(`${action}: ${intervening} defeats a first-write retry without overwriting the current row`, async () => {
  const page = await fixture({ seeded: true });
  try {
    await prepare(page, action); await page.evaluate(action => { window.loss = { action, stage: "before" }; }, action); await submit(page, action); await uncertain(page);
    const original = await page.evaluate(() => window.writes[0].body);
    await page.evaluate(({ book, intervening }) => { if (intervening === "direct-edit") window.directLegacyEdit(book); else window.recreateEntry(book); }, { book: A, intervening });
    const current = await page.evaluate(book => window.rows[book][0], A);
    if (intervening === "direct-edit") assert.notEqual(Date.parse(current.updated_at), Date.parse(original.expectedUpdatedAt));
    else { assert.equal(Date.parse(current.updated_at), Date.parse(original.expectedUpdatedAt)); assert.notEqual(current.mutation_incarnation_id, original.expectedIncarnationId); }
    await page.getByRole("button", { name: "Retry same saved request", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "entry version changed" })).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.writes[1].body), original); assert.deepEqual(await page.evaluate(book => window.rows[book][0], A), current);
    assert.equal(await page.evaluate(() => window.commits.length), 0); assert(await page.evaluate(() => window.pointer()));
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "No saved receipt was found" })).toBeVisible(); assert(await page.evaluate(() => window.pointer()));
    await confirmClosure(page); await expect(page.getByRole("status").filter({ hasText: "Saved request closed" })).toBeVisible();
    await reload(page); await page.getByRole("button", { name: new RegExp(current.name) }).click();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(current.name); assert.equal(await page.evaluate(() => window.commits.length), 0);
  } finally { await page.close(); }
});

for (const action of ["create", "update", "delete"]) test(`${action}: a legacy checkpoint is retained as recovery/closure-only without guessing a current incarnation`, async () => {
  const page = await fixture({ seeded: action !== "create" });
  try {
    await prepare(page, action); await page.evaluate(action => { window.loss = { action, stage: "before" }; }, action); await submit(page, action); await uncertain(page);
    await page.evaluate(({ user, book }) => { const { expectedIncarnationId, ...pointer } = JSON.parse(window.pointer()); sessionStorage.setItem(`bookworm:manual-bible:v1:${user}:${book}`, JSON.stringify({ ...pointer, schema: 1 })); }, { user: USER, book: A });
    const legacy = await page.evaluate(() => window.pointer()); await reload(page);
    await expect(page.getByRole("status").filter({ hasText: "older checkpoint predates entry-version protection" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry same saved request", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
    assert.equal(await page.evaluate(() => window.pointer()), legacy); assert.equal(await page.evaluate(() => window.writes.length), 1);
    await expect(page.getByRole("button", { name: action === "delete" ? "Review original deletion intent" : "Re-enter original details", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add memory entry", exact: true })).toBeDisabled();
    await confirmClosure(page); await expect(page.getByRole("status").filter({ hasText: "Saved request closed" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.pointer()), null); assert.equal(await page.evaluate(() => window.writes.length), 1); assert.equal(await page.evaluate(() => window.commits.length), 0);
  } finally { await page.close(); }
});

test("a legacy accepted checkpoint can adopt current canon through read-only recovery", async () => {
  const page = await fixture();
  try {
    await prepare(page, "create"); await page.evaluate(() => { window.loss = { action: "create", stage: "after" }; }); await submit(page, "create"); await uncertain(page);
    await page.evaluate(({ user, book }) => { const { expectedIncarnationId, ...pointer } = JSON.parse(window.pointer()); sessionStorage.setItem(`bookworm:manual-bible:v1:${user}:${book}`, JSON.stringify({ ...pointer, schema: 1 })); }, { user: USER, book: A });
    await reload(page); await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("New canon");
    assert.equal(await page.evaluate(() => window.pointer()), null); assert.equal(await page.evaluate(() => window.writes.length), 1);
  } finally { await page.close(); }
});

for (const disposition of ["changed", "deleted", "delete-recreated"]) test(`recovery adopts current ${disposition} canon without repeating the original action`, async () => {
  const action = disposition === "delete-recreated" ? "delete" : "create";
  const page = await fixture({ seeded: action === "delete" });
  try {
    await prepare(page, action); await page.evaluate(action => { window.loss = { action, stage: "after" }; }, action); await submit(page, action); await uncertain(page);
    await page.evaluate(({ book, disposition }) => {
      if (disposition === "deleted") window.rows[book] = [];
      else window.rows[book] = [{ ...window.entry(book), name: "Current revised canon", description: "Current authoritative details", mutation_incarnation_id: "99999999-9999-4999-8999-999999999999" }];
    }, { book: A, disposition });
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
    await expect(page.getByRole("region", { name: "Manual Book Bible request recovery", exact: true })).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.writes.length), 1);
    if (disposition === "deleted") { await expect(page.getByRole("status").filter({ hasText: "was not recreated" })).toBeVisible(); await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0); }
    else { await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Current revised canon"); await expect(page.getByRole("status").filter({ hasText: disposition === "delete-recreated" ? "were not deleted again" : "were not reapplied" })).toBeVisible(); }
  } finally { await page.close(); }
});

for (const storageFault of ["blocked", "silent"]) test(`${storageFault} recovery storage stops before any manual write`, async () => {
  const page = await fixture();
  try {
    await prepare(page, "create");
    await page.evaluate(fault => { Storage.prototype.setItem = fault === "silent" ? function() {} : function() { throw new Error("Storage blocked"); }; }, storageFault);
    await submit(page, "create");
    await expect(page.getByRole("alert").filter({ hasText: "No manual Book Bible write was sent" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.writes.length), 0); await expect(page.getByRole("textbox", { name: "Description", exact: true })).toHaveValue(bodyText);
  } finally { await page.close(); }
});

for (const responseKind of ["legacy", "missing-receipt"]) test(`a ${responseKind} fresh success remains uncertain until read-only recovery confirms it`, async () => {
  const page = await fixture();
  try {
    await prepare(page, "create"); await page.evaluate(kind => { window.legacyWriteReply = kind === "legacy"; window.missingWriteReceipt = kind === "missing-receipt"; }, responseKind); await submit(page, "create"); await uncertain(page);
    assert(await page.evaluate(() => window.pointer())); await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
    await expect(page.getByRole("region", { name: "Manual Book Bible request recovery", exact: true })).toHaveCount(0); assert.equal(await page.evaluate(() => window.writes.length), 1);
  } finally { await page.close(); }
});

test("book replacement fences a late committed response and keeps the original book pointer", async () => {
  const page = await fixture();
  try {
    await prepare(page, "create"); await page.evaluate(() => { window.holdWriteReply = true; }); await submit(page, "create"); await page.waitForFunction(() => !!window.gates.write);
    await page.evaluate(book => window.renderMemory(book), B); await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Author world B");
    await page.evaluate(() => window.gates.write.resolve());
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0); assert(await page.evaluate(() => window.pointer()));
    await page.evaluate(book => window.renderMemory(book), A); await expect(page.getByRole("button", { name: "Recover saved request", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click(); await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("New canon");
    assert.equal(await page.evaluate(() => window.writes.length), 1);
  } finally { await page.close(); }
});

test("current account verification rejects an old account’s late memory response", async () => {
  const page = await fixture({ seeded: true, holdMemory: true });
  try {
    await page.waitForFunction(() => !!window.gates.memory);
    await page.evaluate(user => { window.actor = user; window.gates.memory.resolve(); }, OTHER);
    await expect(page.getByRole("alert").filter({ hasText: "account changed while saved memory was loading" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Existing canon/ })).toHaveCount(0); await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.writes.length), 0);
  } finally { await page.close(); }
});

for (const change of ["after-commit", "at-dispatch"]) test(`actor change ${change} cannot adopt earlier canon or commit a differently authenticated action`, async () => {
  const page = await fixture();
  try {
    await prepare(page, "create");
    await page.evaluate(change => { if (change === "at-dispatch") window.switchAtDispatch = true; else window.holdWriteReply = true; }, change);
    await submit(page, "create");
    if (change === "after-commit") { await page.waitForFunction(() => !!window.gates.write); await page.evaluate(user => { window.actor = user; window.gates.write.resolve(); }, OTHER); }
    await expect(page.getByRole("alert").filter({ hasText: "Your account changed" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0);
    assert(await page.evaluate(() => window.pointer()));
    assert.equal(await page.evaluate(({ user, book }) => window.pointer(user, book), { user: OTHER, book: A }), null);
    if (change === "at-dispatch") assert.equal(await page.evaluate(() => window.commits.length), 0);
  } finally { await page.close(); }
});

test("role loss denies private receipt recovery while retaining the original pointer until editor access returns", async () => {
  const page = await fixture();
  try {
    await prepare(page, "create"); await page.evaluate(() => { window.loss = { action: "create", stage: "after" }; }); await submit(page, "create"); await uncertain(page);
    await page.evaluate(() => { window.editable = false; }); await reload(page);
    await expect(page.getByText("You have read-only access.", { exact: false })).toBeVisible(); await expect(page.getByRole("button", { name: "Retry same saved request", exact: true })).toBeDisabled();
    assert(await page.evaluate(() => window.pointer())); await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Editing permission was revoked" })).toBeVisible();
    assert(await page.evaluate(() => window.pointer())); await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.writes.length), 1);
    await page.evaluate(() => { window.editable = true; }); await reload(page);
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("New canon"); await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeEnabled();
    assert.equal(await page.evaluate(() => window.writes.length), 1); assert.equal(await page.evaluate(() => window.pointer()), null);
  } finally { await page.close(); }
});

test("permission revoked at dispatch preserves the pointer and freezes retries after a denied write", async () => {
  const page = await fixture();
  try {
    await prepare(page, "create"); await page.evaluate(() => { window.editable = false; }); await submit(page, "create"); await uncertain(page);
    await expect(page.getByText("You have read-only access.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry same saved request", exact: true })).toBeDisabled();
    assert.equal(await page.evaluate(() => window.commits.length), 0); assert(await page.evaluate(() => window.pointer()));
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Editing permission was revoked" })).toBeVisible();
    assert(await page.evaluate(() => window.pointer())); assert.equal(await page.evaluate(() => window.writes.length), 0, "the denied request never enters the mutation handler");
    await page.evaluate(() => { window.editable = true; }); await reload(page);
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "No saved receipt was found" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.writes.length), 0); assert(await page.evaluate(() => window.pointer()));
  } finally { await page.close(); }
});

test("an invalid original request closes only by explicit confirmation, keeps its draft, and permits a corrected new UUID after bound proof", async () => {
  const page = await fixture({ width: 390 });
  try {
    await prepare(page, "create"); await page.evaluate(() => { window.rejectManualValidation = true; }); await submit(page, "create"); await uncertain(page);
    const original = await page.evaluate(() => window.writes[0].body);
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "No saved receipt was found" })).toBeVisible();
    assert(await page.evaluate(() => window.pointer())); assert.equal(await page.evaluate(() => window.closeCalls.length), 0);
    await expect(page.getByRole("button", { name: "Add memory entry", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Close unresolved request", exact: true }).click();
    await page.getByRole("button", { name: "Keep request open", exact: true }).click();
    assert.equal(await page.evaluate(() => window.closeCalls.length), 0, "opening and cancelling confirmation is not a closure");
    await page.getByRole("button", { name: "Close unresolved request", exact: true }).click();
    const confirmation = page.getByRole("region", { name: "Confirm request closure", exact: true }); await confirmation.scrollIntoViewIfNeeded();
    const box = await confirmation.boundingBox(); assert(box && box.x >= 0 && box.x + box.width <= 390);
    await page.screenshot({ path: resolve(artifacts, "mobile-request-closure.png"), fullPage: true });
    await page.getByRole("button", { name: "Confirm close request", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved request closed" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Description", exact: true })).toHaveValue(bodyText);
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeEnabled();
    assert.equal(await page.evaluate(() => window.pointer()), null); assert.equal(await page.evaluate(() => window.commits.length), 0);
    const close = await page.evaluate(() => window.closeCalls[0]); assert.equal(close.requestId, original.requestId); assert.equal(close.actor, USER); assert.deepEqual(close.body, {}); assert(close.pointerBeforeDispatch);
    const late = await page.evaluate(async ({ book, actor, body }) => (await fetch(`/api/backend/v1/books/${book}/bible`, { method: "POST", headers: { "X-Bookworm-Actor": actor }, body: JSON.stringify(body) })).status, { book: A, actor: USER, body: original });
    assert.equal(late, 409); assert.equal(await page.evaluate(() => window.commits.length), 0, "a late original write cannot pass the durable closure");
    await page.evaluate(() => { window.rejectManualValidation = false; });
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Corrected canon"); await submit(page, "create");
    await expect(page.getByRole("status").filter({ hasText: "Corrected canon” saved" })).toBeVisible();
    const state = await page.evaluate(() => ({ commits: window.commits, writes: window.writes })); assert.equal(state.commits.length, 1); assert.notEqual(state.commits[0].requestId, original.requestId);
  } finally { await page.close(); }
});

test("closing an already accepted request adopts changed current canon instead of closing or reapplying the original", async () => {
  const page = await fixture();
  try {
    await prepare(page, "create"); await page.evaluate(() => { window.loss = { action: "create", stage: "after" }; }); await submit(page, "create"); await uncertain(page);
    await page.evaluate(book => { window.rows[book] = [{ ...window.rows[book][0], name: "Later authoritative canon", description: "Later details", updated_at: "2026-10-13T00:03:00Z" }]; }, A);
    await confirmClosure(page); await expect(page.getByRole("region", { name: "Manual Book Bible request recovery", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Later authoritative canon");
    await expect(page.getByRole("status").filter({ hasText: "were not reapplied" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.writes.length), 1); assert.equal(await page.evaluate(() => Object.keys(window.closedRequests).length), 0); assert.equal(await page.evaluate(() => window.pointer()), null);
  } finally { await page.close(); }
});

for (const remount of [false, true]) test(`lost closure reply ${remount ? "after reload" : "on the same page"} retains the pointer until a read-only identity-bound closed proof`, async () => {
  const page = await fixture();
  try {
    await prepare(page, "create"); await page.evaluate(() => { window.loss = { action: "create", stage: "before" }; }); await submit(page, "create"); await uncertain(page);
    await page.evaluate(() => { window.loseCloseReply = true; }); await confirmClosure(page);
    await expect(page.getByRole("alert").filter({ hasText: "closure outcome is unconfirmed" })).toBeVisible();
    assert(await page.evaluate(() => window.pointer())); await expect(page.getByRole("button", { name: "Retry same saved request", exact: true })).toBeDisabled();
    assert.equal(await page.evaluate(() => window.closeCalls.length), 1); assert.equal(await page.evaluate(() => window.writes.length), 1);
    if (remount) { await reload(page); await expect(page.getByRole("button", { name: "Retry same saved request", exact: true })).toBeDisabled(); }
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved request closed" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.pointer()), null); assert.equal(await page.evaluate(() => window.closeCalls.length), 1); assert.equal(await page.evaluate(() => window.commits.length), 0);
    if (!remount) await expect(page.getByRole("textbox", { name: "Description", exact: true })).toHaveValue(bodyText);
  } finally { await page.close(); }
});

for (const invalidProof of ["missing", "foreign-request", "foreign-book"]) test(`${invalidProof} closure proof never clears the original pointer or unlocks a new request`, async () => {
  const page = await fixture();
  try {
    await prepare(page, "create"); await page.evaluate(() => { window.loss = { action: "create", stage: "before" }; }); await submit(page, "create"); await uncertain(page);
    await page.evaluate(({ invalidProof, foreign }) => { window.closeOverride = () => { const value = Object.values(window.closedRequests)[0]; return { receipt: null, disposition: null, item: null, replayed: false, closed: true,
      ...(invalidProof === "missing" ? {} : { closure: { ...value.closure, [invalidProof === "foreign-request" ? "requestId" : "bookId"]: foreign } }) }; }; }, { invalidProof, foreign: B });
    await confirmClosure(page); await expect(page.getByRole("alert").filter({ hasText: "closure does not match" })).toBeVisible();
    assert(await page.evaluate(() => window.pointer())); await expect(page.getByRole("button", { name: "Add memory entry", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Retry same saved request", exact: true })).toBeDisabled(); assert.equal(await page.evaluate(() => window.writes.length), 1);
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved request closed" })).toBeVisible(); assert.equal(await page.evaluate(() => window.pointer()), null);
  } finally { await page.close(); }
});

test("storage failure before closure sends no close request and retains the original draft and pointer", async () => {
  const page = await fixture();
  try {
    await prepare(page, "create"); await page.evaluate(() => { window.loss = { action: "create", stage: "before" }; }); await submit(page, "create"); await uncertain(page);
    const pointer = await page.evaluate(() => window.pointer());
    await page.evaluate(() => { Storage.prototype.setItem = function() { throw new Error("Storage blocked"); }; }); await confirmClosure(page);
    await expect(page.getByRole("alert").filter({ hasText: "No manual Book Bible write was sent" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.closeCalls.length), 0); assert.equal(await page.evaluate(() => window.pointer()), pointer);
    await expect(page.getByRole("textbox", { name: "Description", exact: true })).toHaveValue(bodyText);
  } finally { await page.close(); }
});

test("role loss at closure dispatch denies the close and recovery, retaining the pointer until editor access returns", async () => {
  const page = await fixture();
  try {
    await prepare(page, "create"); await page.evaluate(() => { window.loss = { action: "create", stage: "before" }; }); await submit(page, "create"); await uncertain(page);
    await page.getByRole("button", { name: "Close unresolved request", exact: true }).click(); await page.evaluate(() => { window.editable = false; });
    await page.getByRole("button", { name: "Confirm close request", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Editing permission was revoked" })).toBeVisible();
    assert(await page.evaluate(() => window.pointer())); assert.equal(await page.evaluate(() => window.closeCalls.length), 0); assert.equal(await page.evaluate(() => Object.keys(window.closedRequests).length), 0);
    await expect(page.getByRole("button", { name: "Close unresolved request", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click(); await expect(page.getByRole("alert").filter({ hasText: "Editing permission was revoked" })).toBeVisible();
    await page.evaluate(() => { window.editable = true; }); await reload(page); await confirmClosure(page);
    await expect(page.getByRole("status").filter({ hasText: "Saved request closed" })).toBeVisible(); assert.equal(await page.evaluate(() => window.pointer()), null); assert.equal(await page.evaluate(() => window.commits.length), 0);
  } finally { await page.close(); }
});

test("actor switching at closure dispatch denies the close and retains the old owner’s pointer without showing private canon", async () => {
  const page = await fixture();
  try {
    await prepare(page, "create"); await page.evaluate(() => { window.loss = { action: "create", stage: "before" }; }); await submit(page, "create"); await uncertain(page);
    await page.evaluate(() => { window.switchAtDispatch = true; }); await confirmClosure(page);
    await expect(page.getByRole("alert").filter({ hasText: "Your account changed" })).toBeVisible(); await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0);
    assert(await page.evaluate(() => window.pointer())); assert.equal(await page.evaluate(({ user, book }) => window.pointer(user, book), { user: OTHER, book: A }), null);
    assert.equal(await page.evaluate(() => window.closeCalls.length), 0); assert.equal(await page.evaluate(() => Object.keys(window.closedRequests).length), 0);
  } finally { await page.close(); }
});

test("book replacement fences a late closure result and only read-only recovery in the original book clears its pointer", async () => {
  const page = await fixture();
  try {
    await prepare(page, "create"); await page.evaluate(() => { window.loss = { action: "create", stage: "before" }; }); await submit(page, "create"); await uncertain(page);
    await page.evaluate(() => { window.holdCloseReply = true; }); await confirmClosure(page); await page.waitForFunction(() => !!window.gates.close);
    await page.evaluate(book => window.renderMemory(book), B); await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Author world B");
    await page.evaluate(() => window.gates.close.resolve()); assert(await page.evaluate(() => window.pointer()));
    await expect(page.getByRole("status").filter({ hasText: "Saved request closed" })).toHaveCount(0);
    await page.evaluate(book => window.renderMemory(book), A); await expect(page.getByRole("button", { name: "Recover saved request", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click(); await expect(page.getByRole("status").filter({ hasText: "Saved request closed" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.pointer()), null); assert.equal(await page.evaluate(() => window.closeCalls.length), 1); assert.equal(await page.evaluate(() => window.writes.length), 1);
  } finally { await page.close(); }
});

test("mobile uncertain request controls and reentry remain visible in the existing editorial layout", async () => {
  const page = await fixture({ width: 390 });
  try {
    await prepare(page, "create"); await page.evaluate(() => { window.loss = { action: "create", stage: "before" }; }); await submit(page, "create"); await uncertain(page);
    const recovery = page.getByRole("region", { name: "Manual Book Bible request recovery", exact: true }); await recovery.scrollIntoViewIfNeeded();
    const box = await recovery.boundingBox(); assert(box && box.x >= 0 && box.x + box.width <= 390);
    await page.screenshot({ path: resolve(artifacts, "mobile-manual-recovery.png"), fullPage: true });
    await page.getByRole("button", { name: "Recover saved request", exact: true }).click(); await page.getByRole("button", { name: "Retry same saved request", exact: true }).click();
    await expect(recovery).toHaveCount(0); await page.screenshot({ path: resolve(artifacts, "mobile-confirmed-canon.png"), fullPage: true });
  } finally { await page.close(); }
});
