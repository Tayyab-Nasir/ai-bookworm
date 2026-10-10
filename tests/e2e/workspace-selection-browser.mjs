// Real Next/auth UI with synthetic multi-workspace responses. No provider spend.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { join } from "node:path";

const origin = "http://127.0.0.1:4398";
assert.equal((await fetch("http://127.0.0.1:4399/health").then(response => response.json())).fixture, true);
const a = "33333333-3333-4333-8333-333333333333";
const b = "44444444-4444-4444-8444-444444444444";
const foreign = "99999999-9999-4999-8999-999999999999";
const spaces = [{ id: a, name: "Workspace A", organization_id: "13333333-3333-4333-8333-333333333333" },
  { id: b, name: "Workspace B", organization_id: "14444444-4444-4444-8444-444444444444" }];
const assets = Object.fromEntries(spaces.map((space, index) => [space.id, {
  id: `${index + 5}5555555-5555-4555-8555-555555555555`, workspace_id: space.id,
  name: `${index ? "B" : "A"} private artwork.png`, mime_type: "image/png", size_bytes: 68,
  checksum: (index ? "b" : "a").repeat(64), type: "illustration", status: "approved", folder_id: null,
}]));
const usage = { entitlements: { plan: { id: null, name: "No paid plan" }, subscription: null, entitlements: {} }, usage: {}, creditBalance: 0 };
const sales = { status: "not_connected", imports: 0, latestImportedAt: null, units: null, reportedProceedsCents: null,
  royaltyCents: null, currency: null, currencies: [], available: true, message: "Synthetic report data is not connected." };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "chrome" });
const contexts = [];

async function installFixture(page) {
  const reads = [], unexpected = [], errors = [];
  const state = { holdLibraryA: false, holdDetailsA: false, library: [], details: [], availableWorkspaces: spaces, memberRole: "viewer" };
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/workspace-preview/*", route => route.fulfill({ contentType: "image/png", body: png }));
  await page.route("**/api/backend/v1/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const id = url.searchParams.get("workspaceId");
    reads.push({ path: url.pathname, workspaceId: id, organizationId: url.searchParams.get("organizationId"), method: request.method() });
    if (request.method() !== "GET") { unexpected.push(url.pathname); return route.fulfill({ status: 405, json: {} }); }
    if (id !== null) assert(state.availableWorkspaces.some(space => space.id === id), "An unavailable workspace reached a scoped transport");
    if (url.pathname.endsWith("/admin/access")) return route.fulfill({ json: { admin: false } });
    if (url.pathname.endsWith("/workspaces")) return route.fulfill({ json: { workspaces: state.availableWorkspaces } });
    if (url.pathname.endsWith("/plans")) return route.fulfill({ json: { plans: [] } });
    const memberSpace = state.availableWorkspaces.find(space => url.pathname === `/api/backend/v1/workspaces/${space.id}/members`);
    if (memberSpace) return route.fulfill({ json: { members: [{ id: memberSpace.id, workspace_id: memberSpace.id,
      user_id: "11111111-1111-4111-8111-111111111111", role: state.memberRole, status: "active" }], profiles: [] } });
    if (url.pathname.endsWith("/tasks")) return route.fulfill({ json: { tasks: [] } });
    if (url.pathname.endsWith("/activity")) return route.fulfill({ json: { events: [] } });
    if (url.pathname.endsWith("/approvals")) return route.fulfill({ json: { approvals: [] } });
    if (url.pathname.endsWith("/sales/imports")) {
      assert(spaces.some(space => space.id === id));
      return route.fulfill({ json: { imports: [], summary: sales, analytics: { windowStart: null, windowEnd: null,
        monthCount: 0, monthly: [], books: [], bookCount: 0, booksTruncated: false, sources: [], available: true, message: sales.message } } });
    }
    if (url.pathname.endsWith("/dashboard")) {
      assert(spaces.some(space => space.id === id));
      return route.fulfill({ json: { workspace: { ...spaces.find(space => space.id === id), organizationId: spaces.find(space => space.id === id).organization_id, role: "owner" }, books: [],
        summary: { activeBooks: 0, inProductionBooks: 0, publishedBooks: 0, assets: 1, visualAssets: 1, pendingJobs: 0, failedJobs: 0, readyPackages: 0 },
        usage, recentJobs: [], activity: [], sales } });
    }
    if (url.pathname.endsWith("/assets/access")) return route.fulfill({ json: { canEdit: true } });
    const modelSpace = state.availableWorkspaces.find(space => url.pathname === `/api/backend/v1/workspaces/${space.id}/image-models`);
    if (modelSpace) return route.fulfill({ json: { catalogVersion: "fixture-disabled", pricingBasis: "maximum_token_budget", purchaseAvailable: false, models: [] } });
    if (url.pathname.endsWith("/assets/generation-jobs")) return route.fulfill({ json: { jobs: [] } });
    if (url.pathname.endsWith("/folders")) return route.fulfill({ json: { folders: [] } });
    if (url.pathname.endsWith("/books")) return route.fulfill({ json: { books: [] } });
    if (url.pathname.endsWith("/assets")) {
      assert(assets[id], "A foreign workspace reached the library transport");
      if (id === a && state.holdLibraryA) { state.library.push(route); return; }
      return route.fulfill({ json: { assets: [assets[id]] } });
    }
    const asset = Object.values(assets).find(value => url.pathname.includes(`/${value.id}/`));
    if (asset && url.pathname.endsWith("/versions")) {
      if (asset.workspace_id === a && state.holdDetailsA) { state.details.push(route); return; }
      return route.fulfill({ json: { versions: [{ id: `${asset.id}-version`, version_number: 1, checksum: asset.checksum,
        scan_status: "clean", created_at: "2026-01-01T00:00:00Z" }] } });
    }
    if (asset && url.pathname.endsWith("/usage")) return route.fulfill({ json: { links: [] } });
    if (asset && url.pathname.endsWith("/download-url")) return route.fulfill({ json: { url: `${origin}/workspace-preview/${asset.id}.png`, expiresIn: 60 } });
    if (url.pathname.endsWith("/usage")) {
      assert(spaces.some(space => space.organization_id === url.searchParams.get("organizationId")));
      return route.fulfill({ json: usage });
    }
    unexpected.push(url.pathname);
    return route.fulfill({ status: 501, json: { error: { message: "Unexpected synthetic request" } } });
  });
  return { reads, unexpected, errors, state };
}

async function signIn(page, path, remembered) {
  await page.goto(`${origin}${path}`);
  await page.getByLabel("Email").waitFor();
  if (remembered) await page.evaluate(id => localStorage.setItem("bookworm:workspaceId", id), remembered);
  await page.getByLabel("Email").fill("author@example.test");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: /sign in/i }).click();
}
async function showLibrary(page, id) {
  // A wrapping label includes option text; use the browser's accessible name.
  await expect(page.getByRole("combobox", { name: "Workspace", exact: true })).toHaveValue(id);
  await expect(page.getByRole("button", { name: new RegExp(assets[id].name.replaceAll(".", "\\.")) })).toBeVisible();
  await expect(page.getByRole("region", { name: "Illustrations and cover art", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Upload asset", exact: true })).toBeEnabled();
}
async function renderSettled(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function screenshot(page, name) {
  const directory = process.env.BROWSER_TEST_ARTIFACT_DIR;
  if (directory) await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true, animations: "disabled" });
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.push(context);
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const fixture = await installFixture(page);
  await signIn(page, "/dashboard", b);
  await expect(page.getByRole("combobox", { name: "Workspace", exact: true })).toHaveValue(b);
  await screenshot(page, "desktop-dashboard");
  await page.getByRole("link", { name: "Manage assets", exact: true }).click();
  await showLibrary(page, b);
  await screenshot(page, "desktop-assets");
  assert(fixture.reads.filter(read => read.path.endsWith("/assets")).every(read => read.workspaceId === b));
  await page.goto(`${origin}/assets`); await showLibrary(page, b);
  await page.reload(); await showLibrary(page, b);

  await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(a); await showLibrary(page, a);
  await page.goto(`${origin}/dashboard`);
  await expect(page.getByRole("combobox", { name: "Workspace", exact: true })).toHaveValue(a);
  await page.getByRole("link", { name: "Manage assets", exact: true }).click(); await showLibrary(page, a);
  await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(b); await showLibrary(page, b);

  fixture.state.holdLibraryA = true;
  await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(a);
  await expect.poll(() => fixture.state.library.length).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Upload asset", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(b); await showLibrary(page, b);
  fixture.state.holdLibraryA = false;
  const staleLibrary = page.waitForResponse(response => response.url().includes("/assets?") && new URL(response.url()).searchParams.get("workspaceId") === a);
  await Promise.all(fixture.state.library.splice(0).map(route => route.fulfill({ json: { assets: [assets[a]] } }))); await staleLibrary; await renderSettled(page);
  await showLibrary(page, b);
  await expect(page.getByRole("button", { name: new RegExp(assets[a].name.replaceAll(".", "\\.")) })).toHaveCount(0);

  await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(a); await showLibrary(page, a);
  fixture.state.holdDetailsA = true;
  await page.getByRole("button", { name: new RegExp(assets[a].name.replaceAll(".", "\\.")) }).click();
  await expect.poll(() => fixture.state.details.length).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(b); await showLibrary(page, b);
  await page.getByRole("button", { name: new RegExp(assets[b].name.replaceAll(".", "\\.")) }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const staleDetail = page.waitForResponse(response => response.url().includes(`/${assets[a].id}/versions`));
  await Promise.all(fixture.state.details.splice(0).map(route => route.fulfill({ json: { versions: [{ id: "stale-a-version", version_number: 2,
    checksum: "c".repeat(64), scan_status: "clean", created_at: "2026-01-01T00:00:00Z" }] } }))); await staleDetail; await renderSettled(page);
  await expect(page.getByRole("dialog").getByRole("heading", { name: assets[b].name, exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/cccccccccccc/)).toHaveCount(0);
  await screenshot(page, "desktop-asset-details");
  await page.keyboard.press("Escape");

  const beforeForeign = fixture.reads.length;
  await page.goto(`${origin}/assets?ws=${foreign}`);
  await expect(page.getByRole("alert").first()).toBeVisible();
  await renderSettled(page);
  assert(!fixture.reads.slice(beforeForeign).some(read => read.workspaceId !== null), "Invalid explicit selection silently fetched another workspace");

  const blocked = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(blocked);
  await blocked.addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) { if (key === "bookworm:workspaceId") throw new DOMException("Fixture storage blocked", "SecurityError"); return get.call(this, key); };
    Storage.prototype.setItem = function (key, value) { if (key === "bookworm:workspaceId") throw new DOMException("Fixture storage blocked", "SecurityError"); return set.call(this, key, value); };
  });
  const blockedPage = await blocked.newPage(); blockedPage.setDefaultTimeout(20000);
  const blockedFixture = await installFixture(blockedPage);
  await signIn(blockedPage, `/assets?ws=${b}`); await showLibrary(blockedPage, b);
  await blockedPage.reload(); await showLibrary(blockedPage, b);
  await blockedPage.getByRole("button", { name: "Open author navigation", exact: true }).click();
  await blockedPage.getByRole("navigation", { name: "Author mobile navigation", exact: true }).getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(blockedPage).toHaveURL(`${origin}/dashboard?ws=${b}`);
  await expect(blockedPage.getByRole("combobox", { name: "Workspace", exact: true })).toHaveValue(b);
  for (const checkout of ["success", "cancelled"]) {
    await blockedPage.goto(`${origin}/billing?ws=${b}&checkout=${checkout}`);
    await expect(blockedPage.getByRole("combobox", { name: "Workspace", exact: true })).toHaveValue(b);
    await expect(blockedPage.getByRole("link", { name: "AI Bookworm dashboard", exact: true })).toHaveAttribute("href", `/dashboard?ws=${b}`);
  }
  for (const path of ["/dashboard", "/billing", "/tasks", "/team", "/approvals", "/books/new", "/analytics"]) {
    await blockedPage.goto(`${origin}${path}?ws=${b}`);
    if (path !== "/books/new") await expect(blockedPage.getByRole("combobox", { name: "Workspace", exact: true })).toHaveValue(b);
    const logo = blockedPage.getByRole("link", { name: "AI Bookworm dashboard", exact: true });
    await expect(logo).toHaveAttribute("href", `/dashboard?ws=${b}`);
    assert.equal(await blockedPage.locator("header").count(), 1, "Wrapper rendered a duplicate header");
    assert.equal(await logo.evaluate(element => element.closest("main") === null), true, "Header moved into the content geometry");
    if (["/tasks", "/team", "/approvals"].includes(path)) await expect(blockedPage.getByRole("heading", { name: "Recent workspace activity", exact: true })).toBeVisible();
    await renderSettled(blockedPage);
    assert.equal(await blockedPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Mobile overflow on ${path}`);
    await screenshot(blockedPage, `mobile-${path.slice(1).replaceAll("/", "-")}`);
    if (path === "/books/new" || path === "/analytics") {
      const back = blockedPage.getByRole("link", { name: path === "/books/new" ? "← Back to library" : "Back to desk", exact: true });
      await expect(back).toHaveAttribute("href", `/dashboard?ws=${b}`);
      await back.click(); await expect(blockedPage).toHaveURL(`${origin}/dashboard?ws=${b}`);
      await expect(blockedPage.getByRole("combobox", { name: "Workspace", exact: true })).toHaveValue(b);
    }
    await blockedPage.getByRole("button", { name: "Open author navigation", exact: true }).click();
    const menu = blockedPage.getByRole("navigation", { name: "Author mobile navigation", exact: true });
    await expect(menu.getByRole("link", { name: "Community", exact: true })).toHaveAttribute("href", "/community");
    await expect(menu.getByRole("link", { name: "New book", exact: true })).toHaveAttribute("href", `/books/new?ws=${b}`);
    await menu.getByRole("link", { name: "Assets", exact: true }).click(); await showLibrary(blockedPage, b);
  }
  assert(blockedFixture.reads.filter(read => read.organizationId !== null).every(read => read.organizationId === spaces[1].organization_id));
  assert.equal(await blockedPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(fixture.unexpected, []); assert.deepEqual(blockedFixture.unexpected, []);
  assert.deepEqual(fixture.errors, []); assert.deepEqual(blockedFixture.errors, []);
  const recoveryPage = await blocked.newPage(); recoveryPage.setDefaultTimeout(20000);
  const recoveryFixture = await installFixture(recoveryPage);
  recoveryFixture.state.availableWorkspaces = [spaces[0]];
  recoveryFixture.state.memberRole = "owner";
  await recoveryPage.goto(`${origin}/tasks?ws=${foreign}`);
  const recoveryAlerts = recoveryPage.getByRole("main").getByRole("alert");
  const rejectionText = "Requested workspace is no longer available. Choose another workspace.";
  await expect(recoveryAlerts).toHaveCount(1);
  await expect(recoveryAlerts).toBeVisible();
  await expect(recoveryAlerts).toHaveText(rejectionText);
  const picker = recoveryPage.getByRole("combobox", { name: "Workspace", exact: true });
  await expect(picker).toHaveValue("");
  await expect(picker.locator("option:checked")).toHaveText("Select a workspace");
  await expect(picker.locator("option:checked")).toHaveJSProperty("disabled", true);
  await expect(recoveryPage.getByRole("link", { name: "AI Bookworm dashboard", exact: true })).toHaveAttribute("href", "/dashboard");
  await renderSettled(recoveryPage);
  assert(!recoveryFixture.reads.some(read => read.workspaceId !== null || /\/workspaces\/[^/]+\/members$/.test(read.path)), "Rejected single-workspace selection must not load scoped data");
  await screenshot(recoveryPage, "mobile-task-recovery-rejected");
  await picker.selectOption(a);
  await expect(recoveryPage).toHaveURL(`${origin}/tasks?ws=${a}`);
  await expect(picker).toHaveValue(a);
  await expect(recoveryPage.getByRole("link", { name: "AI Bookworm dashboard", exact: true })).toHaveAttribute("href", `/dashboard?ws=${a}`);
  await expect(recoveryPage.getByText(/Your workspace role:\s*owner/)).toBeVisible();
  await expect(recoveryPage.getByLabel("Task title", { exact: true })).toBeVisible();
  await recoveryPage.getByLabel("Task title", { exact: true }).fill("Synthetic owner recovery check");
  await expect(recoveryPage.getByRole("button", { name: "Create task", exact: true })).toBeEnabled();
  await expect(recoveryAlerts).toHaveCount(0);
  await expect(recoveryPage.getByText(rejectionText, { exact: true })).not.toBeVisible();
  await renderSettled(recoveryPage);
  assert(recoveryFixture.reads.filter(read => read.workspaceId !== null).every(read => read.workspaceId === a));
  assert(recoveryFixture.reads.filter(read => /\/workspaces\/[^/]+\/members$/.test(read.path)).every(read => read.path.endsWith(`/${a}/members`)));
  assert.equal(await recoveryPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(recoveryFixture.unexpected, []); assert.deepEqual(recoveryFixture.errors, []);
  await screenshot(recoveryPage, "mobile-task-recovery-owner");
  console.log("PASS workspace browser: dashboard/direct/refresh selection, persisted switch, stale library/detail fencing, invalid explicit ID, blocked-storage headers on seven routes, single-workspace rejection/owner recovery, billing returns, BookSetup/Analytics Back navigation, billing organization and mobile geometry. Auth/API/data are synthetic; no native tenant or Storage acceptance claimed.");
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
