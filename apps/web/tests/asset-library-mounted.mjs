// Real asset page, AssetBrowser and account menu with compiled project styles.
// All transports are synthetic and intercepted; no operator cookies or Storage calls.
// Run: node --test apps/web/tests/asset-library-mounted.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const bundle = await build({
  stdin: { contents: `import React from "react"; import { createRoot } from "react-dom/client";
    import Assets from "./apps/web/app/assets/page";
    const root = createRoot(document.getElementById("root"));
    window.renderAssets = () => root.render(React.createElement(Assets));
    window.clearAssets = () => root.render(null);`, loader: "tsx", resolveDir: process.cwd() },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  plugins: [{ name: "asset-library-fixtures", setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)(api|ImageQuoteStudio)$/ }, args => args.importer.replaceAll("\\", "/").startsWith(resolve("apps/web").replaceAll("\\", "/"))
      ? { path: args.path.endsWith("ImageQuoteStudio") ? "studio" : "api", namespace: "fixture" } : undefined);
    builder.onLoad({ filter: /^api$/, namespace: "fixture" }, () => ({ contents: "export const apiClient = () => window.api;" }));
    builder.onLoad({ filter: /^studio$/, namespace: "fixture" }, () => ({ contents: "export default function ImageQuoteStudio() { return null; }" }));
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
    builder.onLoad({ filter: /^navigation$/, namespace: "fixture" }, () => ({ contents: "export const useSearchParams = () => new URLSearchParams(window.location.search); export const usePathname = () => window.location.pathname;" }));
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
    builder.onLoad({ filter: /^link$/, namespace: "fixture" }, () => ({ resolveDir: process.cwd(), contents: 'import React from "react"; export default function Link(props) { return React.createElement("a", props); }' }));
  } }],
});
const stylePath = resolve("apps/web/styles/globals.css");
const styles = await postcss([tailwind({ base: resolve("apps/web"), optimize: false })]).process(await readFile(stylePath, "utf8"), { from: stylePath });
const instrument = (await readFile("apps/web/app/fonts/instrument-serif-italic.ttf")).toString("base64");
const artifacts = await mkdtemp(resolve(tmpdir(), "bookworm-asset-library-mounted-"));
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
test.after(async () => { await browser.close(); console.log(JSON.stringify({ assetLibraryArtifacts: artifacts })); });

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
async function fixture(width = 1280, admin = false) {
  const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(6000);
  const signedRequests = [];
  await page.context().route("**/*", route => {
    if (route.request().url().includes("/storage/v1/object/sign/")) {
      signedRequests.push(route.request().url());
      return route.fulfill({ status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="My draft.pdf"' }, body: "%PDF-1.4\nSynthetic browser download fixture.\n%%EOF" });
    }
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' });
  });
  await page.goto(`http://127.0.0.1/assets?ws=${A}`);
  await page.addStyleTag({ content: styles.css + `
    @font-face {font-family:BookwormInstrument;src:url(data:font/ttf;base64,${instrument});font-style:italic;font-weight:400;font-display:swap}
    :root {--font-inter:Arial,sans-serif;--font-instrument-serif:BookwormInstrument,serif}
    body {font-family:var(--font-inter);color:white}` });
  await page.evaluate(({ A, B, ASSET, admin }) => {
    window.calls = []; window.revision = 0; window.gates = {}; window.scanStatus = "clean";
    window.defer = name => new Promise((resolve, reject) => { window.gates[name] = { resolve, reject }; });
    window.file = workspace => ({ id: ASSET, workspace_id: workspace, folder_id: null, name: workspace === A ? (window.revision ? "My revised draft.pdf" : "My draft.pdf") : "Other studio draft.pdf",
      storage_path: `workspaces/${workspace}/assets/${ASSET}/v2/draft.pdf`, mime_type: "application/pdf", size_bytes: 2400, checksum: "a".repeat(64), type: "source_document", status: "draft", current_version_number: 2 });
    window.versionHistory = workspace => ({ versions: [{ id: "version-2", asset_id: ASSET, storage_path: window.file(workspace).storage_path,
      version_number: 2, checksum: "a".repeat(64), mime_type: "application/pdf", size_bytes: 2400, scan_status: window.scanStatus,
      detected_mime_type: "application/pdf", created_at: "2026-10-13T00:00:00Z" }] });
    window.signed = workspace => ({ url: `https://storage.example/storage/v1/object/sign/book-assets/${window.file(workspace).storage_path}?token=fixture-token`, expiresIn: 300 });
    window.selected = A;
    window.fetch = async path => {
      if (path === "/api/auth/session") return Response.json({ user: { email: "author@example.test" } });
      if (path === "/api/auth/logout") return Response.json({ signedOut: true });
      throw new Error(`Unexpected fixture fetch ${path}`);
    };
    window.api = {
      adminAccess: async () => ({ admin }), claimReferral: async () => ({ claimed: true }),
      listWorkspaces: async () => ({ workspaces: [{ id: A, name: "Author studio" }, { id: B, name: "Other studio" }] }),
      getAssetAccess: async workspace => { window.calls.push({ operation: "access", workspace }); return { canEdit: true }; },
      listFolders: async workspace => { window.calls.push({ operation: "folders", workspace }); return { folders: [] }; },
      listBooks: async workspace => { window.calls.push({ operation: "books", workspace }); return { books: [] }; },
      listAssets: async workspace => { window.calls.push({ operation: "assets", workspace }); window.selected = workspace; return { assets: [window.file(workspace)] }; },
      listImageGenerationJobs: async workspace => { window.calls.push({ operation: "images", workspace }); return { jobs: [] }; },
      listAssetVersions: async () => window.versionHistory(window.selected), getAssetUsage: async () => ({ links: [] }),
      getAssetDownloadUrl: async (asset, version) => {
        window.calls.push({ operation: "download", asset, version });
        if (window.downloadOverride) return window.downloadOverride();
        return window.signed(window.selected);
      },
    };
  }, { A, B, ASSET, admin });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.renderAssets());
  await expect(page.getByRole("button", { name: "Refresh library", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: /^My draft\.pdf/ })).toBeVisible();
  return { page, signedRequests };
}
async function openFile(page, name = /^My draft\.pdf/) {
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Loading file details" })).toHaveCount(0);
}

test("real Refresh library refetches current visible files, history and permissions", async () => {
  const { page } = await fixture();
  try {
    const before = await page.evaluate(() => window.calls.length);
    await page.evaluate(() => { window.revision = 1; });
    await page.getByRole("button", { name: "Refresh library", exact: true }).click();
    await expect(page.getByRole("button", { name: /^My revised draft\.pdf/ })).toBeVisible();
    const refreshed = await page.evaluate(index => window.calls.slice(index), before);
    for (const operation of ["assets", "folders", "books", "images", "access"]) assert(refreshed.some(call => call.operation === operation && call.workspace === A));
  } finally { await page.close(); }
});

test("real PDF details pin the original version and download only on the separate user click", async () => {
  const { page, signedRequests } = await fixture();
  try {
    await openFile(page); await page.getByRole("button", { name: "Prepare download", exact: true }).click();
    const link = page.getByRole("link", { name: "Download original file · v2", exact: true });
    await expect(link).toBeVisible();
    assert.equal(signedRequests.length, 0);
    const href = new URL(await link.getAttribute("href"));
    assert.equal(decodeURIComponent(href.pathname), `/storage/v1/object/sign/book-assets/workspaces/${A}/assets/${ASSET}/v2/draft.pdf`);
    assert.equal(href.searchParams.get("download"), "My draft.pdf");
    assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.operation === "download")), [{ operation: "download", asset: ASSET, version: 2 }]);
    const downloadPromise = page.waitForEvent("download");
    await link.click(); const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), "My draft.pdf");
    assert.equal(signedRequests.length, 1); await download.delete();
    await page.screenshot({ path: resolve(artifacts, "desktop-file-details.png"), fullPage: true });
  } finally { await page.close(); }
});

test("mounted quarantine and a foreign signed path never expose a download link", async () => {
  const { page, signedRequests } = await fixture();
  try {
    await page.evaluate(() => { window.scanStatus = "infected"; }); await openFile(page);
    await page.getByRole("button", { name: "Prepare download", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "current file version could not be verified" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.operation === "download").length), 0);
    await page.evaluate(() => { window.scanStatus = "clean"; window.downloadOverride = () => window.signed("foreign-workspace"); });
    await page.getByRole("button", { name: "Prepare download", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "does not match this file" })).toBeVisible();
    await expect(page.getByRole("link", { name: /^Download original file/ })).toHaveCount(0);
    assert.equal(signedRequests.length, 0);
  } finally { await page.close(); }
});

test("mounted lost replies stay retryable and late replies cannot cross workspace or close/reopen contexts", async () => {
  const { page } = await fixture();
  try {
    await openFile(page);
    await page.evaluate(() => { window.downloadOverride = () => { throw new Error("The link reply could not be confirmed."); }; });
    await page.getByRole("button", { name: "Prepare download", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "could not be confirmed" })).toBeVisible();
    await page.evaluate(() => { window.downloadOverride = () => window.defer("old-download"); });
    await page.getByRole("button", { name: "Prepare download", exact: true }).click();
    await page.waitForFunction(() => !!window.gates["old-download"]);
    await page.getByRole("button", { name: "Close asset details", exact: true }).click();
    await openFile(page);
    await page.evaluate(() => { window.downloadOverride = null; });
    await page.getByRole("button", { name: "Prepare download", exact: true }).click();
    await expect(page.getByRole("link", { name: "Download original file · v2", exact: true })).toBeVisible();
    const currentHref = await page.getByRole("link", { name: /^Download original file/ }).getAttribute("href");
    await page.evaluate(() => window.gates["old-download"].resolve(window.signed("wrong-workspace")));
    await expect(page.getByRole("link", { name: /^Download original file/ })).toHaveAttribute("href", currentHref);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "Close asset details", exact: true }).click();
    await openFile(page);
    await page.evaluate(() => { window.downloadOverride = () => window.defer("workspace-download"); });
    await page.getByRole("button", { name: "Prepare download", exact: true }).click();
    await page.waitForFunction(() => !!window.gates["workspace-download"]);
    // Background workspace controls are driven as the native selection event to
    // exercise scope replacement while an accessible modal owns foreground focus.
    await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(B);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Other studio draft\.pdf/ })).toBeVisible();
    await page.evaluate(workspace => window.gates["workspace-download"].resolve(window.signed(workspace)), A);
    await expect(page.getByRole("link", { name: /^Download original file/ })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally { await page.close(); }
});

test("mobile author header exposes account settings and file details fit the viewport", async () => {
  const { page } = await fixture(390);
  try {
    const account = page.getByRole("link", { name: "Account settings and support", exact: true });
    await expect(account).toBeVisible(); await expect(account).toHaveAttribute("href", "/settings/data-rights");
    const box = await account.boundingBox(); assert(box && box.x >= 0 && box.x + box.width <= 390);
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile library must remain contained");
    await openFile(page); await page.getByRole("button", { name: "Prepare download", exact: true }).click();
    await expect(page.getByRole("link", { name: "Download original file · v2", exact: true })).toBeVisible();
    const dialog = await page.getByRole("dialog").boundingBox(); assert(dialog && dialog.x >= 0 && dialog.x + dialog.width <= 390);
    await page.screenshot({ path: resolve(artifacts, "mobile-file-details.png"), fullPage: true });
    await page.getByRole("button", { name: "Close asset details", exact: true }).click();
    await page.screenshot({ path: resolve(artifacts, "mobile-library-account.png"), fullPage: true });
  } finally { await page.close(); }
});

test("small mobile admin header keeps navigation, account settings and sign-out reachable", async () => {
  const { page } = await fixture(320, true);
  try {
    for (const target of [page.getByRole("button", { name: "Open author navigation", exact: true }), page.getByRole("link", { name: "Admin", exact: true }), page.getByRole("link", { name: "Account settings and support", exact: true }), page.getByRole("button", { name: "Sign out", exact: true })]) {
      await expect(target).toBeVisible(); const box = await target.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= 320, "mobile header control must fit the viewport");
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "small mobile library must remain contained");
    const folders = page.getByRole("complementary", { name: "Folders", exact: true });
    const files = folders.locator("..").locator(":scope > section");
    const folderBox = await folders.boundingBox(); const fileBox = await files.boundingBox();
    const fileButtonBox = await page.getByRole("button", { name: /^My draft\.pdf/ }).boundingBox();
    for (const box of [folderBox, fileBox, fileButtonBox]) assert(box && box.x >= 0 && box.x + box.width <= 320, "actual library content must fit the viewport");
    assert(folderBox.y + folderBox.height <= fileBox.y, "folders and file library must stack without overlap");
    await page.screenshot({ path: resolve(artifacts, "mobile-small-admin-header.png"), fullPage: true });
  } finally { await page.close(); }
});
