// Real React components, isolated browser fixtures; no real login, provider,
// payment, credential storage, or application data mutation.
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const bundle = await build({
  stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client";
    import Dashboard from "./apps/web/components/AuthorDashboard.tsx";
    import {AccountMenu} from "./apps/web/components/AccountMenu.tsx";
    import {ApiClientError} from "@bookworm/api-client";
    window.denied = () => new ApiClientError(403, "forbidden", "Not an administrator", "fixture");
    const root=createRoot(document.getElementById("root"));
    window.mount = (mode="dashboard", strict=false) => {const component=React.createElement(mode==="account" ? AccountMenu : Dashboard);root.render(strict ? React.createElement(React.StrictMode,null,component) : component);};
    window.unmount=()=>root.render(null);`, resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  plugins: [{ name: "session-fixtures", setup(builder) {
    builder.onResolve({ filter: /(?:\/|^)(api|AuthorShell)$/ }, args => args.importer.replaceAll("\\", "/").startsWith(resolve("apps/web").replaceAll("\\", "/"))
      ? { path: args.path.endsWith("AuthorShell") ? "shell" : "api", namespace: "fixture" } : undefined);
    builder.onLoad({ filter: /^api$/, namespace: "fixture" }, () => ({ contents: "export const apiClient=()=>window.api;" }));
    builder.onLoad({ filter: /^shell$/, namespace: "fixture" }, () => ({ contents: "export function AuthorHeader(){return null;}" }));
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
    builder.onLoad({ filter: /^link$/, namespace: "fixture" }, () => ({ contents: 'import React from "react";export default function Link(p){return React.createElement("a",p);}', resolveDir: process.cwd() }));
  } }],
});
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
test.after(() => browser.close());
async function fixture(mode = "dashboard", strict = false, empty = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><body><div id="root"></div></body></html>' }));
  await page.goto("http://127.0.0.1/bookworm-session-fixture");
  await page.evaluate(({ A, B, empty }) => {
    window.ids = { A, B }; window.actor = A; window.sessionStatus = 200;
    window.gates = {}; window.calls = []; window.reads = [];
    window.defer = key => new Promise((resolve, reject) => { window.gates[key] = { resolve, reject }; });
    window.session = () => Response.json({ user: { id: window.actor, email: window.actor === A ? "private-a@example.test" : "private-b@example.test" } }, { status: window.sessionStatus });
    window.fetch = async (url, init) => { window.reads.push({ url, actor: window.actor }); if (url === "/api/auth/logout") { window.calls.push({ url, headers: Object.fromEntries(new Headers(init.headers)) }); window.sessionStatus = 401; return Response.json({ ok: true }); } return window.session(); };
    window.overview = actor => ({ viewerId: actor, workspace: { id: A, name: "Shared studio", role: "owner" },
      books: [{ id: B, workspace_id: A, title: actor === A ? "A private manuscript" : "B private manuscript", author_name: "Synthetic author", language: "en", status: "draft" }],
      summary: { activeBooks: 1, inProductionBooks: 1, publishedBooks: 0, assets: 0, visualAssets: 0, pendingJobs: 0, failedJobs: 0, readyPackages: 0 },
      usage: { usage: {}, entitlements: { plan: { name: actor === A ? "A-private-plan" : "B-private-plan" }, entitlements: {} }, creditBalance: actor === A ? 1717 : 2828 },
      pipeline: [], recentJobs: [], activity: [], sales: { status: "not_connected", message: "No saved reports" } });
    window.api = {
      listWorkspaces: async expected => { window.reads.push({ method: "list", expected }); return { workspaces: empty ? [] : [{ id: A, name: "Shared studio" }] }; },
      getDashboardOverview: async (_workspace, expected) => { window.reads.push({ method: "overview", expected }); return window.overview(expected); },
      adminAccess: async expected => { window.reads.push({ method: "admin", expected }); if (expected !== A) throw window.denied(); return { admin: true, viewerId: expected }; },
      createWorkspace: async (body, expected) => { window.calls.push({ method: "create", body, expected }); return { id: A }; },
    };
  }, { A, B, empty });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(({ mode, strict }) => window.mount(mode, strict), { mode, strict });
  return page;
}
const heading = (page, actor) => page.getByRole("heading", { name: `${actor} private manuscript`, exact: true });
const focus = page => page.evaluate(() => window.dispatchEvent(new Event("focus")));

test("StrictMode drops its cancelled identity read before dispatching workspace requests", async () => {
  const page = await fixture("dashboard", true);
  try {
    await expect(heading(page, "A")).toBeVisible();
    assert.equal(await page.evaluate(() => window.reads.filter(read => read.method === "list").length), 1);
  } finally { await page.close(); }
});

for (const event of ["focus", "visibilitychange"]) test(`${event} revalidates identity in the same authorized workspace without retaining the previous ledger`, async () => {
  const page = await fixture();
  try {
    await expect(heading(page, "A")).toBeVisible();
    await page.evaluate(event => {
      window.actor = window.ids.B;
      window.api.getDashboardOverview = (_id, expected) => { window.expected = expected; return window.defer("new-overview"); };
      (event === "focus" ? window : document).dispatchEvent(new Event(event));
    }, event);
    await page.waitForFunction(() => !!window.gates["new-overview"]);
    await expect(heading(page, "A")).toHaveCount(0); await expect(page.getByText("1,717", { exact: true })).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.expected), B);
    await page.evaluate(() => window.gates["new-overview"].resolve(window.overview(window.ids.B)));
    await expect(heading(page, "B")).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => /private|1717|2828/.test(value))), false);
  } finally { await page.close(); }
});

for (const outcome of ["success", "failure"]) test(`an old account's delayed overview ${outcome} cannot replace the new account`, async () => {
  const page = await fixture();
  try {
    await expect(heading(page, "A")).toBeVisible();
    await page.evaluate(() => { window.api.getDashboardOverview = (_id, actor) => actor === window.ids.A ? window.defer("old") : Promise.resolve(window.overview(actor)); window.dispatchEvent(new Event("focus")); });
    await page.waitForFunction(() => !!window.gates.old);
    await page.evaluate(() => { window.actor = window.ids.B; window.dispatchEvent(new Event("focus")); });
    await expect(heading(page, "B")).toBeVisible();
    await page.evaluate(outcome => outcome === "success" ? window.gates.old.resolve(window.overview(window.ids.A)) : window.gates.old.reject(new Error("Old private error")), outcome);
    await expect(heading(page, "B")).toBeVisible(); await expect(heading(page, "A")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally { await page.close(); }
});

for (const status of [401, 403, 503]) test(`revoked/unavailable session ${status} removes dashboard data before any further scoped read`, async () => {
  const page = await fixture();
  try {
    await expect(heading(page, "A")).toBeVisible();
    const before = await page.evaluate(() => window.reads.filter(read => read.method).length);
    await page.evaluate(status => { window.sessionStatus = status; window.dispatchEvent(new Event("focus")); }, status);
    await expect(page.getByRole("alert")).toContainText("session could not be verified");
    await expect(heading(page, "A")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Publishing operations", exact: true })).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.reads.filter(read => read.method).length), before);
    await page.evaluate(() => { window.sessionStatus = 200; window.actor = window.ids.B; });
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(heading(page, "B")).toBeVisible();
  } finally { await page.close(); }
});

test("a response with another viewer and an account change during a read both fail closed", async () => {
  const page = await fixture();
  try {
    await expect(heading(page, "A")).toBeVisible();
    await page.evaluate(() => { window.api.getDashboardOverview = async () => window.overview(window.ids.B); window.dispatchEvent(new Event("focus")); });
    await expect(page.getByRole("alert")).toContainText("requested account and workspace");
    await expect(heading(page, "B")).toHaveCount(0);
    await page.evaluate(() => { window.api.getDashboardOverview = async (_id, expected) => { window.actor = window.ids.B; return window.overview(expected); }; window.dispatchEvent(new Event("focus")); });
    await expect(page.getByRole("alert")).toContainText("account changed");
    await expect(heading(page, "A")).toHaveCount(0);
  } finally { await page.close(); }
});

test("workspace form keeps its same-account draft, resets it for another account, and ignores a late create confirmation", async () => {
  const page = await fixture("dashboard", false, true);
  try {
    await page.getByLabel("Workspace name", { exact: true }).fill("Unsaved studio name");
    await focus(page); await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue("Unsaved studio name");
    await page.evaluate(() => { window.api.createWorkspace = (body, expected) => { window.calls.push({ body, expected }); return window.defer("create"); }; });
    // Duplicate synchronous submissions must not get distinct idempotency keys.
    await page.locator("form").evaluate(form => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await page.waitForFunction(() => !!window.gates.create);
    assert.deepEqual(await page.evaluate(() => window.calls), [{ body: { name: "Unsaved studio name" }, expected: A }]);
    await page.evaluate(() => { window.actor = window.ids.B; window.dispatchEvent(new Event("focus")); });
    await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue("My publishing studio");
    await page.evaluate(() => window.gates.create.resolve({ id: "33333333-3333-4333-8333-333333333333" }));
    await expect(page.getByRole("button", { name: "Create workspace", exact: true })).toBeEnabled();
    assert.equal(await page.evaluate(() => new URL(location.href).searchParams.has("ws")), false);
    assert.equal(await page.evaluate(() => window.calls.length), 1);
  } finally { await page.close(); }
});

test("workspace creation is refused if the account changed before dispatch", async () => {
  const page = await fixture("dashboard", false, true);
  try {
    await expect(page.getByRole("button", { name: "Create workspace", exact: true })).toBeVisible();
    await page.evaluate(() => { window.actor = window.ids.B; });
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("account changed");
    assert.deepEqual(await page.evaluate(() => window.calls), []);
  } finally { await page.close(); }
});

test("a same-account focus read that raced creation rechecks the library before another create is possible", async () => {
  const page = await fixture("dashboard", false, true);
  try {
    await expect(page.getByRole("button", { name: "Create workspace", exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.created = false;
      window.api.listWorkspaces = async () => ({ workspaces: window.created ? [{ id: window.ids.A, name: "Created studio" }] : [] });
      window.api.createWorkspace = (body, expected) => { window.calls.push({ body, expected }); return window.defer("create"); };
    });
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await page.waitForFunction(() => !!window.gates.create);
    await focus(page);
    await expect(page.getByRole("button", { name: "Creating…", exact: true })).toBeDisabled();
    await page.evaluate(() => { window.created = true; window.gates.create.resolve({ id: window.ids.A }); });
    await expect(heading(page, "A")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create workspace", exact: true })).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.calls.length), 1);
  } finally { await page.close(); }
});

for (const outcome of ["success", "failure"]) test(`account menu drops old email, administrator link and late role ${outcome}`, async () => {
  const page = await fixture("account");
  try {
    await expect(page.getByRole("link", { name: "Admin", exact: true })).toBeVisible();
    await page.evaluate(() => { window.api.adminAccess = expected => expected === window.ids.A ? window.defer("admin-a") : Promise.reject(window.denied()); window.dispatchEvent(new Event("focus")); });
    await page.waitForFunction(() => !!window.gates["admin-a"]);
    await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
    await expect(page.locator('a[title="private-a@example.test"]')).toHaveCount(0);
    await page.evaluate(() => { window.actor = window.ids.B; window.dispatchEvent(new Event("focus")); });
    await expect(page.locator('a[title="private-b@example.test"]')).toBeVisible();
    await page.evaluate(outcome => outcome === "success" ? window.gates["admin-a"].resolve({ admin: true, viewerId: window.ids.A }) : window.gates["admin-a"].reject(new Error("Old role error")), outcome);
    await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
    await expect(page.locator('a[title="private-a@example.test"]')).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally { await page.close(); }
});

test("unverifiable account disables logout and supports explicit revalidation", async () => {
  const page = await fixture("account");
  try {
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
    await page.evaluate(() => { window.sessionStatus = 503; window.dispatchEvent(new Event("focus")); });
    await expect(page.getByRole("alert")).toContainText("session could not be verified");
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
    await page.evaluate(() => { window.actor = window.ids.B; window.sessionStatus = 200; });
    await page.getByRole("button", { name: "Recheck account", exact: true }).click();
    await expect(page.locator('a[title="private-b@example.test"]')).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.calls), []);
  } finally { await page.close(); }
});

test("an old logout cannot redirect a newly verified account or clear its preference", async () => {
  const page = await fixture("account");
  try {
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
    await page.evaluate(() => { const fetch = window.fetch; window.fetch = (url, init) => { if (url === "/api/auth/logout") { window.calls.push({ url, actor: new Headers(init.headers).get("x-bookworm-actor") }); return window.defer("logout"); } return fetch(url, init); }; localStorage.setItem("bookworm:workspaceId", window.ids.B); });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForFunction(() => !!window.gates.logout);
    await page.evaluate(() => { window.actor = window.ids.B; window.dispatchEvent(new Event("focus")); });
    await expect(page.locator('a[title="private-b@example.test"]')).toBeVisible();
    await page.evaluate(() => window.gates.logout.resolve(Response.json({ ok: true })));
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
    assert.equal(new URL(page.url()).pathname, "/bookworm-session-fixture");
    assert.equal(await page.evaluate(() => localStorage.getItem("bookworm:workspaceId")), B);
    assert.deepEqual(await page.evaluate(() => window.calls), [{ url: "/api/auth/logout", actor: A }]);
  } finally { await page.close(); }
});

for (const mode of ["dashboard", "account"]) test(`${mode} cleanup removes listeners and ignores unmounted identity reads`, async () => {
  const page = await fixture(mode);
  try {
    await expect(mode === "dashboard" ? heading(page, "A") : page.getByRole("link", { name: "Admin", exact: true })).toBeVisible();
    await page.evaluate(() => { window.fetch = () => window.defer("identity"); window.dispatchEvent(new Event("focus")); });
    await page.waitForFunction(() => !!window.gates.identity);
    await page.evaluate(() => window.unmount());
    await expect(page.locator("#root")).toBeEmpty();
    const reads = await page.evaluate(() => window.reads.length);
    await focus(page);
    await page.evaluate(() => window.gates.identity.resolve(window.session()));
    await expect(page.locator("#root")).toBeEmpty();
    assert.equal(await page.evaluate(() => window.reads.length), reads);
  } finally { await page.close(); }
});
