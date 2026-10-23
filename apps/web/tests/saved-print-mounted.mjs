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
    response.end(JSON.stringify({ user: { id: ids.asset } })); return;
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
  const bytes = url.pathname.endsWith(".mp3") ? audioBytes : url.pathname.endsWith(".png") ? pngBytes : pdfBytes;
  response.writeHead(200, {
    "content-type": url.pathname.endsWith(".mp3") ? "audio/mpeg" : url.pathname.endsWith(".png") ? "image/png" : "application/pdf",
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

async function fixture({ parent = false, width = 1280, disabled = false, audio = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 980 } }); page.setDefaultTimeout(6000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  // Different hosts enforce cross-origin download behavior without intercepting Chrome's PDF viewer.
  await page.goto(`http://localhost:${storage.address().port}/bookworm-saved-print-fixture`);
  await page.addStyleTag({ content: styles.css + "body { background: #050505; color: white; } output { display: block; margin-top: 16px; }" });
  await page.evaluate(({ ids, disabled, primaryDigest, primarySize, coverDigest, coverSize, audio, storageOrigin }) => {
    window.ids = ids; window.requests = []; window.selected = []; window.invalidated = []; window.historyWaiters = []; window.downloadWaiters = []; window.pageWaiters = [];
    window.initialProps = { bookId: ids.book, workspaceId: ids.workspace, editionId: ids.edition, disabled };
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
  for (const file of bundles[parent ? 1 : 0].outputFiles.filter(file => file.path.endsWith(".css"))) await page.addStyleTag({ content: file.text });
  await page.addScriptTag({ content: bundles[parent ? 1 : 0].outputFiles.find(file => file.path.endsWith(".js")).text });
  await page.evaluate(({ parent, book }) => parent ? window.showStudio(book) : window.mountLibrary(), { parent, book: ids.book });
  await page.getByRole("heading", { name: audio ? "Saved audio & delivery" : "Saved print proofs", exact: true }).waitFor();
  return { page, errors };
}
async function open(page) { await expect(page.getByRole("button", { name: "Open saved print", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "Open saved print", exact: true }).click(); await page.getByRole("button", { name: "Renew private links", exact: true }).waitFor(); }

test("actual Studio recovers a lost export reply after remount without submitting another package", async () => {
  const { page, errors } = await fixture({ parent: true });
  try {
    await page.evaluate(() => {
      window.bookwormApi.createPublishingJob = async body => {
        window.requests.push({ method: "POST", action: "package", body });
        window.acceptedPackage = { id: window.ids.otherAsset, requestId: body.idempotencyKey, bookId: body.bookId,
          editionId: body.editionId, channel: body.channel, sourceRenderJobId: body.renderJobId, sourcePreflightJobId: body.preflightJobId,
          status: "succeeded", submissionMode: "manual", package: null, createdAt: new Date().toISOString() };
        throw new Error("The reply was lost");
      };
      window.bookwormApi.getPublishingRequest = async (bookId, requestId) => {
        window.requests.push({ method: "GET", action: "recover-package", bookId, requestId });
        return { requestId, job: structuredClone(window.acceptedPackage) };
      };
    });
    await open(page);
    await page.getByRole("combobox", { name: "Preflight target", exact: true }).selectOption("kdp");
    await page.getByRole("button", { name: "Run preflight", exact: true }).click();
    await page.getByRole("button", { name: "Create retailer package", exact: true }).click();
    await expect(page.getByText(/The reply was lost/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Recover saved export", exact: true })).toBeEnabled();
    const saved = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith("bookworm:package:")));
    assert.equal(saved.length, 1); assert.equal(saved[0][1].includes("Saved author manuscript"), false);
    // Unmount/remount the real component; sessionStorage survives exactly as on reload.
    await page.evaluate(() => window.showStudio(null));
    await page.getByRole("heading", { name: "Saved print proofs", exact: true }).waitFor({ state: "hidden" });
    await page.evaluate(() => {
      const original = window.bookwormApi.getBook;
      window.bookwormApi.getBook = async bookId => ({ ...await original(bookId), role: "viewer" });
    });
    await page.evaluate(() => window.showStudio(window.ids.book));
    await expect(page.getByRole("button", { name: "Retry original export", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Recover saved export", exact: true }).click();
    await expect(page.getByText(/Saved export confirmed/)).toBeVisible();
    assert.equal(await page.evaluate(() => window.requests.filter(row => row.action === "package").length), 1);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith("bookworm:package:"))), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("actual Studio retries the exact original export even after another edition is selected", async () => {
  const { page, errors } = await fixture({ parent: true });
  try {
    await page.evaluate(() => {
      window.bookwormApi.createPublishingJob = async body => {
        window.requests.push({ method: "POST", action: "package", body });
        if (window.requests.filter(row => row.action === "package").length === 1) throw new Error("Unknown export outcome");
        return { id: window.ids.otherAsset, requestId: body.idempotencyKey, bookId: body.bookId, editionId: body.editionId,
          channel: body.channel, sourceRenderJobId: body.renderJobId, sourcePreflightJobId: body.preflightJobId,
          status: "succeeded", submissionMode: "manual", package: null, createdAt: new Date().toISOString() };
      };
    });
    await open(page); await page.getByRole("combobox", { name: "Preflight target", exact: true }).selectOption("kdp");
    await page.getByRole("button", { name: "Run preflight", exact: true }).click();
    await page.getByRole("button", { name: "Create retailer package", exact: true }).click();
    await expect(page.getByText(/Unknown export outcome/)).toBeVisible();
    await page.locator("aside").getByRole("button", { name: "print en · draft" }).nth(1).click();
    await page.getByRole("button", { name: "Retry original export", exact: true }).click();
    await expect(page.getByText(/Saved export confirmed/)).toBeVisible();
    const bodies = await page.evaluate(() => window.requests.filter(row => row.action === "package").map(row => row.body));
    assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(bodies[1].editionId, ids.edition); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("actual Studio retains a lost closure across remount and cannot retry the original export", async () => {
  const { page, errors } = await fixture({ parent: true, width: 390 });
  try {
    await page.evaluate(() => {
      window.bookwormApi.createPublishingJob = async body => { window.requests.push({ method: "POST", action: "package", body }); throw new Error("No accepted reply"); };
      window.bookwormApi.closePublishingRequest = async body => {
        window.requests.push({ method: "POST", action: "close", body });
        window.closedPackage = { id: window.ids.otherAsset, requestId: body.idempotencyKey, bookId: body.bookId, editionId: body.editionId,
          channel: body.channel, sourceRenderJobId: body.renderJobId, sourcePreflightJobId: body.preflightJobId,
          status: "cancelled", submissionMode: "manual", package: null, createdAt: new Date().toISOString() };
        throw new Error("Closure reply lost");
      };
      window.bookwormApi.getPublishingRequest = async (_book, requestId) => ({ requestId, job: window.closedPackage ?? null });
    });
    await open(page); await page.getByRole("combobox", { name: "Preflight target", exact: true }).selectOption("kdp");
    await page.getByRole("button", { name: "Run preflight", exact: true }).click();
    await page.getByRole("button", { name: "Create retailer package", exact: true }).click();
    await page.getByRole("button", { name: "Recover saved export", exact: true }).click();
    await expect(page.getByText(/No saved export was found/)).toBeVisible();
    await page.getByRole("checkbox", { name: /Close this request only/ }).check();
    await page.getByRole("button", { name: "Close unaccepted export request", exact: true }).click();
    await expect(page.getByText(/Closure reply lost/)).toBeVisible();
    await page.evaluate(() => window.showStudio(null)); await page.getByRole("heading", { name: "Saved print proofs", exact: true }).waitFor({ state: "hidden" });
    await page.evaluate(() => window.showStudio(window.ids.book));
    await expect(page.getByRole("button", { name: "Recover saved export", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Retry original export", exact: true })).toBeDisabled();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.getByLabel("Retailer request recovery").screenshot({ path: resolve(artifacts, "saved-export-recovery-mobile.png") });
    await page.getByRole("button", { name: "Recover saved export", exact: true }).click();
    await expect(page.getByText(/Saved request closed/)).toBeVisible();
    assert.equal(await page.evaluate(() => window.requests.filter(row => row.action === "package").length), 1);
    assert.equal(await page.evaluate(() => window.requests.filter(row => row.action === "close").length), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("actual Studio sends no export when storage cannot persist or the signed-in account changes", async () => {
  for (const failure of ["storage", "account"]) {
    const { page, errors } = await fixture({ parent: true });
    try {
      await open(page); await page.getByRole("combobox", { name: "Preflight target", exact: true }).selectOption("kdp");
      await page.getByRole("button", { name: "Run preflight", exact: true }).click();
      if (failure === "storage") await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("blocked"); }; });
      else await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: ids.otherAsset } } }));
      await page.getByRole("button", { name: "Create retailer package", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText(failure === "storage" ? "session recovery is unavailable" : "account changed");
      assert.equal(await page.evaluate(() => window.requests.some(row => row.action === "package")), false);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test("actual Studio retains the original request after a mismatched receipt or a late account change", async () => {
  for (const failure of ["source", "account"]) {
    const { page, errors } = await fixture({ parent: true });
    try {
      await page.evaluate(() => {
        window.bookwormApi.createPublishingJob = async body => {
          window.requests.push({ method: "POST", action: "package", body });
          window.acceptedPackage = { id: window.ids.otherAsset, requestId: body.idempotencyKey, bookId: body.bookId,
            editionId: body.editionId, channel: body.channel, sourceRenderJobId: body.renderJobId, sourcePreflightJobId: body.preflightJobId,
            status: "succeeded", submissionMode: "manual", package: null, createdAt: new Date().toISOString() };
          return new Promise(resolve => { window.releasePackage = resolve; });
        };
        window.bookwormApi.getPublishingRequest = async (_book, requestId) => ({ requestId, job: window.acceptedPackage });
      });
      await open(page); await page.getByRole("combobox", { name: "Preflight target", exact: true }).selectOption("kdp");
      await page.getByRole("button", { name: "Run preflight", exact: true }).click();
      await page.getByRole("button", { name: "Create retailer package", exact: true }).click();
      await expect.poll(() => page.evaluate(() => Boolean(window.releasePackage))).toBe(true);
      if (failure === "account") await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: ids.otherAsset } } }));
      await page.evaluate(failure => window.releasePackage({ ...window.acceptedPackage,
        ...(failure === "source" ? { sourceRenderJobId: window.ids.otherJob } : {}) }), failure);
      await expect(page.getByRole("alert")).toContainText(failure === "source" ? "does not match" : "account changed");
      await expect(page.getByText("unavailable", { exact: true })).toHaveCount(0);
      const pending = await page.evaluate(() => Object.values(sessionStorage).map(value => JSON.parse(value)));
      assert.equal(pending.length, 1); assert.equal(pending[0].userId, ids.asset);
      if (failure === "account") await page.unroute("**/api/auth/session");
      await page.evaluate(() => window.showStudio(null)); await page.getByRole("heading", { name: "Saved print proofs", exact: true }).waitFor({ state: "hidden" });
      await page.evaluate(() => window.showStudio(window.ids.book));
      await page.getByRole("button", { name: "Recover saved export", exact: true }).click();
      await expect(page.getByText(/Saved export confirmed/)).toBeVisible();
      assert.equal(await page.evaluate(() => window.requests.filter(row => row.action === "package").length), 1);
      assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith("bookworm:package:"))), false);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test("actual Studio distinguishes unavailable package history and restores its link without another export", async () => {
  const { page, errors } = await fixture({ parent: true });
  try {
    await page.evaluate(() => {
      window.savedPackage = { id: window.ids.job, editionId: window.ids.edition, channel: "kdp", status: "succeeded",
        createdAt: "2026-10-17T00:00:00Z", ruleVersion: "fixture-rules", package: {
          asset: { id: window.ids.asset, size_bytes: 1024, checksum: "a".repeat(64) },
          download: { url: window.results[window.ids.job].artifacts[0].download.url.replace("book.pdf", "kdp-export.zip"), expiresIn: 300 },
        } };
      window.packageJobs = [structuredClone(window.savedPackage)];
      window.bookwormApi.listPublishingJobs = async () => {
        window.requests.push({ method: "GET", action: "packages" });
        return { jobs: structuredClone(window.packageJobs) };
      };
    });
    const history = page.getByRole("region", { name: "Retailer export packages", exact: true });
    await history.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(history.getByText("ready", { exact: true })).toBeVisible();
    await expect(history.getByRole("link", { name: "Download private ZIP" })).toBeVisible();
    await page.evaluate(() => { window.packageJobs[0].package = null; });
    await history.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(history.getByText("unavailable", { exact: true })).toBeVisible();
    await expect(history.getByText("ready", { exact: true })).toHaveCount(0);
    await expect(history.getByRole("link", { name: "Download private ZIP" })).toHaveCount(0);
    await expect(history.getByText(/This job is saved in history, but its file is currently unavailable/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await history.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await history.screenshot({ path: resolve(artifacts, "unavailable-retailer-package-mobile.png") });
    await page.evaluate(() => { window.packageJobs = [structuredClone(window.savedPackage)]; });
    await history.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(history.getByText("ready", { exact: true })).toBeVisible();
    await expect(history.getByRole("link", { name: "Download private ZIP" })).toHaveAttribute("href", /\/kdp-export\.zip\?/);
    assert.equal(await page.evaluate(() => window.requests.some(request => request.method === "POST")), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("actual Studio downloads a private audio segment without replacing its player or leaving the app", async () => {
  const { page, errors } = await fixture({ parent: true, audio: true });
  try {
    const appUrl = page.url(), player = page.locator("audio"), link = page.getByRole("link", { name: "Download private MP3", exact: true });
    await expect(link).toBeVisible();
    const previewUrl = await player.getAttribute("src"), filename = `narration-${ids.job}-part-1.mp3`;
    assert.equal(new URL(previewUrl).searchParams.has("download"), false);
    assert.equal(new URL(await link.getAttribute("href")).searchParams.get("download"), filename);
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    assert.equal(download.suggestedFilename(), filename); assert.equal(await download.failure(), null);
    assert.deepEqual(await readFile(await download.path()), audioBytes);
    assert.equal(page.url(), appUrl); await expect(player).toHaveAttribute("src", previewUrl);
    assert.deepEqual(await page.evaluate(() => window.requests.filter(request => request.method !== "GET")), []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const source of ["saved", "new"]) test(`actual Studio downloads ${source} cross-origin PDF and cover without leaving inert page previews`, async () => {
  const { page, errors } = await fixture({ parent: true });
  try {
    const appUrl = page.url();
    let downloads = 0; page.on("download", () => { downloads++; });
    if (source === "saved") await open(page);
    else {
      await page.evaluate(() => { window.bookwormApi.renderEdition = async () => {
        window.requests.push({ method: "POST", action: "render" }); return structuredClone(window.results[window.ids.job]);
      }; });
      await page.getByRole("button", { name: "Render PDF", exact: true }).click();
    }
    const links = page.getByRole("link", { name: "Download private file", exact: true });
    await expect(links).toHaveCount(2);
    const preview = page.getByAltText("Saved interior, page 1 of 4", { exact: true });
    await expect(preview).toBeVisible();
    const previewUrl = await preview.getAttribute("src");
    assert(previewUrl.startsWith("data:image/png;base64,"));
    assert.equal(new URL(await page.getByAltText("Rendered book cover", { exact: true }).getAttribute("src")).searchParams.has("download"), false);
    await expect.poll(() => preview.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    assert.equal(await page.locator('iframe[title="Rendered print edition preview"]').count(), 0);
    await preview.screenshot({ path: resolve(artifacts, `${source}-print-inline-preview.png`) });
    assert.equal(downloads, 0, "Opening previews must not download files");
    for (const [index, filename, digest] of [[0, "Saved interior.pdf", primaryDigest], [1, "Saved cover.png", coverDigest]]) {
      const link = links.nth(index), href = new URL(await link.getAttribute("href"));
      assert.equal(href.searchParams.get("download"), filename);
      assert.equal(href.searchParams.get("token"), "synthetic");
      const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
      assert.equal(await download.failure(), null); assert.equal(download.suggestedFilename(), filename);
      assert.equal(createHash("sha256").update(await readFile(await download.path())).digest("hex"), digest);
      assert.equal(page.url(), appUrl); await expect(preview).toHaveAttribute("src", previewUrl);
    }
    assert.equal(downloads, 2);
    assert.deepEqual(await page.evaluate(() => window.requests.filter(request => request.method === "POST").map(request => request.action)), source === "new" ? ["render"] : []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("PDF proof page, jump, detail, zoom and escaped text work at mobile width without new renders", async () => {
  const { page, errors } = await fixture({ parent: true, width: 390 });
  try {
    await open(page); const reader = page.getByRole("region", { name: "Saved PDF page proof", exact: true });
    await expect(reader.getByAltText("Saved interior, page 1 of 4")).toBeVisible();
    await reader.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(reader.getByAltText("Saved interior, page 2 of 4")).toBeVisible();
    await reader.getByLabel("Go to PDF page", { exact: true }).fill("4"); await reader.getByRole("button", { name: "Go", exact: true }).click();
    await expect(reader.getByAltText("Saved interior, page 4 of 4")).toBeVisible();
    await expect(reader.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
    await reader.getByLabel("PDF detail", { exact: true }).selectOption("720");
    await expect.poll(() => page.evaluate(() => window.requests.filter(r => r.action === "page").at(-1)?.source.width)).toBe(720);
    await expect(reader.getByAltText("Saved interior, page 4 of 4")).toBeVisible();
    await reader.getByLabel("PDF zoom", { exact: true }).selectOption("200");
    await expect(reader.getByAltText("Saved interior, page 4 of 4")).toHaveAttribute("style", /width: 200%/);
    await reader.getByText("Page text (reading order may differ)", { exact: true }).click();
    await expect(reader.getByText("Saved page 4 <script>literal, never executed</script>", { exact: true })).toBeVisible();
    const region = reader.getByRole("region", { name: "PDF page 4 image", exact: true }); await region.focus();
    await page.keyboard.press("ArrowRight"); await expect.poll(() => region.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await reader.screenshot({ path: resolve(artifacts, "saved-pdf-page-proof-mobile.png") });
    assert.equal(await page.evaluate(() => window.requests.some(r => r.method !== "GET")), false); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("late PDF pages from a previous edition are ignored and membership failures withdraw pixels", async () => {
  const { page, errors } = await fixture({ parent: true });
  try {
    await page.evaluate(() => { window.holdPage = true; }); await open(page);
    await page.waitForFunction(() => window.pageWaiters.length === 1);
    await page.getByRole("button", { name: "print en · draft", exact: true }).nth(1).click();
    await page.evaluate(() => { window.holdPage = false; window.pageWaiters[0](); });
    await expect(page.getByAltText("Saved interior, page 1 of 4")).toHaveCount(0);
    await open(page); await expect(page.getByAltText("Saved interior, page 1 of 4")).toBeVisible();
    await page.evaluate(() => { window.pageError = 403; }); await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Saved PDF page access revoked");
    await expect(page.getByAltText(/Saved interior, page/)).toHaveCount(0);
    await page.evaluate(() => { window.pageError = null; }); await page.getByRole("button", { name: "Retry saved page", exact: true }).click();
    await expect(page.getByAltText("Saved interior, page 2 of 4")).toBeVisible(); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("freshly rendered links and PDF pages are withdrawn at their conservative expiry", async () => {
  const { page } = await fixture({ parent: true });
  try {
    await page.clock.install({ time: new Date("2026-10-24T00:00:00Z") });
    await page.evaluate(() => { window.bookwormApi.renderEdition = async () => {
      window.requests.push({ method: "POST", action: "render" }); const result = structuredClone(window.results[window.ids.job]);
      result.artifacts.forEach(item => { item.download.expiresIn = 2; }); return result;
    }; });
    await page.getByRole("button", { name: "Render PDF", exact: true }).click();
    await expect(page.getByAltText("Saved interior, page 1 of 4")).toBeVisible();
    await page.clock.fastForward(3000); await expect(page.getByRole("link", { name: "Download private file", exact: true })).toHaveCount(0);
    await expect(page.getByAltText(/Saved interior, page/)).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.requests.filter(r => r.action === "render").length), 1);
    await expect(page.getByText(/Private proof links expired/)).toBeVisible();
  } finally { await page.close(); }
});

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
    await expect(page.getByRole("button", { name: "Renew private links", exact: true })).toBeDisabled();
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
