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
    const root = createRoot(document.getElementById("root"));
    window.renderAnalytics = query => { window.query = query || ""; root.render(React.createElement(Analytics, { query })); };
    window.renderAdmin = () => root.render(React.createElement(Admin));
    window.renderCommunity = id => { window.communityId = id; root.render(React.createElement(Community)); };
    window.renderDashboard = strict => root.render(strict ? React.createElement(React.StrictMode, null, React.createElement(Dashboard)) : React.createElement(Dashboard));
    window.clearComponent = () => root.render(null);`, resolveDir: process.cwd(), loader: "tsx" },
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
    window.defer = name => new Promise((resolve, reject) => { window.gates[name] = { resolve, reject }; });
    window.sales = id => ({ imports: [{ id: id + "-receipt", file_name: id + " receipt.csv", row_count: 1, source: "amazon_kdp", period_start: "2026-09-01", period_end: "2026-09-30", created_at: "2026-10-01T00:00:00Z" }],
      summary: { available: true, status: "imported", imports: 1, units: 2, royaltyCents: id === "b" ? 123 : 456, reportedProceedsCents: null, currency: "USD", currencies: [] },
      analytics: { available: true, windowStart: "2026-09-01", windowEnd: "2026-10-01", monthCount: 1, monthly: [{ month: "2026-09-01", currency: "USD", units: 2, royaltyCents: 123, reportedProceedsCents: null }], books: [], sources: [], bookCount: 0, booksTruncated: false } });
    window.overview = (id, suffix = "") => ({ workspace: { id, name: `Workspace ${id.toUpperCase()}`, organizationId: `${id}-organization`, role: "writer" },
      books: [{ id: `${id}-book`, workspace_id: id, title: id.toUpperCase() + " book" + suffix, status: "draft", language: "en", author_name: "Fixture author", genre: null }],
      summary: { activeBooks: 1, inProductionBooks: 1, publishedBooks: 0, assets: 7, visualAssets: 3, pendingJobs: 1, failedJobs: 0, readyPackages: 2 },
      usage: { entitlements: { plan: { name: `${id}-private-plan` }, entitlements: { ai_credits_monthly: 500 } }, usage: { ai_credits: 37 }, creditBalance: id === "a" ? 1717 : 2828 },
      sales: { ...window.sales(id).summary, message: `${id} private retailer report` },
      recentJobs: [{ id: `${id}-job`, kind: "ai", label: `${id} private job`, status: "running", bookId: `${id}-book`, bookTitle: `${id} private job source`, createdAt: "2026-10-01T00:00:00Z" }],
      activity: [{ id: `${id}-activity`, event_type: `${id}_private_activity`, created_at: "2026-10-01T00:00:00Z", payload_json: {} }] });
    window.api = { listWorkspaces: async () => ({ workspaces: [{ id: "a", name: "Workspace A" }, { id: "b", name: "Workspace B" }] }),
      getDashboardOverview: async id => window.overview(id),
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

for (const outcome of ["success", "failure"]) test(`dashboard ignores an older StrictMode workspace-list ${outcome}`, async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      let count = 0;
      window.api.listWorkspaces = () => ++count === 1 ? window.defer("older-list") : Promise.resolve({ workspaces: [{ id: "b", name: "Workspace B" }] });
      window.api.getDashboardOverview = async id => { window.reads.push(id); return window.overview(id); };
      window.renderDashboard(true);
    });
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
    await page.evaluate(() => { Storage.prototype.getItem = () => { throw new Error("Storage blocked"); }; Storage.prototype.setItem = () => { throw new Error("Storage blocked"); }; window.renderDashboard(); });
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
      window.api.createWorkspace = body => { window.calls.push({ operation: "create-workspace", body }); return window.defer("create"); };
      window.renderDashboard();
    });
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await page.waitForFunction(() => !!window.gates.create);
    await page.evaluate(() => window.clearComponent());
    await expect(page.locator("#root > *")).toHaveCount(0);
    await page.evaluate(async () => { window.gates.create.resolve({ id: "new-workspace", name: "Created studio" }); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual(await page.evaluate(() => window.reads), ["list"]);
    assert.equal(await page.evaluate(() => localStorage.getItem("bookworm:workspaceId")), null);
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
    await expect(page.getByRole("alert")).toContainText("Dashboard response does not match the requested workspace");
    await expect(page.getByRole("region", { name: "Publishing operations", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /[AB] book/ })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.calls), []);
  } finally { await page.close(); }
});

test("workspace creation and its dashboard confirmation do not require preference storage", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Storage.prototype.getItem = () => { throw new Error("Storage blocked"); };
      Storage.prototype.setItem = () => { throw new Error("Storage blocked"); };
      window.created = false;
      window.api.listWorkspaces = async () => ({ workspaces: window.created ? [{ id: "c", name: "New studio" }] : [] });
      window.api.createWorkspace = async body => { window.calls.push({ operation: "create-workspace", body }); window.created = true; return { id: "c", name: "New studio" }; };
      window.renderDashboard();
    });
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: "C book", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.calls), [{ operation: "create-workspace", body: { name: "My publishing studio" } }]);
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
    await page.getByRole("button", { name: "Try again", exact: true }).focus();
    await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
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
