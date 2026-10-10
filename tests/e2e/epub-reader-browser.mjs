/** Local UI acceptance from actual saved EPUB bytes/native parser output.
 * Auth, membership, history and private-download delivery are synthetic local
 * fixtures; this does not prove a native account, hosted storage or retailers.
 * Run only against a frozen candidate with the existing auth browser fixture.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const fixtureOrigin = process.env.BROWSER_TEST_FIXTURE_ORIGIN ?? 'http://127.0.0.1:4399';
const appOrigin = process.env.BROWSER_TEST_ORIGIN ?? 'http://127.0.0.1:4398';
for (const origin of [fixtureOrigin, appOrigin]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'reader acceptance must remain loopback-only');
assert.equal((await fetch(`${fixtureOrigin}/health`).then((response) => response.json())).fixture, true);
const python = process.env.BROWSER_TEST_PYTHON ?? resolve('.venv/Scripts/python.exe');
const pythonEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot', 'windir', 'comspec', 'path', 'pathext', 'temp', 'tmp', 'userprofile', 'localappdata', 'appdata', 'programfiles', 'programfiles(x86)', 'programdata', 'allusersprofile', 'homedrive', 'homepath', 'os', 'number_of_processors', 'processor_architecture'].includes(key.toLowerCase())));
const generated = spawnSync(python, ['-X', 'utf8', '-B', '-c', String.raw`
import base64, copy, hashlib, io, json, sys
from pathlib import Path
from PIL import Image
root = Path.cwd()
sys.path.insert(0, str(root / "services/rendering"))
from editions import EbookEdition
from epub_renderer import render_epub
from epub_preview import preview_epub
book = json.loads((root / "tests/fixtures/books/valid_book.json").read_text())
art_id = "33333333-3333-4333-8333-333333333333"
art = io.BytesIO(); Image.new("RGB", (120, 180), "#234567").save(art, "PNG"); art = art.getvalue()
result = []
for ordinal, flow, marker in [(1, "reflowable", "Saved export one & exact <words> — native artifact."), (2, "reflowable", "Older export two — exact saved text."), (3, "fixed", "Fixed saved page — native raster.")]:
    current = copy.deepcopy(book); current["chapters"][0]["nodes"][1]["text"] = marker
    if flow == "reflowable":
        current["chapters"][1]["nodes"].append({"id": "n6-repeated", "type": "image", "assetId": art_id})
    edition_id = "e0000000-0000-4000-8000-00000000000" + ("2" if flow == "fixed" else "1")
    data = render_epub(current, EbookEdition(flow=flow, include_title_page=True, navigation="toc+landmarks", cover={"asset_id": art_id}), cover_bytes=art, image_bytes={art_id: art})[0]
    first = preview_epub(data)
    source = {"bookId": "88888888-8888-4888-8888-888888888888", "editionId": edition_id, "jobId": "a0000000-0000-4000-8000-00000000000" + str(ordinal), "assetId": "b0000000-0000-4000-8000-00000000000" + str(ordinal), "version": 1, "sha256": hashlib.sha256(data).hexdigest(), "sizeBytes": len(data)}
    sections = []; indices = set()
    for item in first["spine"]:
        response = preview_epub(data, item["index"])
        assert response["sourceSha256"] == source["sha256"] and response["sourceSizeBytes"] == len(data)
        indices.update(resource["index"] for resource in response["document"]["resources"])
        sections.append({"source": source, **{key: response[key] for key in ["formatVersion", "layout", "spine", "document", "warnings"]}})
    resources = {}
    for index in sorted(indices):
        response = preview_epub(data, resource_index=index)
        resources[str(index)] = {"source": source, "resource": response["resource"]}
    result.append({"source": source, "createdAt": "2026-10-10T00:0" + str(3-ordinal) + ":00.000Z", "sections": sections, "resources": resources, "base64": base64.b64encode(data).decode("ascii")})
print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
`], { cwd: process.cwd(), env: pythonEnvironment, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, windowsHide: true });
assert.equal(generated.status, 0, `native reader fixture generation failed: ${generated.error?.message ?? generated.stderr}`);
const artifacts = JSON.parse(generated.stdout);
for (const artifact of artifacts) {
  const bytes = Buffer.from(artifact.base64, 'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.source.sha256);
  assert.equal(bytes.length, artifact.source.sizeBytes);
  assert.ok(bytes.subarray(0, 2).equals(Buffer.from('PK')), 'fixture is not an actual EPUB ZIP');
}
const editions = ['reflowable', 'fixed'].map((flow, index) => ({ id: `e0000000-0000-4000-8000-00000000000${index + 1}`, book_id: artifacts[0].source.bookId, type: 'ebook', language: 'en', status: 'draft', edition_metadata_json: { kind: 'ebook', flow, include_title_page: true, navigation: 'toc+landmarks' }, updated_at: '2026-10-10T00:00:00.000Z' }));
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_TEST_CHANNEL ? { channel: process.env.BROWSER_TEST_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(60000);
  const errors = []; const readerRequests = []; const historyRequests = []; const explicitRenders = []; const mutations = []; const hostileRequests = [];
  let activeReaderGets = 0; let peakReaderGets = 0;
  page.on('pageerror', (error) => errors.push(error.message)); page.on('dialog', (dialog) => dialog.dismiss());
  page.on('request', (request) => { if (request.url().includes('reader-hostile.example')) hostileRequests.push(request.url()); });
  let mode = 'busy-section'; let heldResource; let releaseResource; let downloadTicket = 0; let readOnly = false;
  await page.route(`${fixtureOrigin}/fixture-reader-artifact?*`, async (route) => {
    const url = new URL(route.request().url()); const artifact = artifacts.find((entry) => entry.source.jobId === url.searchParams.get('jobId'));
    assert.ok(artifact); await route.fulfill({ status: 200, contentType: 'application/epub+zip', headers: { 'content-disposition': 'attachment; filename="saved-proof.epub"', 'cache-control': 'no-store' }, body: Buffer.from(artifact.base64, 'base64') });
  });
  await page.route(`${appOrigin}/api/backend/v1/**`, async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname.replace('/api/backend', '');
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
    // One explicit author click receives a synthetic completed render of the
    // actual saved fixture bytes. No backend render, paid provider or other
    // application mutation is permitted by this local acceptance journey.
    if (request.method() === 'POST' && path === `/v1/editions/${editions[0].id}/render`) {
      assert.equal(readOnly, false); assert.equal(explicitRenders.length, 0, 'render repeated without another explicit author action');
      const body = request.postDataJSON(); assert.deepEqual(Object.keys(body), ['idempotencyKey']);
      assert.match(body.idempotencyKey, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
      const artifact = artifacts[0]; explicitRenders.push({ path, idempotencyKey: body.idempotencyKey });
      return json(201, { jobId: artifact.source.jobId, status: 'succeeded', artifacts: [{ role: 'rendered_ebook', asset: {
        id: artifact.source.assetId, workspace_id: '33333333-3333-4333-8333-333333333333', folder_id: null, type: 'rendered_ebook', name: 'saved-proof.epub',
        storage_path: 'fixture/saved-proof.epub', mime_type: 'application/epub+zip', size_bytes: artifact.source.sizeBytes, checksum: artifact.source.sha256,
        status: 'approved', current_version_number: 1, created_by: '11111111-1111-4111-8111-111111111111', created_at: artifact.createdAt, updated_at: artifact.createdAt,
      }, download: { url: `${fixtureOrigin}/fixture-reader-artifact?jobId=${artifact.source.jobId}&ticket=render`, expiresIn: 300 } }] });
    }
    if (request.method() !== 'GET') { mutations.push({ method: request.method(), path }); return route.continue(); }
    if (readOnly && path === `/v1/books/${artifacts[0].source.bookId}`) {
      const response = await route.fetch(); assert.equal(response.status(), 200);
      return json(200, { ...await response.json(), role: 'viewer' });
    }
    if (path === `/v1/books/${artifacts[0].source.bookId}/editions`) return json(200, { editions });
    const history = /^\/v1\/editions\/([^/]+)\/renders$/.exec(path);
    if (history) { historyRequests.push(path); return json(200, { renders: artifacts.filter((entry) => entry.source.editionId === history[1]).map(({ source, createdAt }) => ({ source, jobId: source.jobId, createdAt })) }); }
    const reader = /^\/v1\/editions\/([^/]+)\/renders\/([^/]+)\/reader(?:\/resources\/(\d+))?$/.exec(path);
    if (reader) {
      activeReaderGets++; peakReaderGets = Math.max(peakReaderGets, activeReaderGets);
      try {
      const artifact = artifacts.find((entry) => entry.source.editionId === reader[1] && entry.source.jobId === reader[2]);
      assert.ok(artifact); assert.equal(url.searchParams.get('sha256'), artifact.source.sha256, 'GET omitted immutable source digest');
      readerRequests.push({ path, sha256: url.searchParams.get('sha256') });
      if (mode === 'busy-section' && !reader[3]) { mode = 'normal'; return await json(503, { error: { code: 'reader_busy', message: 'Synthetic bounded admission busy' } }); }
      if (mode === 'forbidden' && reader[3]) return await json(403, { error: { code: 'forbidden', message: 'Synthetic membership revoked' } });
      if (reader[3]) {
        const payload = artifact.resources[reader[3]]; assert.ok(payload);
        if (mode === 'hold-resource') { mode = 'normal'; heldResource?.(); await new Promise((resolve) => { releaseResource = resolve; }); }
        return await json(200, payload);
      }
      const payload = structuredClone(artifact.sections[Number(url.searchParams.get('spine'))]); assert.ok(payload);
      if (mode === 'wrong-source') { mode = 'normal'; payload.source.sha256 = 'f'.repeat(64); }
      if (mode === 'hostile-markup') { mode = 'normal'; payload.document.html += '<script>parent.__readerExecuted=true</script><img src="https://reader-hostile.example/leak">'; }
      return await json(200, payload);
      } finally { activeReaderGets--; }
    }
    const asset = /^\/v1\/assets\/([^/]+)\/download-url$/.exec(path);
    if (asset && artifacts.some((entry) => entry.source.assetId === asset[1])) {
      assert.equal(url.searchParams.get('versionNumber'), '1', 'download did not request exact version1');
      const artifact = artifacts.find((entry) => entry.source.assetId === asset[1]);
      return json(200, { url: `${fixtureOrigin}/fixture-reader-artifact?jobId=${artifact.source.jobId}&ticket=${++downloadTicket}`, expiresIn: 300 });
    }
    return route.continue();
  });
  await page.goto(`${appOrigin}/books/${artifacts[0].source.bookId}/publish`);
  await page.getByLabel('Email').fill('author@example.test'); await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/books\/88888888-8888-4888-8888-888888888888\/publish(?:\?|$)/);
  const desk = page.locator('[data-saved-epub-reader]'); await desk.waitFor();
  const proofDirectory = process.env.BROWSER_TEST_ARTIFACT_DIR ? resolve(process.env.BROWSER_TEST_ARTIFACT_DIR) : null;
  if (proofDirectory) await mkdir(proofDirectory, { recursive: true });
  const proof = async (name) => { if (proofDirectory) await desk.screenshot({ path: resolve(proofDirectory, name), animations: 'disabled' }); };
  const waitReader = async (jobId, sectionIndex) => {
    await expect(desk.getByLabel('Saved EPUB export')).toHaveValue(jobId);
    await expect(desk.getByLabel('Saved EPUB section')).toBeVisible();
    if (sectionIndex !== undefined) await expect(desk.getByLabel('Saved EPUB section')).toHaveValue(String(sectionIndex));
    await expect(desk.getByRole('status')).toHaveCount(0);
    await expect(desk.getByRole('alert')).toHaveCount(0);
    await expect(desk.locator('iframe')).toHaveCount(1);
  };
  await desk.getByRole('alert').filter({ hasText: 'The saved reader is busy.' }).waitFor();
  await desk.getByRole('button', { name: 'Retry saved section', exact: true }).click();
  const first = artifacts[0]; const opening = first.sections.findIndex((section) => section.document.title === 'Beginning'); assert.ok(opening >= 0);
  await waitReader(first.source.jobId, 0);
  await desk.getByLabel('Saved EPUB section').selectOption(String(opening));
  await waitReader(first.source.jobId, opening);
  const frame = desk.locator('iframe'); const content = desk.frameLocator('iframe');
  await content.getByText('Saved export one & exact <words> — native artifact.', { exact: true }).waitFor();
  assert.equal(await frame.getAttribute('sandbox'), ''); assert.equal(await frame.getAttribute('referrerpolicy'), 'no-referrer'); assert.equal(await frame.getAttribute('src'), null);
  const policy = await content.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  assert.equal(policy, "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  assert.equal(await page.evaluate(() => { try { document.querySelector('[data-saved-epub-reader] iframe').contentWindow.document; return false; } catch { return true; } }), true, 'saved frame gained same-origin access');
  await desk.getByLabel('Reader type').selectOption('sans'); await desk.getByLabel('Reader text size').selectOption('24'); await desk.getByLabel('Reader line spacing').selectOption('1.9');
  await expect(content.locator('body')).toHaveCSS('font-size', '24px');
  await desk.getByRole('button', { name: 'Next saved section', exact: true }).click();
  await content.getByText('All done.', { exact: true }).waitFor();
  await waitReader(first.source.jobId, opening + 1);
  const repeatedResource = first.sections[opening + 1].document.resources[0].index;
  const savedPng = first.resources[String(repeatedResource)].resource;
  const savedPngUrl = `data:${savedPng.mimeType};base64,${savedPng.base64}`;
  const savedImages = content.locator('img'); await expect(savedImages).toHaveCount(2);
  await savedImages.first().evaluate((image) => image.decode());
  assert.equal(await savedImages.first().getAttribute('src'), savedPngUrl);
  assert.equal(await savedImages.nth(1).getAttribute('src'), savedPngUrl, 'small repeated images changed or were silently deferred');
  await desk.getByLabel('Saved EPUB image occurrence').fill('2');
  await desk.getByRole('button', { name: 'Inspect occurrence', exact: true }).click();
  const inspector = desk.getByRole('region', { name: 'Selected saved illustration occurrence', exact: true });
  await expect(inspector.getByRole('heading')).toHaveText(`Occurrence 2 of 2 · Illustration ${repeatedResource + 1}`);
  assert.equal(await inspector.locator('img').getAttribute('src'), savedPngUrl, 'occurrence inspector changed exact saved raster bytes');
  await inspector.locator('img').evaluate((image) => image.decode());
  await proof('reader-desktop-reflow-loaded-png.png');
  await desk.getByRole('button', { name: 'Previous occurrence', exact: true }).click(); await expect(desk.getByLabel('Saved EPUB image occurrence')).toHaveValue('1');
  await desk.getByRole('button', { name: 'Next occurrence', exact: true }).click(); await expect(desk.getByLabel('Saved EPUB image occurrence')).toHaveValue('2');
  await desk.getByRole('button', { name: 'Release previews', exact: true }).click();
  await expect(content.getByText(/Illustration \d+ is not loaded/)).toHaveCount(2);
  await expect(inspector.locator('img')).toHaveCount(0);
  await desk.getByRole('button', { name: 'Load illustration', exact: true }).click(); await expect(savedImages).toHaveCount(2);
  await waitReader(first.source.jobId, opening + 1);
  // A delayed old image must not repopulate a newly selected saved export.
  const held = new Promise((resolve) => { heldResource = resolve; }); mode = 'hold-resource';
  await desk.getByRole('button', { name: 'Reload illustration', exact: true }).click();
  let heldDeadline;
  try { await Promise.race([held, new Promise((_, reject) => { heldDeadline = setTimeout(() => reject(new Error('held resource readiness timed out')), 30000); })]); }
  finally { clearTimeout(heldDeadline); }
  await desk.getByLabel('Saved EPUB export').selectOption(artifacts[1].source.jobId);
  assert.equal(await desk.locator('iframe').count(), 0, 'old saved bytes flashed after selection');
  assert.equal(await inspector.count(), 0, 'old saved occurrence inspector survived source selection');
  assert.equal(typeof releaseResource, 'function', 'held resource did not expose its release');
  releaseResource();
  await waitReader(artifacts[1].source.jobId, 0);
  await desk.getByLabel('Saved EPUB section').selectOption(String(opening)); await content.getByText('Older export two — exact saved text.', { exact: true }).waitFor();
  await waitReader(artifacts[1].source.jobId, opening);
  assert.equal(await content.getByText('Saved export one & exact <words> — native artifact.', { exact: true }).count(), 0);
  mode = 'wrong-source'; await desk.getByRole('button', { name: 'Next saved section', exact: true }).click();
  await desk.getByRole('alert').filter({ hasText: 'could not be read or verified' }).waitFor(); assert.equal(await desk.locator('iframe').count(), 0);
  await desk.getByRole('button', { name: 'Retry saved section', exact: true }).click(); await content.getByText('All done.', { exact: true }).waitFor();
  await waitReader(artifacts[1].source.jobId, opening + 1);
  mode = 'hostile-markup'; await desk.getByRole('button', { name: 'Previous saved section', exact: true }).click();
  await desk.getByRole('alert').filter({ hasText: 'could not be read or verified' }).waitFor(); assert.equal(await desk.locator('iframe').count(), 0);
  assert.equal(await page.evaluate(() => window.__readerExecuted), undefined); assert.deepEqual(hostileRequests, []);
  await desk.getByRole('button', { name: 'Retry saved section', exact: true }).click(); await content.getByText('Older export two — exact saved text.', { exact: true }).waitFor();
  await desk.getByRole('button', { name: 'Renew exact EPUB download', exact: true }).click();
  const privateLink = desk.getByRole('link', { name: 'Download saved EPUB v1', exact: true }); await privateLink.waitFor(); const firstUrl = await privateLink.getAttribute('href');
  const downloadEvent = page.waitForEvent('download'); await privateLink.click(); const download = await downloadEvent;
  assert.equal(await download.failure(), null); assert.equal(createHash('sha256').update(await readFile(await download.path())).digest('hex'), artifacts[1].source.sha256);
  await desk.getByRole('button', { name: 'Renew exact EPUB download', exact: true }).click(); await privateLink.waitFor(); assert.notEqual(await privateLink.getAttribute('href'), firstUrl);
  mode = 'forbidden'; await desk.getByRole('button', { name: 'Next saved section', exact: true }).click();
  await desk.getByRole('alert').filter({ hasText: 'Your session or access changed.' }).waitFor();
  assert.equal(await desk.locator('iframe').count(), 0); assert.equal(await desk.getByLabel('Saved EPUB export').count(), 0); assert.equal(await privateLink.count(), 0);
  mode = 'normal'; await desk.getByRole('button', { name: 'Refresh saved exports', exact: true }).click(); await desk.getByLabel('Saved EPUB section').waitFor();
  await waitReader(first.source.jobId, 0);
  // A synthetic viewer may read existing private exports but may not render or
  // save. This is UI role acceptance, not hosted membership verification.
  readOnly = true; await page.reload(); await waitReader(first.source.jobId, 0);
  await expect(page.getByRole('button', { name: 'Render EPUB', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save edition', exact: true })).toBeDisabled();
  await expect(desk.getByRole('button', { name: 'Renew exact EPUB download', exact: true })).toBeEnabled();
  readOnly = false; await page.reload(); await waitReader(first.source.jobId, 0);
  const editionButtons = page.getByRole('button', { name: /^ebook en · draft$/i });
  await expect(editionButtons).toHaveCount(2);
  // The actual edition buttons expose kind/language/status, not saved flow.
  // Fixture order is explicit; verify the selected saved flow and exact source.
  await editionButtons.nth(1).click(); await expect(page.getByRole('combobox', { name: 'Flow', exact: true })).toHaveValue('fixed');
  await desk.getByLabel('Fixed page zoom').waitFor(); await content.locator('img').waitFor();
  const fixedArtifact = artifacts[2]; const resource = fixedArtifact.resources[String(fixedArtifact.sections[0].document.resources[0].index)].resource;
  await waitReader(fixedArtifact.source.jobId, 0);
  assert.equal(await content.locator('img').getAttribute('src'), `data:${resource.mimeType};base64,${resource.base64}`, 'fixed preview changed saved raster bytes');
  assert.equal(await content.locator('img').evaluate((image) => getComputedStyle(image).objectFit), 'contain');
  await content.locator('img').evaluate((image) => image.decode()); await proof('reader-desktop-fixed.png');
  await page.setViewportSize({ width: 390, height: 844 }); await expect(desk.getByLabel('Fixed page zoom')).toHaveValue('100');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  assert.equal(await desk.evaluate((element) => {
    const bounds = element.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth;
  }), true, 'saved proof desk exceeds the mobile viewport at fit zoom');
  assert.equal(await desk.getByLabel('Saved EPUB illustration').evaluate((element) => element.getBoundingClientRect().width >= 180), true, 'mobile illustration selector collapsed beside its actions');
  await proof('reader-mobile-fixed-fit.png');
  await desk.getByLabel('Fixed page zoom').selectOption('200'); await expect(desk.getByLabel('Fixed page zoom')).toHaveValue('200');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), { message: 'saved fixed-page zoom caused mobile body overflow' }).toBe(true);
  const scrollArea = desk.getByRole('region', { name: 'Saved fixed-page scroll area', exact: true });
  await expect.poll(() => scrollArea.evaluate((stage) => stage.scrollWidth > stage.clientWidth && getComputedStyle(stage).overflowX === 'auto'), { message: '200% fixed page must scroll inside the reader, not enlarge the document' }).toBe(true);
  await scrollArea.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(() => scrollArea.evaluate((stage) => stage.scrollLeft), { message: 'zoomed saved page must remain keyboard-scrollable' }).toBeGreaterThan(0);
  await proof('reader-mobile-fixed-zoom.png');
  const nav = fixedArtifact.sections.find((section) => section.document.layout === 'reflowable'); assert.ok(nav);
  await desk.getByLabel('Saved EPUB section').selectOption(String(nav.document.index)); await desk.getByLabel('Reader text size').waitFor();
  await waitReader(fixedArtifact.source.jobId, nav.document.index);
  assert.equal(await content.locator('[href],script,iframe,form,input,button').count(), 0, 'saved nav retained active controls');
  await proof('reader-mobile-fixed-reflow-nav.png');
  // A successful parent render must refresh saved history once. Subsequent
  // unsaved settings invalidate package proof, not the chosen older snapshot.
  await editionButtons.nth(0).click(); await expect(page.getByRole('combobox', { name: 'Flow', exact: true })).toHaveValue('reflowable');
  await waitReader(first.source.jobId, 0);
  const historyBeforeRender = historyRequests.length;
  await page.getByRole('button', { name: 'Render EPUB', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Private render completed.' }).waitFor();
  await expect.poll(() => historyRequests.length).toBe(historyBeforeRender + 1);
  await waitReader(first.source.jobId, 0); assert.equal(explicitRenders.length, 1);
  await expect(page.getByRole('link', { name: 'Download private file', exact: true })).toHaveCount(1);
  await desk.getByLabel('Saved EPUB export').selectOption(artifacts[1].source.jobId); await waitReader(artifacts[1].source.jobId, 0);
  await desk.getByLabel('Saved EPUB section').selectOption(String(opening)); await waitReader(artifacts[1].source.jobId, opening);
  await content.getByText('Older export two — exact saved text.', { exact: true }).waitFor();
  const savedBeforeEdit = await frame.getAttribute('srcdoc'); const historyBeforeEdit = historyRequests.length; const readsBeforeEdit = readerRequests.length;
  await page.getByRole('combobox', { name: 'Navigation', exact: true }).selectOption('none');
  await desk.getByText(/Unsaved edition settings are not included/).waitFor();
  await expect(page.getByRole('button', { name: 'Render EPUB', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Create retailer package', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Download private file', exact: true })).toHaveCount(0, { timeout: 30000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await waitReader(artifacts[1].source.jobId, opening);
  await content.getByText('Older export two — exact saved text.', { exact: true }).waitFor();
  assert.equal(await frame.getAttribute('srcdoc'), savedBeforeEdit, 'unsaved settings replaced exact saved reader bytes');
  assert.equal(historyRequests.length, historyBeforeEdit, 'unsaved settings refreshed saved export history');
  assert.equal(readerRequests.length, readsBeforeEdit, 'unsaved settings reread a saved section or illustration');
  const focusControl = desk.getByRole('button', { name: 'Refresh saved exports', exact: true }); await focusControl.focus();
  assert.equal(await focusControl.evaluate((element) => document.activeElement === element), true);
  assert.equal(await focusControl.evaluate((element) => element.getBoundingClientRect().height >= 44), true, 'reader touch target below44px');
  assert.equal(explicitRenders.length, 1, 'completed-render regression did not exercise exactly one explicit fixture render');
  assert.deepEqual(mutations, [], 'saved reading performed an unapproved application mutation or paid generation'); assert.deepEqual(errors, []);
  assert.equal(historyRequests.length, historyBeforeEdit); assert.equal(readerRequests.length, readsBeforeEdit);
  assert.ok(readerRequests.length > 8, 'saved-artifact reading journey did not exercise enough requests');
  assert.equal(activeReaderGets, 0); assert.equal(peakReaderGets, 1, 'reader GETs were not serialized under fixed admission');
  console.log('Saved EPUB reader browser passed: native reflow/fixed bytes, exact SHA/v1 download, safe sandbox/CSP, retry, stale rejection, permission clearing, repeated-image occurrence inspection, serialized GETs, mobile fit/zoom, older saved snapshot retained after completed-render and unsaved settings. Synthetic membership/history/completed render only; hosted/provider/retailer acceptance remains open.');
} finally { await browser.close(); }
