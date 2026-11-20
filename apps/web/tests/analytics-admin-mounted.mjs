// Mounted UI acceptance without a Next server, listener, or external request.
// Run: node --test apps/web/tests/analytics-admin-mounted.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const bundle = await build({
  stdin: { contents: `import React from "react"; import { createRoot } from "react-dom/client";
    import Analytics from "./apps/web/app/analytics/page.tsx";
    import Admin from "./apps/web/components/AdminConsole.tsx";
    import Community from "./apps/web/app/community/[id]/page.tsx";
    import Dashboard from "./apps/web/components/AuthorDashboard.tsx";
    import Collaboration from "./apps/web/components/CollaborationCenter.tsx";
    const root = createRoot(document.getElementById("root"));
    window.renderAnalytics = query => { window.query = query || ""; root.render(React.createElement(Analytics, { query })); };
    window.renderAdmin = () => root.render(React.createElement(Admin));
    window.renderCommunity = id => { window.communityId = id; root.render(React.createElement(Community)); };
    window.renderDashboard = strict => root.render(strict ? React.createElement(React.StrictMode, null, React.createElement(Dashboard)) : React.createElement(Dashboard));
    window.renderCollaboration = () => root.render(React.createElement(React.StrictMode, null, React.createElement(Collaboration, { view: "tasks" })));
    window.clearComponent = () => root.render(null);`, resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  plugins: [{ name: "local-view-fixtures", setup(builder) {
    builder.onResolve({ filter: /(?:\/|^)(?:api|AuthorShell)$/ }, args => {
      const importer = args.importer.replaceAll("\\", "/");
      if (!importer.startsWith(resolve("apps/web").replaceAll("\\", "/"))) return;
      if (args.path.endsWith("AuthorShell")) return { path: "shell", namespace: "fixture" };
      if (!importer.endsWith("/CollaborationCenter.tsx")) return { path: "api", namespace: "fixture" };
    });
    builder.onLoad({ filter: /^api$/, namespace: "fixture" }, () => ({
      contents: `import { createClient } from "@bookworm/api-client";
        export const apiClient = actor => window.useRealClient
          ? createClient({ baseUrl: "/api/backend", expectedActor: actor }) : window.api;`,
      resolveDir: process.cwd(),
    }));
    builder.onLoad({ filter: /^shell$/, namespace: "fixture" }, () => ({ contents: 'import React from "react"; export function AuthorPage({children}) { return React.createElement("div", null, children); } export function AuthorHeader() { return null; }', resolveDir: process.cwd() }));
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
    builder.onLoad({ filter: /^navigation$/, namespace: "fixture" }, () => ({ contents: 'export const useSearchParams = () => new URLSearchParams(window.query); export const useParams = () => ({ id: window.communityId });' }));
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
    builder.onLoad({ filter: /^link$/, namespace: "fixture" }, () => ({ contents: 'import React from "react"; export default function Link(props) { return React.createElement("a", props); }', resolveDir: process.cwd() }));
  } }],
});
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
const stylePath = resolve("apps/web/styles/globals.css");
const styles = await postcss([tailwind({ base: resolve("apps/web"), optimize: false })]).process(await readFile(stylePath, "utf8"), { from: stylePath });
const instrument = (await readFile(resolve("apps/web/app/fonts/instrument-serif-italic.ttf"))).toString("base64");
const artifacts = await mkdtemp(resolve(tmpdir(), "bookworm-dashboard-mounted-"));
test.after(async () => { await browser.close(); console.log(JSON.stringify({ dashboardArtifacts: artifacts })); });
async function fixture({ width = 1280, styled = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 980 } });
  page.setDefaultTimeout(5000);
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' }));
  await page.goto("http://127.0.0.1/bookworm-analytics-admin-fixture");
  // The display font and project CSS are real; exact Next body-font loading is verified separately.
  if (styled) await page.addStyleTag({ content: styles.css + `
    @font-face {font-family:BookwormInstrument;src:url(data:font/ttf;base64,${instrument});font-style:italic;font-weight:400;font-display:swap}
    :root {--font-inter:Inter,sans-serif;--font-instrument-serif:BookwormInstrument,serif}
    body {font-family:var(--font-inter);color:#fff}` });
  await page.evaluate(() => {
    window.calls = []; window.reads = []; window.gates = {}; window.query = "";
    window.account = "11111111-1111-4111-8111-111111111111";
    window.fetch = async () => Response.json({ user: { id: window.account, email: "author@example.test" } });
    window.defer = name => new Promise((resolve, reject) => { window.gates[name] = { resolve, reject }; });
    window.sales = id => ({ imports: [{ id: id + "-receipt", workspace_id: id, file_name: id + " receipt.csv", row_count: 1, source: "amazon_kdp", period_start: "2026-09-01", period_end: "2026-09-30", created_at: "2026-10-01T00:00:00Z" }],
      summary: { available: true, status: "imported", imports: 1, units: 2, royaltyCents: id === "b" ? 123 : 456, reportedProceedsCents: null, currency: "USD", currencies: [] },
      analytics: { available: true, windowStart: "2026-09-01", windowEnd: "2026-10-01", monthCount: 1, monthly: [{ month: "2026-09-01", currency: "USD", units: 2, royaltyCents: 123, reportedProceedsCents: null }], books: [], sources: [], bookCount: 0, booksTruncated: false } });
    window.overview = (id, suffix = "") => ({ viewerId: window.account, workspace: { id, name: `Workspace ${id.toUpperCase()}`, organizationId: `${id}-organization`, role: "writer" },
      books: [{ id: `${id}-book`, workspace_id: id, title: id.toUpperCase() + " book" + suffix, status: "draft", language: "en", author_name: "Fixture author", genre: null }],
      summary: { activeBooks: 1, inProductionBooks: 1, publishedBooks: 0, assets: 7, visualAssets: 3, pendingJobs: 1, failedJobs: 0, readyPackages: 2 },
      usage: { entitlements: { plan: { name: `${id}-private-plan` }, entitlements: { ai_credits_monthly: 500 } }, usage: { ai_credits: 37 }, creditBalance: id === "a" ? 1717 : 2828 },
      sales: { ...window.sales(id).summary, message: `${id} private retailer report` },
      recentJobs: [{ id: `${id}-job`, kind: "ai", label: `${id} private job`, status: "running", bookId: `${id}-book`, bookTitle: `${id} private job source`, createdAt: "2026-10-01T00:00:00Z" }],
      activity: [{ id: `${id}-activity`, event_type: `${id}_private_activity`, created_at: "2026-10-01T00:00:00Z", payload_json: {} }] });
    window.api = { listWorkspaces: async () => ({ workspaces: [{ id: "a", name: "Workspace A" }, { id: "b", name: "Workspace B" }] }),
      getDashboardOverview: async id => window.overview(id),
      listRetailerSalesImports: async id => window.sales(id),
      importRetailerSales: async body => { window.calls.push({ operation: "import", body }); return { importId: "saved-receipt", rowCount: 1, duplicate: false }; },
      adminList: async () => [], adminModerationReports: async () => ({ reports: [] }),
      adminAccess: async () => ({ admin: true, viewerId: window.account }) };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}

test("managed publishing recovers an operator-confirmed listing after a lost response", async () => {
  const page = await fixture({ width: 390 });
  try {
    await page.evaluate(() => {
      const jobId = "33333333-3333-4333-8333-333333333333";
      const packageSha256 = "a".repeat(64);
      const requestedAt = "2026-11-20T18:00:00Z";
      window.api.adminAccess = async () => ({ admin: true, viewerId: window.account, managedPublishing: true });
      window.api.adminManagedPublishingQueue = async () => ({
        requests: [{ jobId, packageSha256, requestedAt, claimedAt: requestedAt, channel: "kdp", title: "Harbor Letters",
          confirmedAt: window.listing ? requestedAt : null, listingUrl: window.listing ?? null }], nextOffset: null,
      });
      window.api.adminConfirmManagedPublishing = async (...args) => {
        window.calls.push(args);
        window.listing = args[2];
        throw new Error("Lost publication response");
      };
      window.renderAdmin();
    });
    await page.getByRole("button", { name: "managed publishing", exact: true }).click();
    await page.getByText("Confirm publication", { exact: true }).click();
    const listing = "https://www.amazon.com/dp/B000000001";
    await page.getByRole("textbox", { name: "Retailer listing URL" }).fill(listing);
    const save = page.getByRole("button", { name: "Save confirmation" });
    await save.click();
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    await page.getByRole("checkbox", { name: "I verified this listing in the retailer account." }).check();
    await save.click();
    await expect(page.getByRole("alert")).toContainText("Refresh to check");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText(/Publication confirmed/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Open retailer listing" })).toHaveAttribute("href", listing);
    await expect(save).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download private ZIP" })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.calls), [
      ["33333333-3333-4333-8333-333333333333", "a".repeat(64), listing, "11111111-1111-4111-8111-111111111111"],
    ]);
  } finally { await page.close(); }
});

test("managed publishing queue is capability-scoped and recovers a claim without writing again", async () => {
  const page = await fixture({ width: 390 });
  try {
    await page.evaluate(() => {
      const jobId = "33333333-3333-4333-8333-333333333333";
      const packageSha256 = "a".repeat(64);
      const requestedAt = "2026-11-20T18:00:00Z";
      window.api.adminAccess = async () => ({ admin: true, viewerId: window.account, managedPublishing: window.operator === true });
      window.api.adminManagedPublishingQueue = async (offset, actor) => {
        if (offset !== 0 || actor !== window.account) throw new Error("Wrong queue scope");
        return { requests: [{ jobId, packageSha256, requestedAt, claimedAt: window.claimed ? requestedAt : null, channel: "kdp", title: "Harbor Letters" }], nextOffset: null };
      };
      window.api.adminClaimManagedPublishing = async (...args) => {
        window.calls.push(args);
        window.claimed = true;
        throw new Error("Lost claim response");
      };
      const sessionFetch = window.fetch;
      window.downloads = [];
      URL.createObjectURL = blob => { window.downloads.push(blob.size); return "blob:synthetic"; };
      URL.revokeObjectURL = () => {};
      HTMLAnchorElement.prototype.click = function () { window.downloads.push(this.download); };
      window.fetch = async (path, options) => {
        if (path !== `/api/backend/v1/admin/managed-publishing/${jobId}/package?checksum=${packageSha256}`) return sessionFetch(path, options);
        if (options.headers["x-bookworm-actor"] !== "11111111-1111-4111-8111-111111111111") throw new Error("Wrong download actor");
        if (window.holdDownload) await window.defer("managed-zip");
        return new Response("PK-file", { headers: { "content-type": "application/zip", "content-length": "7",
          "content-disposition": 'attachment; filename="kdp-export.zip"' } });
      };
      window.renderAdmin();
    });
    const tab = page.getByRole("button", { name: "managed publishing", exact: true });
    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    await expect(refresh).toBeEnabled();
    await expect(tab).toHaveCount(0);
    await page.evaluate(() => { window.operator = true; });
    await refresh.click();
    await tab.click();
    await expect(page.getByText("Harbor Letters", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Claim request" }).click();
    await expect(page.getByRole("alert")).toContainText("Refresh to check");
    await expect(page.getByText("Harbor Letters", { exact: true })).toHaveCount(0);
    await refresh.click();
    await expect(page.getByText("Claimed by you")).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.calls), [[
      "33333333-3333-4333-8333-333333333333", "a".repeat(64), "11111111-1111-4111-8111-111111111111",
    ]]);
    const download = page.getByRole("button", { name: "Download private ZIP" });
    await download.click();
    await expect.poll(() => page.evaluate(() => window.downloads)).toEqual([7, "kdp-export.zip"]);
    await page.evaluate(() => { window.holdDownload = true; });
    await download.click();
    await page.waitForFunction(() => window.gates["managed-zip"]);
    await page.evaluate(() => {
      window.account = "22222222-2222-4222-8222-222222222222";
      window.operator = false;
      window.gates["managed-zip"].resolve();
    });
    await expect(tab).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.downloads), [7, "kdp-export.zip"]);
  } finally { await page.close(); }
});

async function mountCollaboration(page, { failRead = false, write = "confirmed" } = {}) {
  await page.evaluate(({ failRead, write }) => {
    const workspace = { id: "33333333-3333-4333-8333-333333333333", name: "Publishing team" };
    const tasks = new Map();
    window.failCollaborationRead = failRead;
    window.fetch = async (url, request = {}) => {
      const { pathname } = new URL(url, location.origin);
      const actor = window.account;
      if (pathname === "/api/auth/session") {
        if (window.holdCollaborationSession) {
          window.holdCollaborationSession = false;
          await window.defer("collaboration-session");
        }
        return Response.json({ user: actor ? { id: actor } : null });
      }
      const method = request.method || "GET";
      const expected = new Headers(request.headers).get("x-bookworm-actor");
      window.calls.push({ method, pathname, actor, expected });
      const error = (status, code, message) => Response.json({ error: { code, message } }, { status });
      if (expected !== actor) return error(409, "auth_error", "Your account changed.");
      if (pathname === "/api/backend/v1/workspaces") return Response.json({ workspaces: [workspace] });
      if (pathname === `/api/backend/v1/workspaces/${workspace.id}/members`) {
        return Response.json({ members: [{ user_id: actor, role: "owner", status: "active" }], profiles: [] });
      }
      if (pathname === "/api/backend/v1/activity") return Response.json({ events: [] });
      if (pathname === "/api/backend/v1/tasks" && method === "GET") {
        if (window.failCollaborationRead) return error(503, "unavailable", "Tasks could not be refreshed.");
        return Response.json({ tasks: tasks.get(actor) ?? [] });
      }
      if (pathname === "/api/backend/v1/tasks" && method === "POST") {
        const { title } = JSON.parse(request.body);
        const saved = tasks.get(actor) ?? [];
        const task = { id: `task-${saved.length}`, title, status: "todo", priority: "medium", assignee_id: null };
        tasks.set(actor, [...saved, task]);
        if (write === "lost") throw new Error("Synthetic lost response after save");
        if (write === "delayed") await window.defer("collaboration-write");
        if (write === "refresh-fails") window.failCollaborationRead = true;
        return Response.json(task, { status: 201 });
      }
      throw new Error(`Unexpected collaboration request ${method} ${pathname}`);
    };
    window.renderCollaboration();
  }, { failRead, write });
}

test("collaboration shows a failed read with recovery instead of empty or permanent loading", async () => {
  const page = await fixture({ width: 390, styled: true });
  try {
    await mountCollaboration(page, { failRead: true });
    await expect(page.getByRole("alert")).toHaveText("Tasks could not be refreshed.");
    await expect(page.getByText("Loading workspace collaboration data…")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Task board" })).toHaveCount(0);
    await page.screenshot({ path: resolve(artifacts, "collaboration-unavailable-mobile.png") });
    await page.evaluate(() => { window.failCollaborationRead = false; });
    await page.getByRole("button", { name: "Refresh workspace data" }).click();
    await expect(page.getByRole("region", { name: "Task board" })).toBeVisible();
    assert(await page.evaluate(() => window.calls.every(call => call.expected && call.expected === call.actor)));
  } finally { await page.close(); }
});

for (const write of ["refresh-fails", "lost"]) test(`collaboration preserves the ${write} result and recovers with reads`, async () => {
  const page = await fixture({ styled: write === "refresh-fails" });
  try {
    await mountCollaboration(page, { write });
    await page.getByLabel("Task title").fill("Review the proof");
    await page.getByRole("button", { name: "Create task" }).click();
    const confirmed = page.getByText("Task created.", { exact: true });
    const unconfirmed = page.getByText("The action may have completed. Review the saved records before trying again.", { exact: true });
    if (write === "refresh-fails") {
      await expect(confirmed).toBeVisible();
      await expect(page.getByRole("alert")).toHaveText("Tasks could not be refreshed.");
      await page.screenshot({ path: resolve(artifacts, "collaboration-confirmed-desktop.png") });
    } else {
      await expect(unconfirmed).toBeVisible();
      await expect(confirmed).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: "Create task" })).toHaveCount(0);
    await page.evaluate(() => { window.failCollaborationRead = false; });
    await page.getByRole("button", { name: "Refresh workspace data" }).click();
    await expect(page.getByRole("heading", { name: "Review the proof" })).toHaveCount(1);
    await expect(write === "refresh-fails" ? confirmed : unconfirmed).toBeVisible();
    const writes = await page.evaluate(() => window.calls.filter(call => call.method === "POST"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].expected, writes[0].actor);
  } finally { await page.close(); }
});

test("collaboration blocks an old draft when the account changed before dispatch", async () => {
  const page = await fixture();
  try {
    await mountCollaboration(page);
    await page.getByLabel("Task title").fill("Original account draft");
    await page.evaluate(() => { window.account = "22222222-2222-4222-8222-222222222222"; });
    await page.getByRole("button", { name: "Create task" }).click();
    await expect(page.getByLabel("Task title")).toHaveValue("");
    await expect(page.getByText("Task created.", { exact: true })).toHaveCount(0);
    const writes = await page.evaluate(() => window.calls.filter(call => call.method === "POST"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].expected, "11111111-1111-4111-8111-111111111111");
    assert.notEqual(writes[0].actor, writes[0].expected);
  } finally { await page.close(); }
});

test("collaboration hides a replacement account's old view and ignores its late write reply", async () => {
  const page = await fixture();
  try {
    await mountCollaboration(page, { write: "delayed" });
    await page.getByLabel("Task title").fill("Original account task");
    await page.getByRole("button", { name: "Create task" }).click();
    await page.waitForFunction(() => window.gates["collaboration-write"]);
    await page.evaluate(() => {
      window.account = "22222222-2222-4222-8222-222222222222";
      window.holdCollaborationSession = true;
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForFunction(() => window.gates["collaboration-session"]);
    await expect(page.getByText("Checking workspace access…", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Task title")).toHaveCount(0);
    await page.evaluate(() => window.gates["collaboration-session"].resolve());
    await expect(page.getByLabel("Task title")).toHaveValue("");
    await page.getByLabel("Task title").fill("Replacement account draft");
    await page.evaluate(() => window.gates["collaboration-write"].resolve());
    await expect(page.getByLabel("Task title")).toHaveValue("Replacement account draft");
    await expect(page.getByText("Task created.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Original account task" })).toHaveCount(0);
  } finally { await page.close(); }
});

test("late sales success cannot mix an old workspace into the current ledger", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.api.listRetailerSalesImports = id => id === "a" ? window.defer("sales-a") : Promise.resolve(window.sales(id)); window.renderAnalytics("ws=a"); });
    await page.waitForFunction(() => !!window.gates["sales-a"]);
    await page.evaluate(() => window.renderAnalytics("ws=b"));
    await expect(page.getByText("b receipt.csv", { exact: true })).toBeVisible();
    await page.evaluate(() => window.gates["sales-a"].resolve(window.sales("a")));
    await expect(page.getByText("a receipt.csv", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "B book", exact: true })).toHaveCount(1);
    await expect(page.getByRole("option", { name: "A book", exact: true })).toHaveCount(0);
  } finally { await page.close(); }
});

for (const stage of ["workspaces", "overview"]) for (const status of [401, 403, 503]) {
  test(`dashboard ${stage} ${status} revalidation removes prior private data and retries the requested workspace`, async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => window.renderDashboard());
      await expect(page.getByRole("heading", { name: "A book", exact: true })).toBeVisible();
      await expect(page.getByText("1,717", { exact: true })).toBeVisible();
      await page.evaluate(stage => {
        if (stage === "workspaces") window.api.listWorkspaces = () => window.defer("reload");
        else window.api.getDashboardOverview = () => window.defer("reload");
      }, stage);
      await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption("b");
      await page.waitForFunction(() => !!window.gates.reload);
      await expect(page.getByRole("region", { name: "Publishing operations", exact: true })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Recent workspace state", exact: true })).toHaveCount(0);
      for (const privateText of ["A book", "1,717", "a-private-plan", "a private retailer report", "a private job", "a private activity"]) {
        await expect(page.getByText(privateText, { exact: true })).toHaveCount(0);
      }
      await page.evaluate(status => window.gates.reload.reject(new Error(`${status}: workspace revalidation failed`)), status);
      await expect(page.getByRole("alert")).toContainText(`${status}: workspace revalidation failed`);
      await expect(page.getByRole("heading", { name: "A book", exact: true })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Publishing operations", exact: true })).toHaveCount(0);
      await page.evaluate(() => {
        window.api.listWorkspaces = async () => ({ workspaces: [{ id: "a", name: "Workspace A" }, { id: "b", name: "Workspace B" }] });
        window.api.getDashboardOverview = async id => { window.reads.push(id); return window.overview(id); };
      });
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await expect(page.getByRole("heading", { name: "B book", exact: true })).toBeVisible();
      await expect(page.getByText("2,828", { exact: true })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      assert.deepEqual(await page.evaluate(() => window.reads), ["b"]);
      assert.deepEqual(await page.evaluate(() => window.calls), [], "revalidation must not write or charge");
      assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => /private plan|private job|private retailer|book$/i.test(value))), false);
    } finally { await page.close(); }
  });
}

for (const outcome of ["success", "failure"]) test(`dashboard ignores an older focus-replaced workspace-list ${outcome}`, async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      let count = 0;
      window.api.listWorkspaces = () => ++count === 1 ? window.defer("older-list") : Promise.resolve({ workspaces: [{ id: "b", name: "Workspace B" }] });
      window.api.getDashboardOverview = async id => { window.reads.push(id); return window.overview(id); };
      window.renderDashboard();
    });
    await page.waitForFunction(() => !!window.gates["older-list"]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("heading", { name: "B book", exact: true })).toBeVisible();
    await page.evaluate(async outcome => {
      if (outcome === "success") window.gates["older-list"].resolve({ workspaces: [{ id: "a", name: "Workspace A" }] });
      else window.gates["older-list"].reject(new Error("Old list access revoked"));
      await new Promise(resolve => setTimeout(resolve, 0));
    }, outcome);
    await expect(page.getByRole("heading", { name: "B book", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("option", { name: "Workspace A", exact: true })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.reads), ["b"]);
    assert.equal(await page.evaluate(() => localStorage.getItem("bookworm:workspaceId")), "b");
  } finally { await page.close(); }
});

for (const outcome of ["success", "failure"]) test(`dashboard ignores an unmounted workspace overview ${outcome}`, async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      history.replaceState(null, "", "?ws=a");
      window.api.getDashboardOverview = id => id === "a" ? window.defer("older-overview") : Promise.resolve(window.overview(id));
      window.renderDashboard();
    });
    await page.waitForFunction(() => !!window.gates["older-overview"]);
    await page.evaluate(() => window.clearComponent());
    await expect(page.locator("#root > *")).toHaveCount(0);
    await page.evaluate(() => { history.replaceState(null, "", "?ws=b"); window.renderDashboard(); });
    await expect(page.getByRole("heading", { name: "B book", exact: true })).toBeVisible();
    await page.evaluate(async outcome => {
      if (outcome === "success") window.gates["older-overview"].resolve(window.overview("a"));
      else window.gates["older-overview"].reject(new Error("Old overview failure"));
      await new Promise(resolve => setTimeout(resolve, 0));
    }, outcome);
    await expect(page.getByRole("heading", { name: "B book", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "A book", exact: true })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    assert.equal(await page.evaluate(() => localStorage.getItem("bookworm:workspaceId")), "b");
  } finally { await page.close(); }
});

test("dashboard unmount fences a pending workspace list before storage or overview reads", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.api.listWorkspaces = () => window.defer("older-list");
      window.api.getDashboardOverview = async id => { window.reads.push(id); return window.overview(id); };
      window.renderDashboard();
    });
    await page.waitForFunction(() => !!window.gates["older-list"]);
    await page.evaluate(() => window.clearComponent());
    await expect(page.locator("#root > *")).toHaveCount(0);
    await page.evaluate(async () => { window.gates["older-list"].resolve({ workspaces: [{ id: "a", name: "Workspace A" }] }); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual(await page.evaluate(() => window.reads), []);
    assert.equal(await page.evaluate(() => localStorage.getItem("bookworm:workspaceId")), null);
  } finally { await page.close(); }
});

test("dashboard reads remain scoped when browser preference storage is blocked", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
      Storage.prototype.getItem = function(key) { if (this === localStorage) throw new Error("Preference storage blocked"); return get.call(this, key); };
      Storage.prototype.setItem = function(key, value) { if (this === localStorage) throw new Error("Preference storage blocked"); return set.call(this, key, value); };
      window.renderDashboard();
    });
    await expect(page.getByRole("heading", { name: "A book", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.calls), []);
  } finally { await page.close(); }
});

test("dashboard does not silently substitute another workspace for an unavailable requested one", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      history.replaceState(null, "", "?ws=unavailable");
      window.api.getDashboardOverview = async id => { window.reads.push(id); return window.overview(id); };
      window.renderDashboard();
    });
    await expect(page.getByRole("alert")).toContainText("Requested workspace is no longer available");
    await expect(page.getByRole("heading", { name: "A book", exact: true })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.reads), []);
    await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption("b");
    await expect(page.getByRole("heading", { name: "B book", exact: true })).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.reads), ["b"]);
  } finally { await page.close(); }
});

test("a late dashboard workspace-creation reply cannot load a workspace after unmount", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.api.listWorkspaces = async () => { window.reads.push("list"); return { workspaces: [] }; };
      window.api.createOnboardingWorkspace = body => { window.calls.push({ operation: "create-workspace", body }); return window.defer("create"); };
      window.renderDashboard();
    });
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await page.waitForFunction(() => !!window.gates.create);
    await page.evaluate(() => window.clearComponent());
    await expect(page.locator("#root > *")).toHaveCount(0);
    await page.evaluate(async () => { window.gates.create.resolve({ workspace: { id: "new-workspace", name: "Created studio" } }); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual(await page.evaluate(() => window.reads), ["list"]);
    assert.equal(await page.evaluate(() => localStorage.getItem("bookworm:workspaceId")), null);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith("bookworm:workspace-creation:"))), true);
    assert.equal((await page.evaluate(() => window.calls)).length, 1, "explicit creation occurs once; unmount is not cancellation");
  } finally { await page.close(); }
});

for (const mismatch of ["workspace", "book"]) test(`dashboard refuses a ${mismatch} from a different response scope`, async () => {
  const page = await fixture();
  try {
    await page.evaluate(mismatch => {
      window.api.getDashboardOverview = async id => {
        const result = window.overview(id);
        if (mismatch === "workspace") result.workspace.id = "foreign";
        else result.books = window.overview("b").books;
        return result;
      };
      window.renderDashboard();
    }, mismatch);
    await expect(page.getByRole("alert")).toContainText("Dashboard response does not match the requested account and workspace");
    await expect(page.getByRole("region", { name: "Publishing operations", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /[AB] book/ })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.calls), []);
  } finally { await page.close(); }
});

test("workspace creation and its dashboard confirmation do not require preference storage", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
      Storage.prototype.getItem = function(key) { if (this === localStorage) throw new Error("Preference storage blocked"); return get.call(this, key); };
      Storage.prototype.setItem = function(key, value) { if (this === localStorage) throw new Error("Preference storage blocked"); return set.call(this, key, value); };
      window.created = false;
      window.api.listWorkspaces = async () => ({ workspaces: window.created ? [{ id: "c", name: "New studio" }] : [] });
      window.api.createOnboardingWorkspace = async body => { window.calls.push({ operation: "create-workspace", body }); window.created = true; return { workspace: { id: "c", name: "New studio" } }; };
      window.renderDashboard();
    });
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: "C book", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    const calls = await page.evaluate(() => window.calls);
    assert.equal(calls.length, 1); assert.equal(calls[0].operation, "create-workspace"); assert.equal(calls[0].body.name, "My publishing studio");
    assert.match(calls[0].body.operationId, /^[a-f0-9-]{36}$/u);
  } finally { await page.close(); }
});

test("explicit dashboard reload is read-only, single-flight and preserves keyboard focus while waiting", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.renderDashboard());
    await expect(page.getByRole("heading", { name: "A book", exact: true })).toBeVisible();
    await page.evaluate(() => { window.api.getDashboardOverview = id => { window.reads.push(id); return window.defer("refresh"); }; });
    const reload = page.getByRole("button", { name: "Reload dashboard", exact: true });
    await reload.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => !!window.gates.refresh);
    await expect(reload).toHaveAttribute("aria-disabled", "true");
    await expect(reload).toBeFocused();
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("region", { name: "Workspace summary", exact: true })).toHaveCount(0);
    await page.keyboard.press("Space");
    assert.deepEqual(await page.evaluate(() => window.reads), ["a"]);
    await page.evaluate(() => window.gates.refresh.resolve(window.overview("a", " refreshed")));
    await expect(page.getByRole("heading", { name: "A book refreshed", exact: true })).toBeVisible();
    await expect(reload).toHaveAttribute("aria-disabled", "false");
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    assert.deepEqual(await page.evaluate(() => window.calls), []);
  } finally { await page.close(); }
});

test("styled dashboard, long names and failed revalidation remain contained with 44px mobile controls", async () => {
  const page = await fixture({ styled: true });
  try {
    await page.evaluate(() => {
      window.api.listWorkspaces = async () => ({ workspaces: [{ id: "a", name: "PublishingStudio".repeat(30) }] });
      window.api.getDashboardOverview = async id => {
        const result = window.overview(id);
        result.books[0].title = "UnbrokenManuscriptTitle".repeat(20);
        result.usage.entitlements.plan.name = "PublishingPlan".repeat(20);
        result.activity[0].event_type = "privateactivity".repeat(30);
        return result;
      };
      window.renderDashboard();
    });
    await expect(page.getByRole("region", { name: "Publishing operations", exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(artifacts, "dashboard-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 375, height: 844 });
    const inspect = () => page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll("main *")].filter(element => { const box = element.getBoundingClientRect(); return box.width && (box.left < -0.5 || box.right > innerWidth + 0.5); }).map(element => element.tagName),
      controls: [...document.querySelectorAll('#workspace, button[aria-label="Reload dashboard"], [role="alert"] button')].map(element => ({ name: element.getAttribute("aria-label") || element.id || element.textContent.trim(), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })) }));
    const ready = await inspect();
    assert.equal(ready.scrollWidth, 375);
    assert.deepEqual(ready.overflow, []);
    assert(ready.controls.every(control => control.width >= 44 && control.height >= 44));
    await page.screenshot({ path: resolve(artifacts, "dashboard-mobile.png"), fullPage: true });
    await page.evaluate(() => { window.api.getDashboardOverview = async () => { throw new Error("503: private dashboard summary unavailable"); }; });
    await page.getByRole("button", { name: "Reload dashboard", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("503: private dashboard summary unavailable");
    await expect(page.getByRole("region", { name: "Workspace summary", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Publishing operations", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Add a book", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Create or import", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeFocused();
    assert.equal(await page.getByRole("button", { name: "Try again", exact: true }).evaluate(element => getComputedStyle(element).boxShadow !== "none"), true);
    const denied = await inspect();
    assert.equal(denied.scrollWidth, 375);
    assert.deepEqual(denied.overflow, []);
    assert(denied.controls.every(control => control.width >= 44 && control.height >= 44));
    await page.screenshot({ path: resolve(artifacts, "dashboard-revalidation-failure-mobile.png"), fullPage: true });
    await writeFile(resolve(artifacts, "dashboard-mobile-bounds.json"), JSON.stringify({ ready, denied }, null, 2));
  } finally { await page.close(); }
});

test("late sales failure cannot overwrite a newer successful workspace", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.api.listRetailerSalesImports = id => id === "a" ? window.defer("sales-a") : Promise.resolve(window.sales(id)); window.renderAnalytics("ws=a"); });
    await page.waitForFunction(() => !!window.gates["sales-a"]);
    await page.evaluate(() => window.renderAnalytics("ws=b"));
    await expect(page.getByText("b receipt.csv", { exact: true })).toBeVisible();
    await page.evaluate(() => window.gates["sales-a"].reject(new Error("Old workspace failure")));
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally { await page.close(); }
});

test("blocked browser storage does not prevent a scoped read-only sales view", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { Storage.prototype.getItem = () => { throw new Error("Storage blocked"); }; Storage.prototype.setItem = () => { throw new Error("Storage blocked"); }; window.renderAnalytics("ws=b"); });
    await expect(page.getByText("b receipt.csv", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    assert.equal((await page.evaluate(() => window.calls)).length, 0);
  } finally { await page.close(); }
});

test("a sales import cannot be redirected by switching workspaces during its save", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.api.importRetailerSales = body => { window.calls.push({ operation: "import", body }); return window.defer("import-a"); }; window.renderAnalytics("ws=a"); });
    await expect(page.getByText("a receipt.csv", { exact: true })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({ name: "report.csv", mimeType: "text/csv", buffer: Buffer.from("date,title,units,royalty,currency\n2026-09-01,River,1,2.50,USD") });
    await page.getByRole("button", { name: "Import 1 verified rows", exact: true }).click();
    await page.waitForFunction(() => !!window.gates["import-a"]);
    await expect(page.getByRole("combobox", { name: "Workspace", exact: true })).toBeDisabled();
    await page.evaluate(() => window.renderAnalytics("ws=b"));
    await expect(page.getByText("b receipt.csv", { exact: true })).toBeVisible();
    await page.evaluate(() => window.gates["import-a"].resolve({ rowCount: 1, duplicate: false }));
    await expect(page.getByText("b receipt.csv", { exact: true })).toBeVisible();
    await expect(page.getByText("Imported 1 row from the retailer report.", { exact: true })).toHaveCount(0);
    assert.equal((await page.evaluate(() => window.calls))[0].body.workspaceId, "a");
  } finally { await page.close(); }
});

test("a confirmed sales receipt stays visible when the ledger cannot be refreshed", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.api.importRetailerSales = async body => {
        window.calls.push({ operation: "import", body });
        window.api.listRetailerSalesImports = async () => { throw new Error("Sales refresh is unavailable."); };
        return { importId: "saved-receipt", rowCount: 1, duplicate: false };
      };
      window.renderAnalytics("ws=a");
    });
    await expect(page.getByText("a receipt.csv", { exact: true })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({ name: "report.csv", mimeType: "text/csv", buffer: Buffer.from("date,title,units,royalty,currency\n2026-09-01,River,1,2.50,USD") });
    await page.getByRole("button", { name: "Import 1 verified rows", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Sales refresh is unavailable.");
    await expect(page.getByRole("status")).toContainText("Imported 1 row from the retailer report.");
    await expect(page.getByText("Awaiting report", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Saved reports could not be verified.", { exact: true })).toBeVisible();
    await expect(page.getByText(/No retailer report saved yet/)).toHaveCount(0);
    await page.evaluate(() => { window.api.listRetailerSalesImports = async id => window.sales(id); });
    await page.getByRole("button", { name: "Refresh reports", exact: true }).click();
    await expect(page.getByText("a receipt.csv", { exact: true })).toBeVisible();
    assert.equal((await page.evaluate(() => window.calls)).length, 1);
  } finally { await page.close(); }
});

test("a sales draft survives a same-account focus check and cannot be sent by a replacement account", async () => {
  const page = await fixture();
  try {
    const original = "11111111-1111-4111-8111-111111111111";
    await page.evaluate(() => {
      window.useRealClient = true;
      window.sessionReads = 0;
      window.fetch = async (path, request = {}) => {
        if (path === "/api/auth/session") {
          window.sessionReads++;
          return Response.json({ user: { id: window.account } });
        }
        const { pathname } = new URL(path, location.origin);
        const expected = new Headers(request.headers).get("x-bookworm-actor");
        if (request.method === "POST") window.calls.push({ expected, actor: window.account });
        if (expected && expected !== window.account) return Response.json({ error: { code: "auth_error", message: "Your account changed." } }, { status: 409 });
        if (pathname.endsWith("/workspaces")) return Response.json({ workspaces: [{ id: "a", name: "Shared workspace" }] });
        if (pathname.endsWith("/dashboard")) return Response.json(window.overview("a"));
        if (request.method === "POST") {
          window.writes = (window.writes || 0) + 1;
          return Response.json({ importId: "saved-receipt", rowCount: 1, duplicate: false }, { status: 201 });
        }
        const sales = window.sales("a");
        if (!window.account.startsWith("1111")) sales.imports[0].file_name = "replacement receipt.csv";
        return Response.json(sales);
      };
      window.renderAnalytics("ws=a");
    });
    await expect(page.getByText("a receipt.csv", { exact: true })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({ name: "draft.csv", mimeType: "text/csv", buffer: Buffer.from("date,title,units,royalty,currency\n2026-09-01,River,1,2.50,USD") });
    const submit = page.getByRole("button", { name: "Import 1 verified rows", exact: true });
    await expect(submit).toBeEnabled();
    const before = await page.evaluate(() => window.sessionReads);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(before => window.sessionReads > before, before);
    await expect(submit).toBeEnabled();
    await page.evaluate(() => { window.account = "22222222-2222-4222-8222-222222222222"; });
    await submit.click();
    await expect(page.getByText("replacement receipt.csv", { exact: true })).toBeVisible();
    await expect(page.getByText("draft.csv", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Imported 1 row from the retailer report.", { exact: true })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => ({ writes: window.writes || 0, expected: window.calls.map(call => call.expected) })), { writes: 0, expected: [original] });
  } finally { await page.close(); }
});

test("a moderation confirmation stays bound to the original administrator", async () => {
  const page = await fixture();
  try {
    const original = "11111111-1111-4111-8111-111111111111";
    await page.evaluate(() => {
      window.useRealClient = true;
      window.fetch = async (path, request = {}) => {
        if (path === "/api/auth/session") return Response.json({ user: { id: window.account } });
        const { pathname } = new URL(path, location.origin);
        const expected = new Headers(request.headers).get("x-bookworm-actor");
        if (request.method === "POST") window.calls.push({ expected, actor: window.account });
        if (expected && expected !== window.account) return Response.json({ error: { code: "auth_error", message: "Your account changed." } }, { status: 409 });
        if (pathname.endsWith("/access")) return Response.json({ admin: true, viewerId: window.account });
        if (pathname.endsWith("/users")) return Response.json({ users: [] });
        if (pathname.endsWith("/reports")) return Response.json({ reports: window.account.startsWith("1111") ? [{
          id: "report", entity_type: "post", status: "open", reason: "First account report",
          target: { type: "post", title: "First account post", body: "First account content" },
        }] : [] });
        window.writes = (window.writes || 0) + 1;
        return Response.json({ reportId: "report", status: "actioned", action: "remove", alreadyResolved: false });
      };
      window.renderAdmin();
    });
    await page.getByRole("button", { name: "moderation", exact: true }).click();
    await page.getByRole("button", { name: "Review removal", exact: true }).click();
    await page.evaluate(() => { window.account = "22222222-2222-4222-8222-222222222222"; });
    await page.getByRole("button", { name: "Confirm removal", exact: true }).click();
    await expect(page.getByText("No reports match these filters", { exact: true })).toBeVisible();
    await expect(page.getByText("First account content", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Moderation outcome saved/)).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => ({ writes: window.writes || 0, expected: window.calls.map(call => call.expected) })), { writes: 0, expected: [original] });
  } finally { await page.close(); }
});

test("a same-account admin review resumes after revalidation and a late reply stays with that account", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.api.adminModerationReports = async () => ({ reports: window.account.startsWith("1111") ? [{
        id: "report", entity_type: "post", status: "open", reason: "First account report",
        target: { type: "post", title: "First account post", body: "First account content" },
      }] : [] });
      window.api.adminResolveModerationReport = () => window.defer("decision");
      window.renderAdmin();
    });
    await page.getByRole("button", { name: "moderation", exact: true }).click();
    await page.getByRole("button", { name: "Review removal", exact: true }).click();
    await page.evaluate(() => {
      window.api.adminAccess = () => window.defer("recheck");
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForFunction(() => !!window.gates.recheck);
    await expect(page.getByRole("button", { name: "Confirm removal", exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      window.api.adminAccess = async () => ({ admin: true, viewerId: window.account });
      window.gates.recheck.resolve({ admin: true, viewerId: window.account });
    });
    await page.getByRole("button", { name: "Confirm removal", exact: true }).click();
    await page.waitForFunction(() => !!window.gates.decision);
    await page.evaluate(() => {
      window.account = "22222222-2222-4222-8222-222222222222";
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.getByText("No reports match these filters", { exact: true })).toBeVisible();
    await page.evaluate(async () => {
      window.gates.decision.resolve({ reportId: "report", status: "actioned", action: "remove", alreadyResolved: false });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await expect(page.getByText("First account content", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Moderation outcome saved/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  } finally { await page.close(); }
});

test("admin document health is hidden during refresh and stays hidden on failure", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.api.adminDocumentJobHealth = async () => ({ health: { due_queued: 71 } });
      window.renderAdmin();
    });
    await page.getByRole("button", { name: "jobs", exact: true }).click();
    await page.getByRole("combobox", { name: "Job type", exact: true }).selectOption("document");
    await expect(page.getByRole("region", { name: "Document queue health" })).toContainText("71");
    await page.evaluate(() => { window.api.adminList = () => window.defer("job-queue"); });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.waitForFunction(() => !!window.gates["job-queue"]);
    await expect(page.getByRole("region", { name: "Document queue health" })).toHaveCount(0);
    await page.evaluate(() => window.gates["job-queue"].reject(new Error("Jobs refresh is unavailable.")));
    await expect(page.getByRole("alert")).toContainText("Jobs refresh is unavailable.");
    await expect(page.getByRole("region", { name: "Document queue health" })).toHaveCount(0);
    await expect(page.getByText("No matching records", { exact: true })).toHaveCount(0);
  } finally { await page.close(); }
});

test("moderation requires review and confirmation and recovers a lost decision by refresh", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.report = { id: "report", entity_type: "post", reason: "Spam reason", status: "open", created_at: "2026-09-01T00:00:00Z", target: { type: "post", title: "Reported post", body: "Community content only", status: "published", communityName: "Writers" } };
      window.api.adminModerationReports = async () => ({ reports: [window.report] });
      window.api.adminResolveModerationReport = async (id, action) => { window.calls.push({ id, action }); window.report = { ...window.report, status: "actioned", resolution_action: "remove" }; throw new Error("Decision reply lost. Refresh the queue before retrying."); };
      window.renderAdmin();
    });
    await page.getByRole("button", { name: "moderation", exact: true }).click();
    await expect(page.getByText("Community content only", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review removal", exact: true }).click();
    assert.equal((await page.evaluate(() => window.calls)).length, 0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal((await page.evaluate(() => window.calls)).length, 0);
    await page.getByRole("button", { name: "Review removal", exact: true }).click();
    await page.getByRole("button", { name: "Confirm removal", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Decision reply lost");
    await expect(page.getByRole("button", { name: "Confirm removal", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirm removal", exact: true })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.calls), [{ id: "report", action: "remove" }]);
  } finally { await page.close(); }
});

test("community moderation reviews comment context, paginates, and recovers a lost reply without retrying", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.communityReports = [1,2].map(number => ({ id: `report-${number}`, entity_type: "comment", entity_id: `reply-${number}`,
        reason: `Reply reason ${number}`, status: "open", target: { type: "comment", body: `Reported reply ${number}`, parentBody: "Parent context", communityName: "Writers", moderationState: "visible" } }));
      window.api.listCommunityPosts = async () => ({ posts: [],role: "moderator" });
      window.api.moderationQueue = async ({ offset }) => ({ reports: window.communityReports.slice(offset,offset+1),offset,limit:1,hasMore:offset===0 && window.communityReports.length>1 });
      window.api.moderateReport = async (id,action) => { window.calls.push({ id,action }); window.communityReports = window.communityReports.filter(row => row.id!==id); throw new Error("Decision reply lost. Refresh reports."); };
      window.renderCommunity("writers");
    });
    await page.getByRole("button", { name:"Moderation Queue", exact:true }).click();
    await expect(page.getByText("Reported reply 1", { exact:true })).toBeVisible();
    await page.getByRole("button", { name:"Load more reports", exact:true }).click();
    await expect(page.getByText("Reported reply 2", { exact:true })).toBeVisible();
    await page.getByRole("button", { name:"Remove",exact:true }).first().click();
    assert.equal((await page.evaluate(() => window.calls)).length,0);
    await page.getByRole("button", { name:"Cancel",exact:true }).click();
    assert.equal((await page.evaluate(() => window.calls)).length,0);
    await page.getByRole("button", { name:"Remove",exact:true }).first().click();
    await page.getByRole("button", { name:"Confirm removal",exact:true }).click();
    await expect(page.getByRole("alert")).toContainText("Decision reply lost");
    await expect(page.getByRole("button", { name:"Confirm removal",exact:true })).toHaveCount(0);
    await page.getByRole("button", { name:"Refresh reports",exact:true }).click();
    await expect(page.getByText("Reported reply 1", { exact:true })).toHaveCount(0);
    await expect(page.getByText("Reported reply 2", { exact:true })).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.calls),[{ id:"report-1",action:"remove" }]);
  } finally { await page.close(); }
});

test("workspace execution ledger shows all queues and safe exact workflow links at desktop and 320px", async () => {
  const page = await fixture({ styled: true });
  try {
    const scope = await page.evaluate(() => {
      const id = n => `${String(n).padStart(8,"0")}-1111-4111-8111-111111111111`;
      const workspace = id(1), book = id(2), jobs = [
        [3,"import","Manuscript import","failed","editor"], [4,"ai","AI writing","failed","editor"],
        [5,"ai","Story Blueprint proposal","queued","plan"], [6,"ai","Book Bible extraction","running","memory"],
        [7,"ai","Translation","queued","translate"], [8,"ai","Book cover","running","assets"],
        [9,"publishing","Channel preflight","succeeded","publish"], [10,"audiobook_export","Google Play audiobook package","failed","publish"],
      ].map(([n,kind,label,status,destination]) => ({id:id(n),kind,label,status,destination,bookId:book,bookTitle:"Harbor Notebook",createdAt:"2026-10-24T00:00:00Z",completedAt:null}));
      window.api.listWorkspaces = async () => ({workspaces:[{id:workspace,name:"Harbor Studio"}]});
      window.api.getDashboardOverview = async () => ({...window.overview(workspace),books:[{...window.overview(workspace).books[0],id:book,title:"Harbor Notebook"}],
        recentJobs:jobs, pipeline:[{kind:"import",label:"Manuscript imports",pending:1,failed:1},{kind:"ai",label:"AI generation",pending:3,failed:1},
          {kind:"publishing",label:"Publishing",pending:0,failed:0},{kind:"audiobook_export",label:"Audiobook exports",pending:0,failed:1}],
        summary:{...window.overview(workspace).summary,pendingJobs:4,failedJobs:3}});
      window.renderDashboard();return {workspace,book,writer:id(4)};
    });
    await expect(page.getByRole("heading",{name:"Harbor Notebook",exact:true})).toBeVisible();
    const queues=page.getByRole("definition");assert.equal(await queues.count(),4);
    for(const name of ["Manuscript imports","AI generation","Publishing","Audiobook exports"]) await expect(page.getByRole("term").filter({hasText:name})).toBeVisible();
    const writer=page.getByRole("link",{name:"Open AI writing workflow for Harbor Notebook",exact:true});
    await expect(writer).toHaveAttribute("href",`/books/${scope.book}?aiJob=${scope.writer}`);
    for(const [label,path] of [["Manuscript import",`/books/${scope.book}`],["Story Blueprint proposal",`/books/${scope.book}/plan`],
      ["Book Bible extraction",`/books/${scope.book}/memory`],["Translation",`/books/${scope.book}/translate`],
      ["Book cover",`/assets?ws=${scope.workspace}`],["Channel preflight",`/books/${scope.book}/publish`],["Google Play audiobook package",`/books/${scope.book}/publish`]]) {
      await expect(page.getByRole("link",{name:`Open ${label} workflow for Harbor Notebook`,exact:true})).toHaveAttribute("href",path);
    }
    await expect(page.getByText(/Historical package jobs are not current-file checks, retailer approval, or sales/)).toBeVisible();
    await expect(page.getByText(/Totals include older queued, running, and failed jobs/)).toBeVisible();
    await page.screenshot({path:resolve(artifacts,"pipeline-desktop.png"),fullPage:true});
    await page.setViewportSize({width:320,height:844});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await writer.focus();await expect(writer).toBeFocused();assert((await writer.boundingBox()).height>=44);
    assert(await writer.evaluate(element=>getComputedStyle(element).boxShadow!=="none"));
    await page.screenshot({path:resolve(artifacts,"pipeline-mobile-320.png"),fullPage:true});
    assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  } finally { await page.close(); }
});

test("foreign or malformed job pointers never become dashboard navigation", async () => {
  const page=await fixture();
  try {
    await page.evaluate(()=>{window.api.getDashboardOverview=async id=>({...window.overview(id),recentJobs:[{...window.overview(id).recentJobs[0],
      id:"11111111-1111-4111-8111-111111111111",bookId:"22222222-2222-4222-8222-222222222222",destination:"editor"}]});window.renderDashboard();});
    await expect(page.getByRole("heading",{name:"A book",exact:true})).toBeVisible();
    await expect(page.getByText("a private job",{exact:true})).toBeVisible();
    await expect(page.getByRole("link",{name:/Open a private job workflow/})).toHaveCount(0);
    assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  } finally {await page.close();}
});

test("a late moderation queue cannot repopulate a different community page", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.api.listCommunityPosts = async () => ({ posts:[],role:"moderator" });
      window.api.moderationQueue = () => window.defer("old-community-queue"); window.renderCommunity("old");
    });
    await page.getByRole("button", { name:"Moderation Queue",exact:true }).click();
    await page.waitForFunction(() => !!window.gates["old-community-queue"]);
    await page.evaluate(() => window.renderCommunity("new"));
    await expect(page.getByRole("button", { name:"Moderation Queue",exact:true })).toBeEnabled();
    await page.evaluate(() => window.gates["old-community-queue"].resolve({ reports:[{ id:"old-report",entity_type:"comment",reason:"Old community report",target:null }],offset:0,limit:50,hasMore:false }));
    await expect(page.getByText("Old community report", { exact:true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name:"Open Reports",exact:true })).toHaveCount(0);
  } finally { await page.close(); }
});
