// Real React components and compiled project CSS; all API/PDF responses are in-memory fixtures.
// Run from repository root: node --test apps/web/tests/saved-print-mounted.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const ids = { book: "11111111-1111-4111-8111-111111111111", edition: "22222222-2222-4222-8222-222222222222",
  job: "33333333-3333-4333-8333-333333333333", asset: "44444444-4444-4444-8444-444444444444",
  cover: "55555555-5555-4555-8555-555555555555", workspace: "66666666-6666-4666-8666-666666666666",
  otherEdition: "77777777-7777-4777-8777-777777777777", otherJob: "88888888-8888-4888-8888-888888888888",
  otherAsset: "99999999-9999-4999-8999-999999999999" };
const stream = "BT /F1 18 Tf 54 570 Td (Saved print proof) Tj ET\n";
const pdfObjects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 432 648] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
let pdfSource = "%PDF-1.4\n"; const pdfOffsets = [0];
for (const [index, object] of pdfObjects.entries()) { pdfOffsets.push(Buffer.byteLength(pdfSource)); pdfSource += `${index + 1} 0 obj\n${object}\nendobj\n`; }
const pdfXref = Buffer.byteLength(pdfSource);
pdfSource += `xref\n0 ${pdfOffsets.length}\n0000000000 65535 f \n${pdfOffsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${pdfOffsets.length} /Root 1 0 R >>\nstartxref\n${pdfXref}\n%%EOF\n`;
const pdfBytes = Buffer.from(pdfSource);
const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64");
const primaryDigest = createHash("sha256").update(pdfBytes).digest("hex");
const coverDigest = createHash("sha256").update(pngBytes).digest("hex");
const bundles = await Promise.all([false, true].map(parent => build({ stdin: { contents: parent
  ? `import React from "react"; import { createRoot } from "react-dom/client";
     import Studio from "./apps/web/components/PublishingStudio"; import { ApiClientError } from "@bookworm/api-client";
     window.ApiClientError = ApiClientError; const root = createRoot(document.getElementById("root"));
     window.showStudio = bookId => root.render(React.createElement(Studio, {bookId}));`
  : `import React, { useCallback, useState } from "react"; import { createRoot } from "react-dom/client";
     import Library from "./apps/web/components/SavedPrintLibrary"; import { ApiClientError } from "@bookworm/api-client";
     window.ApiClientError = ApiClientError;
     function Parent() {
       const [props, setProps] = useState(window.initialProps); const [selected, setSelected] = useState(null);
       window.setProofProps = patch => setProps(current => ({...current, ...patch}));
       const select = useCallback(value => { window.selected.push(value); setSelected(value); }, []);
       const invalidate = useCallback(jobId => { window.invalidated.push(jobId); setSelected(current => current?.jobId === jobId ? null : current); }, []);
       return React.createElement("main", {className: "mx-auto max-w-5xl p-4 sm:p-8"},
         React.createElement(Library, {...props, onSelect: select, onInvalidate: invalidate}),
         React.createElement("output", {"aria-label":"Selected print source"}, selected?.jobId ?? "No selected print"),
         selected && React.createElement("div", null, selected.artifacts.map(artifact => React.createElement("a", {key: artifact.asset.id,
           href: artifact.download.url, download: true}, artifact.role === "rendered_print" ? "Download exact saved interior" : "Download exact saved cover"))));
     }
     const root = createRoot(document.getElementById("root")); window.mountLibrary = () => root.render(React.createElement(Parent));`,
  loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  outfile: parent ? "saved-print-studio.js" : "saved-print-library.js",
  plugins: [{ name: "synthetic-print-transports", setup(builder) {
    builder.onResolve({ filter: /^(\.\/api|next\/link)$/ }, args => ({ path: args.path, namespace: "print-fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "print-fixture" }, args => ({ resolveDir: process.cwd(), contents: args.path === "./api"
      ? "export const apiClient = () => window.bookwormApi;"
      : 'import React from "react"; export default function Link({children,...props}) {return React.createElement("a", props, children);}' }));
  } }],
})));
const stylePath = resolve("apps/web/styles/globals.css");
const styles = await postcss([tailwind({ base: resolve("apps/web"), optimize: false })]).process(await readFile(stylePath, "utf8"), { from: stylePath });
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
const artifacts = await mkdtemp(resolve(tmpdir(), "bookworm-saved-print-mounted-"));
test.after(() => browser.close());

async function fixture({ parent = false, width = 1280, disabled = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 980 } }); page.setDefaultTimeout(6000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.fulfill(route.request().url().startsWith("https://storage.example.test/")
    ? route.request().url().includes("/cover.png") ? { contentType: "image/png", body: pngBytes } : { contentType: "application/pdf", body: pdfBytes }
    : { contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' }));
  await page.goto("http://127.0.0.1/bookworm-saved-print-fixture");
  await page.addStyleTag({ content: styles.css + "body { background: #050505; color: white; } output { display: block; margin-top: 16px; }" });
  await page.evaluate(({ ids, disabled, primaryDigest, primarySize, coverDigest, coverSize }) => {
    window.ids = ids; window.requests = []; window.selected = []; window.invalidated = []; window.historyWaiters = []; window.downloadWaiters = [];
    window.initialProps = { bookId: ids.book, workspaceId: ids.workspace, editionId: ids.edition, disabled };
    const proof = (editionId, jobId, assetId, letter) => ({ jobId, createdAt: "2026-10-13T12:00:00.000Z", fingerprint: letter.repeat(64),
      source: { bookId: ids.book, editionId, jobId, assetId, version: 1, sha256: primaryDigest, sizeBytes: primarySize } });
    window.proofs = [proof(ids.edition, ids.job, ids.asset, "b"), proof(ids.otherEdition, ids.otherJob, ids.otherAsset, "c")];
    const result = entry => ({ jobId: entry.jobId, status: "succeeded", artifacts: [
      { asset: { id: entry.source.assetId, workspace_id: ids.workspace, type: "rendered_book", name: "Saved interior.pdf",
          storage_path: `workspaces/${ids.workspace}/assets/${entry.source.assetId}/v1/book.pdf`, mime_type: "application/pdf", size_bytes: primarySize,
          checksum: primaryDigest, deleted_at: null, status: "draft" }, role: "rendered_print",
        download: { url: `https://storage.example.test/storage/v1/object/sign/book-assets/workspaces/${ids.workspace}/assets/${entry.source.assetId}/v1/book.pdf?token=synthetic`, expiresIn: 300 } },
      { asset: { id: ids.cover, workspace_id: ids.workspace, type: "rendered_cover", name: "Saved cover.png",
          storage_path: `workspaces/${ids.workspace}/assets/${ids.cover}/v1/cover.png`, mime_type: "image/png", size_bytes: coverSize,
          checksum: coverDigest, deleted_at: null, status: "draft" }, role: "rendered_cover",
        download: { url: `https://storage.example.test/storage/v1/object/sign/book-assets/workspaces/${ids.workspace}/assets/${ids.cover}/v1/cover.png?token=synthetic`, expiresIn: 300 } },
    ] });
    window.results = Object.fromEntries(window.proofs.map(entry => [entry.jobId, result(entry)]));
    const editions = [ids.edition, ids.otherEdition].map(id => ({ id, book_id: ids.book, type: "print", language: "en", status: "draft",
      updated_at: "2026-10-13T00:00:00.000Z", edition_metadata_json: { kind: "print", cover: { asset_id: null } } }));
    window.bookwormApi = {
      getBook: async bookId => ({ book: { id: bookId, workspace_id: ids.workspace, title: "Saved author manuscript", language: "en" }, role: "owner" }),
      listEditions: async () => ({ editions }), listPublishingJobs: async () => ({ jobs: [] }), listAssets: async () => ({ assets: [] }), listChapters: async () => ({ chapters: [] }),
      listPrintRenders: async editionId => {
        window.requests.push({ method: "GET", action: "history", editionId });
        const response = { renders: structuredClone(window.proofs.filter(proof => proof.source.editionId === editionId)) };
        if (window.holdHistory) await new Promise(resolve => window.historyWaiters.push(resolve));
        if (window.historyError) throw new window.ApiClientError(window.historyError, "access_denied", "Print history access revoked", "fixture");
        return response;
      },
      downloadPrintRender: async (editionId, jobId, sha256, fingerprint) => {
        window.requests.push({ method: "GET", action: "download", editionId, jobId, sha256, fingerprint });
        const response = structuredClone(window.results[jobId]);
        if (window.holdDownload) await new Promise(resolve => window.downloadWaiters.push(resolve));
        if (window.downloadError) throw new window.ApiClientError(window.downloadError, "access_denied", "Print proof access revoked", "fixture");
        return response;
      },
      runPreflight: async body => { window.requests.push({ method: "POST", action: "preflight", body });
        if (window.holdPreflight) await new Promise(resolve => { window.releasePreflight = resolve; });
        return { jobId: ids.otherJob, requestedChannel: body.channel, channel: body.channel, ruleVersion: "fixture-print-rules", errors: 0, warnings: 0, findings: [] }; },
      renderEdition: async () => { window.requests.push({ method: "POST", action: "render" }); throw new Error("Unexpected rendering request"); },
      createPublishingJob: async () => { window.requests.push({ method: "POST", action: "package" }); throw new Error("Unexpected package request"); },
    };
  }, { ids, disabled, primaryDigest, primarySize: pdfBytes.length, coverDigest, coverSize: pngBytes.length });
  for (const file of bundles[parent ? 1 : 0].outputFiles.filter(file => file.path.endsWith(".css"))) await page.addStyleTag({ content: file.text });
  await page.addScriptTag({ content: bundles[parent ? 1 : 0].outputFiles.find(file => file.path.endsWith(".js")).text });
  await page.evaluate(({ parent, book }) => parent ? window.showStudio(book) : window.mountLibrary(), { parent, book: ids.book });
  await page.getByRole("heading", { name: "Saved print proofs" }).waitFor();
  return { page, errors };
}
async function open(page) { await expect(page.getByRole("button", { name: "Open saved print", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "Open saved print", exact: true }).click(); await page.getByRole("button", { name: "Renew private links", exact: true }).waitFor(); }

test("initial parent loading waits, then reads history without posting or rendering", async () => {
  const { page, errors } = await fixture({ disabled: true });
  try {
    assert.deepEqual(await page.evaluate(() => window.requests), []);
    await page.evaluate(() => window.setProofProps({ disabled: false }));
    await expect(page.getByRole("button", { name: "Open saved print", exact: true })).toBeEnabled();
    assert.deepEqual(await page.evaluate(() => window.requests.map(request => [request.method, request.action])), [["GET", "history"]]); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
test("opening and renewing an exact previous print keeps transient parent busy state from discarding it", async () => {
  const { page, errors } = await fixture();
  try {
    await open(page); assert.equal(await page.getByRole("status", { name: "Selected print source" }).textContent(), ids.job);
    const request = await page.evaluate(() => window.requests.find(request => request.action === "download"));
    assert.equal(request.sha256, primaryDigest); assert.equal(request.fingerprint, "b".repeat(64));
    await page.evaluate(() => window.setProofProps({ disabled: true }));
    assert.equal(await page.getByRole("button", { name: "Renew private links", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("link", { name: "Download exact saved interior" }).count(), 1);
    await page.evaluate(() => window.setProofProps({ disabled: false }));
    await page.getByRole("button", { name: "Renew private links", exact: true }).click();
    await expect(page.getByRole("button", { name: "Renew private links", exact: true })).toBeEnabled();
    assert.equal(await page.evaluate(() => window.requests.filter(request => request.action === "download").length), 2);
    assert.equal(await page.evaluate(() => window.requests.some(request => request.method !== "GET")), false);
    await page.screenshot({ path: resolve(artifacts, "saved-print-library-desktop.png"), fullPage: true }); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
test("history refresh clears old links, and revoked access clears proofs and the parent selection", async () => {
  const { page } = await fixture();
  try {
    await open(page); await page.evaluate(() => { window.historyError = 403; });
    await page.getByRole("button", { name: "Refresh print history", exact: true }).click(); await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("link", { name: "Download exact saved interior" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Open saved print", exact: true }).count(), 0);
    assert.equal(await page.getByRole("status", { name: "Selected print source" }).textContent(), "No selected print");
  } finally { await page.close(); }
});
test("revoked renewal cannot leave a previously opened print in its parent", async () => {
  const { page } = await fixture();
  try {
    await open(page); await page.evaluate(() => { window.downloadError = 403; });
    await page.getByRole("button", { name: "Renew private links", exact: true }).click(); await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("link", { name: "Download exact saved interior" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Open saved print", exact: true }).count(), 0);
  } finally { await page.close(); }
});
test("an old edition history reply cannot appear in the newly selected edition", async () => {
  const { page } = await fixture({ disabled: true });
  try {
    await page.evaluate(() => { window.holdHistory = true; window.setProofProps({ disabled: false }); });
    await page.waitForFunction(() => window.historyWaiters.length === 1);
    await page.evaluate(() => { window.holdHistory = false; window.setProofProps({ editionId: window.ids.otherEdition }); });
    await expect(page.getByRole("button", { name: "Open saved print", exact: true })).toBeEnabled();
    await page.evaluate(() => window.historyWaiters[0]()); await open(page);
    assert.equal(await page.getByRole("status", { name: "Selected print source" }).textContent(), ids.otherJob);
    assert.equal(await page.evaluate(() => window.selected.length), 1);
  } finally { await page.close(); }
});
test("a late old-source download cannot overwrite a new edition proof", async () => {
  const { page } = await fixture();
  try {
    await page.evaluate(() => { window.holdDownload = true; });
    await expect(page.getByRole("button", { name: "Open saved print", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "Open saved print", exact: true }).click();
    await page.waitForFunction(() => window.downloadWaiters.length === 1);
    await page.evaluate(() => { window.holdDownload = false; window.setProofProps({ editionId: window.ids.otherEdition }); });
    await open(page); await page.evaluate(() => window.downloadWaiters[0]());
    assert.equal(await page.getByRole("status", { name: "Selected print source" }).textContent(), ids.otherJob);
    assert.deepEqual(await page.evaluate(() => window.selected.map(result => result.jobId)), [ids.otherJob]);
  } finally { await page.close(); }
});
test("unsaved settings immediately clear saved links and reject an in-flight old proof", async () => {
  const { page } = await fixture();
  try {
    await open(page); await page.evaluate(() => window.setProofProps({ dirty: true, disabled: true }));
    await expect(page.getByRole("status", { name: "Selected print source" })).toHaveText("No selected print");
    assert.equal(await page.getByRole("link", { name: "Download exact saved interior" }).count(), 0);
    await page.evaluate(() => { window.holdDownload = true; window.setProofProps({ dirty: false, disabled: false }); });
    await page.getByRole("button", { name: "Open saved print", exact: true }).click(); await page.waitForFunction(() => window.downloadWaiters.length === 1);
    await page.evaluate(() => { window.setProofProps({ dirty: true, disabled: true }); });
    await expect(page.getByRole("button", { name: "Open saved print", exact: true })).toBeDisabled();
    await page.evaluate(() => window.downloadWaiters[0]()); assert.equal(await page.getByRole("link", { name: "Download exact saved interior" }).count(), 0);
  } finally { await page.close(); }
});
test("five-minute expiry clears parent proof selection without a render request", async () => {
  const { page } = await fixture();
  try {
    await page.clock.install({ time: new Date("2026-10-13T12:00:00Z") }); await open(page);
    await page.clock.fastForward(301_000); await expect(page.getByRole("status", { name: "Selected print source" })).toHaveText("No selected print");
    assert.equal(await page.getByRole("link", { name: "Download exact saved interior" }).count(), 0);
    assert.equal(await page.evaluate(() => window.requests.some(request => request.method !== "GET")), false);
  } finally { await page.close(); }
});
test("actual Publishing Studio keeps an opened render through preflight and removes it when edition settings become dirty", async () => {
  const { page, errors } = await fixture({ parent: true });
  try {
    await open(page); await expect(page.getByRole("link", { name: "Download private file", exact: true })).toHaveCount(2);
    await page.getByRole("combobox", { name: /^Preflight target/ }).selectOption("kdp");
    await page.evaluate(() => { window.holdPreflight = true; }); await page.getByRole("button", { name: "Run preflight", exact: true }).click();
    await page.waitForFunction(() => typeof window.releasePreflight === "function");
    assert.equal(await page.getByRole("link", { name: "Download private file", exact: true }).count(), 2);
    await page.evaluate(() => window.releasePreflight()); await expect(page.getByRole("button", { name: "Create retailer package", exact: true })).toBeEnabled();
    assert.equal(await page.evaluate(() => window.requests.filter(request => request.method === "POST").map(request => request.action)).then(actions => actions.join(",")), "preflight");
    await page.screenshot({ path: resolve(artifacts, "saved-print-studio-desktop.png"), fullPage: true });
    await page.getByLabel("Language", { exact: true }).fill("fr");
    await expect(page.getByRole("link", { name: "Download private file", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create retailer package", exact: true })).toBeDisabled(); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
test("compiled print proof archive controls and opened source fit a narrow viewport", async () => {
  const { page, errors } = await fixture({ width: 375 });
  try {
    await open(page); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const name of ["Refresh print history", "Renew private links"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox(); assert(box && box.x >= 0 && box.x + box.width <= 375 && box.height >= 40);
    }
    await page.screenshot({ path: resolve(artifacts, "saved-print-library-mobile.png"), fullPage: true }); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
test.after(() => { console.log(`Saved-print mounted screenshots: ${artifacts}`); });

test("actual Studio book replacement cannot start an old-edition read or adopt its pending download", async () => {
  const { page, errors } = await fixture({ parent: true });
  try {
    await open(page);
    await page.evaluate(() => { window.holdDownload = true; });
    await page.getByRole("button", { name: "Renew private links", exact: true }).click();
    await page.waitForFunction(() => window.downloadWaiters.length === 1);
    const reads = await page.evaluate(() => window.requests.length);
    await page.evaluate(() => {
      window.bookwormApi.getBook = async () => new Promise(resolve => { window.releaseBook = resolve; });
      window.showStudio("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    });
    await page.waitForFunction(() => typeof window.releaseBook === "function");
    await expect(page.getByRole("link", { name: "Download private file", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Saved print proofs", exact: true })).toHaveCount(0);
    await page.evaluate(async () => { window.downloadWaiters[0](); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    assert.equal(await page.evaluate(() => window.requests.length), reads, "Replacement must not read history of the previous book's edition");
    await expect(page.getByRole("link", { name: "Download private file", exact: true })).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("links arriving beyond their conservative expiry are never adopted", async () => {
  const { page } = await fixture();
  try {
    await page.evaluate(() => { window.holdDownload = true; });
    await page.getByRole("button", { name: "Open saved print", exact: true }).click();
    await page.waitForFunction(() => window.downloadWaiters.length === 1);
    await page.evaluate(() => { const now = Date.now(); Date.now = () => now + 301000; window.downloadWaiters[0](); });
    await expect(page.getByRole("alert")).toContainText("expired before they arrived");
    assert.deepEqual(await page.evaluate(() => window.selected), []);
    await expect(page.getByRole("link", { name: "Download exact saved interior" })).toHaveCount(0);
  } finally { await page.close(); }
});

test("actual Studio blocks an expired print link even before a suspended timer fires", async () => {
  const { page, errors } = await fixture({ parent: true });
  try {
    let downloads = 0; page.on("download", () => { downloads++; });
    await open(page);
    await page.evaluate(() => { const now = Date.now(); Date.now = () => now + 301000; });
    await page.getByRole("link", { name: "Download private file", exact: true }).first().click();
    await expect(page.getByRole("alert")).toContainText("Private print links expired");
    await expect(page.getByRole("link", { name: "Download private file", exact: true })).toHaveCount(0);
    assert.equal(downloads, 0); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
