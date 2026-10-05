// Mounted UI acceptance without a Next server, listener, or external request.
// Run: node --test apps/web/tests/analytics-admin-mounted.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const bundle = await build({
  stdin: { contents: `import React from "react"; import { createRoot } from "react-dom/client";
    import Analytics from "./apps/web/app/analytics/page.tsx";
    import Admin from "./apps/web/components/AdminConsole.tsx";
    import Community from "./apps/web/app/community/[id]/page.tsx";
    const root = createRoot(document.getElementById("root"));
    window.renderAnalytics = query => { window.query = query || ""; root.render(React.createElement(Analytics, { query })); };
    window.renderAdmin = () => root.render(React.createElement(Admin));
    window.renderCommunity = id => { window.communityId = id; root.render(React.createElement(Community)); };`, resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  plugins: [{ name: "local-view-fixtures", setup(builder) {
    builder.onResolve({ filter: /(?:\/|^)(?:api|AuthorShell)$/ }, args => args.importer.replaceAll("\\", "/").startsWith(resolve("apps/web").replaceAll("\\", "/"))
      ? { path: args.path.endsWith("AuthorShell") ? "shell" : "api", namespace: "fixture" } : undefined);
    builder.onLoad({ filter: /^api$/, namespace: "fixture" }, () => ({ contents: "export const apiClient = () => window.api;" }));
    builder.onLoad({ filter: /^shell$/, namespace: "fixture" }, () => ({ contents: 'import React from "react"; export function AuthorPage({children}) { return React.createElement("div", null, children); } export function AuthorHeader() { return null; }', resolveDir: process.cwd() }));
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
    builder.onLoad({ filter: /^navigation$/, namespace: "fixture" }, () => ({ contents: 'export const useSearchParams = () => new URLSearchParams(window.query); export const useParams = () => ({ id: window.communityId });' }));
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
    builder.onLoad({ filter: /^link$/, namespace: "fixture" }, () => ({ contents: 'import React from "react"; export default function Link(props) { return React.createElement("a", props); }', resolveDir: process.cwd() }));
  } }],
});
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
test.after(() => browser.close());
async function fixture() {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://127.0.0.1/bookworm-analytics-admin-fixture");
  await page.evaluate(() => {
    window.calls = []; window.gates = {}; window.query = "";
    window.defer = name => new Promise((resolve, reject) => { window.gates[name] = { resolve, reject }; });
    window.sales = id => ({ imports: [{ id: id + "-receipt", file_name: id + " receipt.csv", row_count: 1, source: "amazon_kdp", period_start: "2026-09-01", period_end: "2026-09-30", created_at: "2026-10-01T00:00:00Z" }],
      summary: { available: true, status: "imported", imports: 1, units: 2, royaltyCents: id === "b" ? 123 : 456, reportedProceedsCents: null, currency: "USD", currencies: [] },
      analytics: { available: true, windowStart: "2026-09-01", windowEnd: "2026-10-01", monthCount: 1, monthly: [{ month: "2026-09-01", currency: "USD", units: 2, royaltyCents: 123, reportedProceedsCents: null }], books: [], sources: [], bookCount: 0, booksTruncated: false } });
    window.api = { listWorkspaces: async () => ({ workspaces: [{ id: "a", name: "Workspace A" }, { id: "b", name: "Workspace B" }] }),
      getDashboardOverview: async id => ({ books: [{ id: id + "-book", title: id.toUpperCase() + " book" }], workspace: { role: "writer" } }),
      listRetailerSalesImports: async id => window.sales(id),
      importRetailerSales: async body => { window.calls.push({ operation: "import", body }); return { rowCount: 1, duplicate: false }; },
      adminList: async () => [], adminModerationReports: async () => ({ reports: [] }) };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}

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
    await expect(page.getByText("1 retailer sales rows imported.", { exact: true })).toHaveCount(0);
    assert.equal((await page.evaluate(() => window.calls))[0].body.workspaceId, "a");
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
