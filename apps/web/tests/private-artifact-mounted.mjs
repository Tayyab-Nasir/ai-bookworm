// Real React components and compiled project CSS; all API/PDF responses are in-memory fixtures.
// Run with installed Chrome: node --test apps/web/tests/saved-print-mounted.mjs
// CI sets BROWSER_TEST_CHANNEL=chromium for its downloaded full browser.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
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
const zipBytes = Buffer.from("PKsynthetic-retailer-package");
const epubBytes = Buffer.from("PKsynthetic-saved-epub");
const audioBytes = Buffer.from("ID3synthetic-private-segment"); // Transport fixture only, not a narration-quality test.
const primaryDigest = createHash("sha256").update(pdfBytes).digest("hex");
const coverDigest = createHash("sha256").update(pngBytes).digest("hex");
const bundles = await Promise.all([false, true].map(parent => build({ stdin: { contents: parent
  ? `import React from "react"; import { createRoot } from "react-dom/client";
     import Studio from "./apps/web/components/PublishingStudio"; import { ApiClientError } from "@bookworm/api-client";
     window.ApiClientError = ApiClientError; const root = createRoot(document.getElementById("root"));
     window.showStudio = bookId => root.render(bookId ? React.createElement(Studio, {bookId}) : null);`
  : `import React, { useCallback, useState } from "react"; import { createRoot } from "react-dom/client";
     import Library from "./apps/web/components/SavedPrintLibrary"; import { ApiClientError } from "@bookworm/api-client";
     window.ApiClientError = ApiClientError;
     function Parent() {
       const [props, setProps] = useState(window.initialProps); const [selected, setSelected] = useState(null);
       window.setProofProps = patch => setProps(current => ({...current, ...patch}));
       const select = useCallback(value => { window.selected.push(value); setSelected(value); }, []);
       const invalidate = useCallback(jobId => { window.invalidated.push(jobId); setSelected(current => current?.jobId === jobId ? null : current); }, []);
       return React.createElement("main", {className: "mx-auto max-w-5xl p-4 sm:p-8"},
         React.createElement("output", {"aria-label":"Committed proof settings"}, props.dirty ? "Dirty" : "Saved"),
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
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "chrome" });
const artifacts = await mkdtemp(resolve(tmpdir(), "bookworm-saved-print-mounted-"));
const storage = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/api/auth/session") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ user: { id: ids.asset }, storageOrigin })); return;
  }
  if (url.pathname === "/bookworm-saved-print-fixture") {
    response.writeHead(200, { "content-type": "text/html", "content-security-policy":
      `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${storageOrigin} data:; frame-src ${storageOrigin}; media-src ${storageOrigin}; connect-src 'self'; font-src 'self' data:` });
    response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>'); return;
  }
  if (!url.pathname.startsWith("/storage/v1/object/sign/book-assets/workspaces/") || url.searchParams.get("token") !== "synthetic") {
    response.writeHead(404); response.end(); return;
  }
  const filename = url.searchParams.get("download");
  const bytes = url.pathname.endsWith(".epub") ? epubBytes : url.pathname.endsWith(".zip") ? zipBytes : url.pathname.endsWith(".mp3") ? audioBytes : url.pathname.endsWith(".png") ? pngBytes : pdfBytes;
  response.writeHead(200, {
    "content-type": url.pathname.endsWith(".zip") ? "application/zip" : url.pathname.endsWith(".mp3") ? "audio/mpeg" : url.pathname.endsWith(".png") ? "image/png" : "application/pdf",
    "content-length": bytes.length, "cache-control": "no-store",
    // Real HTTP lets full Chrome load its PDF viewer. Only Download gets attachment disposition.
    "content-disposition": filename ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` : "inline",
  });
  response.end(bytes);
});
test.after(async () => {
  try { await browser.close(); }
  finally { storage.closeAllConnections(); await new Promise(resolve => storage.close(resolve)); }
});
await new Promise((resolve, reject) => { storage.once("error", reject); storage.listen(0, "127.0.0.1", resolve); });
const storageOrigin = `http://127.0.0.1:${storage.address().port}`;

async function fixture({ parent = false, width = 1280, disabled = false, audio = false, audioFailure = null } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 980 } }); page.setDefaultTimeout(6000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  // Different hosts enforce cross-origin download behavior without intercepting Chrome's PDF viewer.
  await page.goto(`http://localhost:${storage.address().port}/bookworm-saved-print-fixture`);
  await page.addStyleTag({ content: styles.css + "body { background: #050505; color: white; } output { display: block; margin-top: 16px; }" });
  await page.evaluate(({ ids, disabled, primaryDigest, primarySize, coverDigest, coverSize, audio, storageOrigin }) => {
    window.ids = ids; window.fixtureStoragePort = new URL(storageOrigin).port; window.requests = []; window.selected = []; window.invalidated = []; window.historyWaiters = []; window.downloadWaiters = []; window.pageWaiters = [];
    window.initialProps = { actor: ids.asset, bookId: ids.book, workspaceId: ids.workspace, editionId: ids.edition, disabled };
    const proof = (editionId, jobId, assetId, letter) => ({ jobId, createdAt: "2026-10-13T12:00:00.000Z", fingerprint: letter.repeat(64),
      source: { bookId: ids.book, editionId, jobId, assetId, version: 1, sha256: primaryDigest, sizeBytes: primarySize } });
    window.proofs = [proof(ids.edition, ids.job, ids.asset, "b"), proof(ids.otherEdition, ids.otherJob, ids.otherAsset, "c")];
    const result = entry => ({ jobId: entry.jobId, status: "succeeded", artifacts: [
      { asset: { id: entry.source.assetId, workspace_id: ids.workspace, type: "rendered_book", name: "Saved interior.pdf",
          storage_path: `workspaces/${ids.workspace}/assets/${entry.source.assetId}/v1/book.pdf`, mime_type: "application/pdf", size_bytes: primarySize,
          checksum: primaryDigest, deleted_at: null, status: "draft" }, role: "rendered_print",
        download: { url: `${storageOrigin}/storage/v1/object/sign/book-assets/workspaces/${ids.workspace}/assets/${entry.source.assetId}/v1/book.pdf?token=synthetic`, expiresIn: 300 } },
      { asset: { id: ids.cover, workspace_id: ids.workspace, type: "rendered_cover", name: "Saved cover.png",
          storage_path: `workspaces/${ids.workspace}/assets/${ids.cover}/v1/cover.png`, mime_type: "image/png", size_bytes: coverSize,
          checksum: coverDigest, deleted_at: null, status: "draft" }, role: "rendered_cover",
        download: { url: `${storageOrigin}/storage/v1/object/sign/book-assets/workspaces/${ids.workspace}/assets/${ids.cover}/v1/cover.png?token=synthetic`, expiresIn: 300 } },
    ] });
    window.results = Object.fromEntries(window.proofs.map(entry => [entry.jobId, result(entry)]));
    const editions = [ids.edition, ids.otherEdition].map(id => ({ id, book_id: ids.book, type: audio ? "audiobook" : "print", language: "en", status: "draft",
      updated_at: "2026-10-13T00:00:00.000Z", edition_metadata_json: { kind: audio ? "audiobook" : "print", cover: { asset_id: null } } }));
    window.bookwormApi = {
      getBook: async bookId => ({ book: { id: bookId, workspace_id: ids.workspace, title: "Saved author manuscript", language: "en" }, role: "owner" }),
      listEditions: async () => ({ editions }), listPublishingJobs: async () => ({ jobs: [] }), listAssets: async () => ({ assets: [] }), listChapters: async () => ({ chapters: [] }),
      listNarrationModels: async () => ({ models: [] }), listAudiobookGooglePlayExports: async () => ({ jobs: [] }),
      listAudiobookProjects: async () => ({ projects: [{ id: ids.job, chapterId: ids.asset, status: "running", segmentCount: 1,
        billingMode: "quoted", creditUnits: 1, voice: "marin", segments: [{ index: 0, status: "succeeded", download: {
          url: `${storageOrigin}/storage/v1/object/sign/book-assets/workspaces/${ids.workspace}/assets/${ids.asset}/v1/part.mp3?token=synthetic`, expiresIn: 300,
        } }] }] }),
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
      readPrintPage: async (editionId, jobId, pageNumber, source, signal) => {
        window.requests.push({ method: "GET", action: "page", editionId, jobId, pageNumber, source });
        const proof = structuredClone(window.proofs.find(item => item.jobId === jobId));
        const image = { mimeType: "image/png", width: 1, height: 1, sizeBytes: coverSize, sha256: coverDigest,
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==" };
        if (window.holdPage) await new Promise(resolve => window.pageWaiters.push(resolve));
        if (window.pageError) throw new window.ApiClientError(window.pageError, "access_denied", "Saved PDF page access revoked", "fixture");
        if (window.corruptPage) image.sha256 = "d".repeat(64);
        return { formatVersion: "pdf-proof-1.0.0", source: { ...proof.source, role: "rendered_print" }, fingerprint: proof.fingerprint,
          sourceSha256: primaryDigest, sourceSizeBytes: primarySize, pageNumber, pageCount: 4, requestedWidth: source.width,
          pageWidthPoints: 432, pageHeightPoints: 648, text: `Saved page ${pageNumber} <script>literal, never executed</script>`, textTruncated: false, image };
      },
      runPreflight: async body => { window.requests.push({ method: "POST", action: "preflight", body });
        if (window.holdPreflight) await new Promise(resolve => { window.releasePreflight = resolve; });
        return { jobId: ids.otherJob, requestedChannel: body.channel, channel: body.channel, ruleVersion: "fixture-print-rules", errors: 0, warnings: 0, findings: [] }; },
      renderEdition: async () => { window.requests.push({ method: "POST", action: "render" }); throw new Error("Unexpected rendering request"); },
      createPublishingJob: async () => { window.requests.push({ method: "POST", action: "package" }); throw new Error("Unexpected package request"); },
    };
  }, { ids, disabled, primaryDigest, primarySize: pdfBytes.length, coverDigest, coverSize: pngBytes.length, audio, storageOrigin });
  if (audioFailure) await page.evaluate(kind => { window.bookwormApi[kind] = async () => { throw new Error(`Initial ${kind} failure`); }; }, audioFailure);
  for (const file of bundles[parent ? 1 : 0].outputFiles.filter(file => file.path.endsWith(".css"))) await page.addStyleTag({ content: file.text });
  await page.addScriptTag({ content: bundles[parent ? 1 : 0].outputFiles.find(file => file.path.endsWith(".js")).text });
  await page.evaluate(({ parent, book }) => parent ? window.showStudio(book) : window.mountLibrary(), { parent, book: ids.book });
  await page.getByRole("heading", { name: audio ? "Saved audio & delivery" : "Saved print proofs", exact: true }).waitFor();
  return { page, errors };
}
async function open(page) { await expect(page.getByRole("button", { name: "Open saved print", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "Open saved print", exact: true }).click(); await page.getByRole("button", { name: "Renew private links", exact: true }).waitFor(); }

async function showPackage(page) {
  await page.evaluate(() => { window.bookwormApi.listPublishingJobs = async () => ({ jobs: [{ id: window.ids.job, editionId: window.ids.edition, channel: "kdp", status: "succeeded",
    createdAt: "2026-10-17T00:00:00Z", package: { asset: { id: window.ids.asset, workspace_id: window.ids.workspace, storage_path: `workspaces/${window.ids.workspace}/assets/${window.ids.asset}/v1/kdp-export.zip`, size_bytes: 1024, checksum: "a".repeat(64) },
      download: { url: window.results[window.ids.job].artifacts[0].download.url.replace("book.pdf", "kdp-export.zip"), expiresIn: 300 } } }] }); });
  const history = page.getByRole("region", { name: "Retailer export packages", exact: true });
  await history.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(history.getByRole("button", { name: "Download private ZIP" })).toBeVisible();
}

for (const kind of ["print", "package"]) test(`verified ${kind} download uses attachment without exposing its signed link`, async () => {
  const { page } = await fixture({ parent: true });
  try {
    if (kind === "print") await open(page); else await showPackage(page);
    const name = kind === "print" ? "Download private file" : "Download private ZIP";
    const target = page.getByRole("button", { name, exact: true }).first();
    await expect(target).toBeVisible();
    assert.equal(await page.getByRole("link", { name, exact: true }).count(), 0);
    const [download] = await Promise.all([page.waitForEvent("download"), target.click()]);
    assert.equal(await download.failure(), null);
    assert.equal(download.suggestedFilename(), kind === "print" ? "Saved interior.pdf" : "kdp-export.zip");
    assert.deepEqual(await readFile(await download.path()), kind === "print" ? pdfBytes : zipBytes);
  } finally { await page.close(); }
});

for (const kind of ["print", "package"]) test(`silent account switch blocks the saved ${kind} download`, async () => {
  const { page } = await fixture({ parent: true });
  try {
    if (kind === "print") await open(page); else await showPackage(page);
    const name = kind === "print" ? "Download private file" : "Download private ZIP";
    let downloads = 0; page.on("download", () => downloads++);
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: ids.otherAsset } } }));
    await page.getByRole("button", { name, exact: true }).first().click();
    await expect(page.getByText(/Your account changed/)).toBeVisible();
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    assert.equal(downloads, 0);
  } finally { await page.close(); }
});

async function showAudioArchive(page) {
  await page.evaluate(() => { window.bookwormApi.listAudiobookGooglePlayExports = async () => ({ jobs: [{
    id: window.ids.job, editionId: window.ids.edition, status: "succeeded", progressChapters: 1, progressTotal: 1,
    createdAt: "2026-10-13T12:00:00Z", synthesizedVoiceDisclosureRequired: true, downloadExpiresIn: 300,
    downloadUrl: `http://127.0.0.1:${window.fixtureStoragePort}/storage/v1/object/sign/book-assets/workspaces/${window.ids.workspace}/audiobook-exports/${window.ids.job}/${window.ids.otherJob}.zip?token=synthetic`
  }] }); });
  const history = page.getByRole("heading", { name: "Export history", exact: true }).locator("..");
  await history.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download private ZIP", exact: true })).toBeVisible();
}

test("verified audiobook archive downloads as an attachment", async () => {
  const { page } = await fixture({ parent: true, audio: true });
  try {
    await showAudioArchive(page);
    const target = page.getByRole("button", { name: "Download private ZIP", exact: true });
    const [download] = await Promise.all([page.waitForEvent("download"), target.click()]);
    assert.equal(await download.failure(), null); assert.equal(download.suggestedFilename(), "googleplay-audiobook.zip");
    assert.deepEqual(await readFile(await download.path()), zipBytes);
  } finally { await page.close(); }
});

test("silent account change blocks the audiobook archive download", async () => {
  const { page } = await fixture({ parent: true, audio: true });
  try {
    await showAudioArchive(page); let downloads = 0; page.on("download", () => downloads++);
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: ids.otherAsset } } }));
    await page.getByRole("button", { name: "Download private ZIP", exact: true }).click();
    await expect(page.getByText(/Your account changed/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Download private ZIP", exact: true })).toHaveCount(0);
    assert.equal(downloads, 0);
  } finally { await page.close(); }
});

test("focus change invalidates pending actor verification before download", async () => {
  const { page } = await fixture({ parent: true }); let held;
  try {
    await open(page);
    await page.route("**/api/auth/session", route => { held = route; });
    let downloads = 0; page.on("download", () => downloads++);
    await page.getByRole("button", { name: "Download private file", exact: true }).first().click();
    await expect.poll(() => Boolean(held)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await held.fulfill({ json: { user: { id: ids.asset } } });
    await page.waitForTimeout(200); assert.equal(downloads, 0);
  } finally { await page.close(); }
});

test("stale removed print button cannot activate after newer edition settings", async () => {
  const { page } = await fixture({ parent: true });
  try {
    await open(page);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("button")].find(x => x.textContent?.trim() === "Download private file");
      const key = Object.keys(el).find(x => x.startsWith("__reactProps$"));
      if (!key) throw new Error("React handler unavailable");
      window.oldDownload = el[key].onClick;
    });
    await page.getByLabel("Language", { exact: true }).fill("fr");
    await expect(page.getByRole("button", { name: "Download private file" })).toHaveCount(0);
    let downloads = 0; page.on("download", () => downloads++);
    await page.evaluate(() => window.oldDownload()); await page.waitForTimeout(200);
    assert.equal(downloads, 0); await expect(page.getByLabel("Language", { exact: true })).toHaveValue("fr");
  } finally { await page.close(); }
});

for (const kind of ["print", "package"]) test(`expired ${kind} download cannot activate before its timer fires`, async () => {
  const { page } = await fixture({ parent: true });
  try {
    if (kind === "print") await open(page); else await showPackage(page);
    const name = kind === "print" ? "Download private file" : "Download private ZIP";
    let downloads = 0; page.on("download", () => downloads++);
    await page.evaluate(() => { const original = Date.now; Date.now = () => original() + 301_000; });
    await page.getByRole("button", { name, exact: true }).first().click();
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    assert.equal(downloads, 0);
  } finally { await page.close(); }
});

async function setupEpub(page) {
  await page.evaluate(() => window.showStudio(null));
  await expect(page.getByRole("heading", { name: "Saved print proofs" })).toHaveCount(0);
  await page.evaluate(origin => {
    const source = { bookId: window.ids.book, editionId: window.ids.edition, jobId: window.ids.job,
      assetId: window.ids.asset, version: 1, sha256: "c".repeat(64), sizeBytes: 2400 };
    window.bookwormApi.listEditions = async () => ({ editions: [{ id: window.ids.edition, book_id: window.ids.book,
      type: "ebook", language: "en", status: "draft", updated_at: "2026-10-13T00:00:00Z", edition_metadata_json: { kind: "ebook", flow: "reflowable" } }] });
    window.bookwormApi.listEditionRenders = async () => ({ renders: [{ jobId: source.jobId, source, createdAt: "2026-10-13T00:00:00Z" }] });
    window.bookwormApi.readEpubSection = async (_edition, _job, index) => ({ source, formatVersion: "epub-reader-1.0.0", layout: "reflowable",
      spine: [{ index: 0, title: "Saved chapter", layout: "reflowable" }],
      document: { index, title: "Saved chapter", layout: "reflowable", direction: "ltr", html: "<div><p>Private saved chapter.</p></div>", resources: [] }, warnings: [] });
    window.bookwormApi.getAssetDownloadUrl = async () => ({ url: `${origin}/storage/v1/object/sign/book-assets/workspaces/${window.ids.workspace}/assets/${window.ids.asset}/v1/book.epub?token=synthetic`, expiresIn: 300 });
    window.showStudio(window.ids.book);
  }, storageOrigin);
  const desk = page.getByRole("region", { name: "Saved EPUB proof", exact: true });
  await expect(desk).toBeVisible();
  await expect(desk.getByRole("button", { name: "Renew exact EPUB download" })).toBeVisible();
  await desk.getByRole("button", { name: "Renew exact EPUB download" }).click();
  await expect(desk.getByRole("button", { name: "Download saved EPUB v1" })).toBeVisible();
  return desk;
}

test("EPUB proof retains sandbox and downloads exact attachment after actor verification", async () => {
  const { page } = await fixture({ parent: true });
  try {
    const desk = await setupEpub(page);
    const frame = desk.locator("iframe");
    await expect(frame).toHaveCount(1);
    assert(!String(await frame.getAttribute("sandbox")).includes("allow-same-origin"));
    assert.match(await frame.getAttribute("srcdoc"), /default-src 'none'; img-src data:/);
    assert.equal(await desk.getByRole("link", { name: "Download saved EPUB v1" }).count(), 0);
    const [download] = await Promise.all([page.waitForEvent("download"), desk.getByRole("button", { name: "Download saved EPUB v1" }).click()]);
    assert.equal(await download.failure(), null); assert.equal(download.suggestedFilename(), "book.epub");
    assert.deepEqual(await readFile(await download.path()), epubBytes);
  } finally { await page.close(); }
});

test("silent account switch blocks EPUB download and clears the prior private proof", async () => {
  const { page } = await fixture({ parent: true });
  try {
    const desk = await setupEpub(page); let downloads = 0; page.on("download", () => downloads++);
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: ids.otherAsset } } }));
    await desk.getByRole("button", { name: "Download saved EPUB v1" }).click();
    await expect(desk.getByText(/Your session or access changed/)).toBeVisible();
    await expect(desk.getByRole("button", { name: "Download saved EPUB v1" })).toHaveCount(0);
    assert.equal(downloads, 0);
  } finally { await page.close(); }
});

for (const kind of ["foreign-origin", "foreign-path", "duplicate-token", "unknown-query"]) test(`rejects a ${kind} retailer Storage link before navigation`, async () => {
  const { page } = await fixture({ parent: true });
  try {
    await showPackage(page);
    await page.evaluate(kind => {
      const valid = `http://127.0.0.1:${window.fixtureStoragePort}/storage/v1/object/sign/book-assets/workspaces/${window.ids.workspace}/assets/${window.ids.asset}/v1/kdp-export.zip?token=synthetic`;
      const malformed = kind === "foreign-origin" ? valid.replace("127.0.0.1", "localhost")
        : kind === "foreign-path" ? valid.replace(window.ids.asset, window.ids.otherAsset)
        : kind === "duplicate-token" ? valid + "&token=second" : valid + "&other=unexpected";
      window.bookwormApi.listPublishingJobs = async () => ({ jobs: [{ id: window.ids.job, editionId: window.ids.edition, channel: "kdp", status: "succeeded",
        createdAt: "2026-10-17T00:00:00Z", package: { asset: { id: window.ids.asset, workspace_id: window.ids.workspace,
          storage_path: `workspaces/${window.ids.workspace}/assets/${window.ids.asset}/v1/kdp-export.zip`, size_bytes: 1024, checksum: "a".repeat(64) },
          download: { url: malformed, expiresIn: 300 } } }] });
    }, kind);
    const history = page.getByRole("region", { name: "Retailer export packages", exact: true });
    await history.getByRole("button", { name: "Refresh", exact: true }).click();
    let downloads = 0; page.on("download", () => downloads++);
    await history.getByRole("button", { name: "Download private ZIP" }).click();
    await expect(page.getByText(/private download link could not be verified/)).toBeVisible();
    assert.equal(downloads, 0);
  } finally { await page.close(); }
});

test("missing verified Storage origin blocks the download without affecting session identity", async () => {
  const { page } = await fixture({ parent: true });
  try {
    await open(page); let downloads = 0; page.on("download", () => downloads++);
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: ids.asset } } }));
    await page.getByRole("button", { name: "Download private file" }).first().click();
    await expect(page.getByText(/private Storage origin could not be verified/)).toBeVisible();
    assert.equal(downloads, 0);
  } finally { await page.close(); }
});


test("EPUB actor mismatch on history withdraws saved chapter and download", async () => {
 const {page} = await fixture({parent:true}); try {
  const desk = await setupEpub(page); await expect(desk.locator("iframe")).toHaveCount(1);
  await page.evaluate(() => { window.bookwormApi.listEditionRenders = async () => { throw new window.ApiClientError(409, "auth_error", "Account changed", "fixture"); }; });
  await desk.getByRole("button", {name:"Refresh saved exports"}).click();
  await expect(desk.getByText(/Your session or access changed/)).toBeVisible();
  await expect(desk.locator("iframe")).toHaveCount(0);
  await expect(desk.getByRole("button", {name:"Download saved EPUB v1"})).toHaveCount(0);
 } finally { await page.close(); }
});
