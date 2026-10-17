/** Real Publishing Studio controls against the runner-owned services. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect as playwrightExpect } from '@playwright/test';
import { localFetch, requireNativeAuthorRunner } from './native-author-files-guard.mjs';
import { nativeBrowserJson } from './native-author-files-browser.mjs';

const expect = playwrightExpect.configure({ timeout: 30_000 });

async function download(page, link, checksum) {
  const transferred = page.waitForEvent('download');
  await link.click();
  const file = await transferred;
  assert.equal(await file.failure(), null);
  const bytes = await readFile(await file.path());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), checksum);
  return bytes;
}

export async function runNativePublishingBrowser({ page, bookId, passage, screenshot, origins, onStage }) {
  requireNativeAuthorRunner();
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/books/${bookId}/publish`);
  await expect(page.getByRole('heading', { name: 'Layout & publishing', exact: true })).toBeVisible();
  const chapters = await page.evaluate(async id => {
    const response = await fetch(`/api/backend/v1/books/${id}/chapters`);
    return { status: response.status, body: await response.json() };
  }, bookId);
  assert.equal(chapters.status, 200);
  const imported = chapters.body.chapters.filter(chapter => chapter.title !== 'Browser review');
  assert.equal(imported.length, 1);
  for (const kind of ['ebook', 'print']) {
    onStage(`native ${kind} edition save and reload`);
    await page.getByRole('button', { name: kind === 'ebook' ? 'New EPUB' : 'New print', exact: true }).click();
    if (kind === 'print') {
      await page.getByRole('combobox', { name: 'Body font', exact: true }).selectOption('BookwormVera');
      await page.getByRole('combobox', { name: 'Heading font', exact: true }).selectOption('BookwormVera-Bold');
    }
    const [created] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/books/${bookId}/editions`) && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Save edition', exact: true }).click(),
    ]);
    assert.equal(created.status(), 201);
    const edition = await created.json();
    await expect(page.getByText('Edition settings saved.', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: new RegExp(`^${kind} `, 'i') }).click();
    await expect(page.getByRole('combobox', { name: 'Format', exact: true })).toHaveValue(kind);
    if (kind === 'print') {
      await expect(page.getByRole('combobox', { name: 'Body font', exact: true })).toHaveValue('BookwormVera');
      await expect(page.getByRole('combobox', { name: 'Heading font', exact: true })).toHaveValue('BookwormVera-Bold');
    }
    onStage(`native ${kind} browser render`);
    const [rendered] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/editions/${edition.id}/render`) && response.request().method() === 'POST', { timeout: 90_000 }),
      page.getByRole('button', { name: kind === 'ebook' ? 'Render EPUB' : 'Render PDF', exact: true }).click(),
    ]);
    assert.equal(rendered.status(), 201);
    const result = await rendered.json();
    assert.equal(result.status, 'succeeded');
    const artifact = result.artifacts.find(item => item.role === (kind === 'ebook' ? 'rendered_ebook' : 'rendered_print'));
    assert.ok(artifact);
    await expect(page.getByText('Private render completed.', { exact: true })).toBeVisible();

    if (kind === 'ebook') {
      onStage('native saved EPUB browser text, image and exact download');
      const desk = page.getByRole('region', { name: 'Saved EPUB proof', exact: true });
      const sections = desk.getByRole('combobox', { name: 'Saved EPUB section', exact: true });
      const selectChapter = async title => {
        await expect(sections).toBeVisible();
        const values = await sections.locator('option').evaluateAll((options, title) => options.filter(option => option.textContent.endsWith(`. ${title}`)).map(option => option.value), title);
        assert.equal(values.length, 1, 'Saved chapter missing or ambiguous in the visible reader');
        await sections.selectOption(values[0]);
      };
      await selectChapter('Browser review');
      await expect(desk.frameLocator('iframe').getByText(passage, { exact: true })).toBeVisible();
      await selectChapter(imported[0].title);
      await expect(desk.frameLocator('iframe').getByText('Captain', { exact: true })).toBeVisible();
      await expect(desk.frameLocator('iframe').locator('img')).toHaveCount(1);
      await expect.poll(() => desk.frameLocator('iframe').locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
      await expect(desk.locator('iframe')).toHaveAttribute('sandbox', '');
      await desk.getByRole('button', { name: 'Renew exact EPUB download', exact: true }).click();
      await download(page, desk.getByRole('link', { name: 'Download saved EPUB v1', exact: true }), artifact.asset.checksum);
      await screenshot('publishing-epub-desktop');
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot('publishing-epub-mobile');
      await page.setViewportSize({ width: 1280, height: 900 });
    } else {
      onStage('native saved print browser reopen and exact download');
      await page.reload();
      await page.getByRole('button', { name: /^print /i }).click();
      await page.getByRole('button', { name: 'Open saved print', exact: true }).click();
      await expect(page.getByText('Saved print proof opened. Run fresh preflight before creating a package.', { exact: true })).toBeVisible();
      const link = page.getByRole('link', { name: 'Download private file', exact: true });
      const attachmentUrl = new URL(await link.getAttribute('href'));
      const previewUrl = new URL(await page.getByTitle('Rendered print edition preview', { exact: true }).getAttribute('src'));
      assert.equal(previewUrl.searchParams.has('download'), false);
      assert.equal(attachmentUrl.searchParams.get('download'), artifact.asset.name);
      const original = new URL(attachmentUrl); original.searchParams.delete('download');
      assert.equal(original.href, previewUrl.href);
      // The headless shell downloads inline PDFs too; require Storage's real attachment header.
      const attachment = await localFetch(origins)(attachmentUrl.href);
      assert.equal(attachment.status, 200);
      assert.match(attachment.headers.get('content-disposition') ?? '', /^attachment(?:;|$)/i);
      assert.equal(createHash('sha256').update(Buffer.from(await attachment.arrayBuffer())).digest('hex'), artifact.asset.checksum);
      const location = page.url();
      await download(page, link, artifact.asset.checksum);
      assert.equal(page.url(), location);
      await expect(page.getByRole('button', { name: 'Renew private links', exact: true })).toBeEnabled();
      await screenshot('publishing-print-desktop');
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot('publishing-print-mobile');
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    onStage(`native ${kind} browser preflight and manual-submission boundary`);
    const [validated] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/publishing/validate') && response.request().method() === 'POST', { timeout: 90_000 }),
      page.getByRole('button', { name: 'Run preflight', exact: true }).click(),
    ]);
    assert.equal(validated.status(), 201);
    const preflight = await validated.json();
    assert.equal(preflight.requestedChannel, 'export');
    await expect(page.getByText(`${preflight.errors} errors`, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create retailer package', exact: true })).toBeDisabled();
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    console.log(`PASS native browser ${kind} save/reload, private render, saved proof, exact download, preflight and mobile containment`);
  }
}

/** The accepted native fixture supplies artwork, approval and a non-AI export
 * entitlement. Every new render, preflight and ZIP below is created by the UI. */
export async function runNativeRetailerBrowser({ page, retailer, service, screenshot, onStage }) {
  requireNativeAuthorRunner();
  const origin = new URL(page.url()).origin;
  const publishUrl = `${origin}/books/${retailer.bookId}/publish`;
  const { inspectNativePackage } = await import('./native-author-files-packages.mjs');
  const requests = [];
  const observe = request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && (/\/publishing\/(jobs|validate)$/.test(path) || /\/editions\/[^/]+\/render$/.test(path))) requests.push(path);
  };
  page.on('request', observe);
  const api = async (method, path) => {
    const result = await page.evaluate(async ({ method, path }) => {
      const response = await fetch(`/api/backend/v1${path}`, { method,
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
      return { status: response.status, body: await response.json() };
    }, { method, path });
    assert.equal(result.status, 200, `Native browser ${method} returned an unexpected status`);
    return result.body;
  };
  const select = async edition => {
    const { editions } = await api('GET', `/books/${retailer.bookId}/editions`);
    const index = editions.findIndex(value => value.id === edition.id);
    assert.ok(index >= 0);
    await page.locator('aside').getByRole('button').nth(index).click();
    await expect(page.getByRole('combobox', { name: 'Format', exact: true })).toHaveValue(edition.kind);
  };
  const history = page.getByRole('region', { name: 'Retailer export packages', exact: true });
  const packages = [];
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(publishUrl);
    await expect(page.getByRole('heading', { name: 'Layout & publishing', exact: true })).toBeVisible();
    for (const edition of retailer.editions) {
      onStage(`retailer browser ${edition.kind} saved edition selection and rendering`);
      await select(edition);
      await expect(page.getByRole('checkbox', { name: 'Add QR code', exact: true })).toBeChecked();
      await expect(page.getByLabel('HTTPS destination', { exact: true })).toHaveValue('https://example.com/harbor');
      const [rendered] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/editions/${edition.id}/render`) && response.request().method() === 'POST', { timeout: 90_000 }),
        page.getByRole('button', { name: edition.kind === 'ebook' ? 'Render EPUB' : 'Render PDF', exact: true }).click(),
      ]);
      assert.equal(rendered.status(), 201);
      const render = await nativeBrowserJson(rendered);
      assert.equal(render.status, 'succeeded');
      await expect(page.getByText('Private render completed.', { exact: true })).toBeVisible();
      for (const channel of edition.channels) {
        onStage(`retailer browser ${channel} ${edition.kind} preflight and package creation`);
        await page.getByRole('combobox', { name: 'Preflight target', exact: true }).selectOption(channel);
        const [validated] = await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/publishing/validate') && response.request().method() === 'POST', { timeout: 90_000 }),
          page.getByRole('button', { name: 'Run preflight', exact: true }).click(),
        ]);
        assert.equal(validated.status(), 201);
        const preflight = await nativeBrowserJson(validated);
        assert.equal(preflight.errors, 0); assert.equal(preflight.requestedChannel, channel);
        const loseReply = packages.length === 6;
        if (loseReply) await page.evaluate(() => {
          const original = window.fetch;
          window.fetch = async (...args) => {
            const result = await original(...args);
            if (String(args[0]).endsWith('/publishing/jobs') && args[1]?.method === 'POST' && result.ok) {
              window.fetch = original;
              // The real server has answered. Simulate loss only on the client;
              // no response body, account, package or usage record is fabricated.
              throw new TypeError('Connection lost after saved export');
            }
            return result;
          };
        });
        const [created] = await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/publishing/jobs') && response.request().method() === 'POST', { timeout: 90_000 }),
          history.getByRole('button', { name: 'Create retailer package', exact: true }).click(),
        ]);
        onStage(`retailer browser ${channel} ${edition.kind} package response body`);
        assert.equal(created.status(), 201);
        const job = await nativeBrowserJson(created);
        assert.equal(job.status, 'succeeded'); assert.equal(job.submissionMode, 'manual');
        assert.equal(job.sourceRenderJobId, render.jobId); assert.equal(job.sourcePreflightJobId, preflight.jobId);
        if (loseReply) {
          onStage('retailer browser lost reply, reload and read-only original request recovery');
          await expect(page.getByText(/Connection lost after saved export/)).toBeVisible();
          const pending = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('bookworm:package:')).map(([, value]) => JSON.parse(value)));
          assert.equal(pending.length, 1); assert.equal(pending[0].request.idempotencyKey, job.requestId);
          assert.deepEqual(Object.keys(pending[0]).sort(), ['request', 'schema', 'userId']);
          onStage('retailer browser lost reply reload');
          await page.reload();
          onStage('retailer browser lost reply saved edition selection');
          await select(edition);
          onStage('retailer browser original request status lookup');
          const [recovered] = await Promise.all([
            page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/publishing/requests/${job.requestId}`) && response.request().method() === 'GET'),
            page.getByRole('button', { name: 'Recover saved export', exact: true }).click(),
          ]);
          assert.equal(recovered.status(), 200); assert.equal((await nativeBrowserJson(recovered)).job.id, job.id);
          await expect(page.getByText(/Saved export confirmed/)).toBeVisible();
          assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('bookworm:package:'))), false);
          console.log('PASS native browser lost accepted export reply recovered after reload with one original package request');
        } else await expect(page.getByText(`${channel} package is ready for manual submission.`, { exact: true })).toBeVisible();
        onStage(`retailer browser ${channel} ${edition.kind} exact private ZIP download`);
        const row = history.getByRole('listitem').first();
        await expect(row.getByText('ready', { exact: true })).toBeVisible();
        const bytes = await download(page, row.getByRole('link', { name: 'Download private ZIP', exact: true }), job.package.asset.checksum);
        assert.equal(page.url(), publishUrl, 'ZIP download replaced the author interface');
        const archive = inspectNativePackage(bytes);
        assert.equal(archive.manifest.channel, channel); assert.equal(archive.preflight.errors, 0);
        for (const { role, asset } of render.artifacts) {
          const name = role === 'rendered_cover' ? (edition.kind === 'ebook' ? 'cover.png' : 'cover.pdf')
            : edition.kind === 'ebook' ? 'book.epub' : 'book.pdf';
          assert.equal(archive.files[name].sha256, asset.checksum);
        }
        assert.match(archive.readme, /NOT been submitted, published or approved/);
        packages.push({ job, edition });
        console.log(`PASS native browser ${channel} ${edition.kind} package creation and exact private ZIP download`);
      }
    }
    assert.equal(requests.filter(path => path.endsWith('/publishing/jobs')).length, 7);
    assert.equal(requests.filter(path => path.endsWith('/publishing/validate')).length, 7);
    assert.equal(requests.filter(path => path.endsWith('/render')).length, 4);
    const mutations = requests.length;
    const saved = packages[0];
    onStage('retailer browser reload and saved package history');
    await page.reload();
    await select(saved.edition);
    const { jobs } = await api('GET', `/publishing/jobs?bookId=${retailer.bookId}`);
    const index = jobs.filter(job => job.editionId === saved.edition.id).findIndex(job => job.id === saved.job.id);
    assert.ok(index >= 0);
    const row = history.getByRole('listitem').nth(index);
    await download(page, row.getByRole('link', { name: 'Download private ZIP', exact: true }), saved.job.package.asset.checksum);
    onStage('retailer browser deleted package history');
    await api('DELETE', `/assets/${saved.job.package.asset.id}`);
    await history.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(row.getByText('unavailable', { exact: true })).toBeVisible();
    await expect(row.getByRole('link', { name: 'Download private ZIP', exact: true })).toHaveCount(0);
    await expect(row.getByText(/This job is saved in history, but its file is currently unavailable/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot('retailer-unavailable-mobile');
    onStage('retailer browser restored exact package download');
    await api('POST', `/assets/${saved.job.package.asset.id}/restore`);
    await history.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(row.getByText('ready', { exact: true })).toBeVisible();
    await download(page, row.getByRole('link', { name: 'Download private ZIP', exact: true }), saved.job.package.asset.checksum);
    await screenshot('retailer-restored-mobile');
    await page.setViewportSize({ width: 1280, height: 900 });
    await screenshot('retailer-history-desktop');
    assert.equal(requests.length, mutations, 'History recovery must not render, validate or package again');
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    const usage = await service.from('usage_events').select('meter,quantity');
    assert.equal(usage.error, null); assert.equal(usage.data.length, 26);
    for (const [meter, count] of [['rendering', 12], ['publishing', 14]]) assert.equal(usage.data.filter(row => row.meter === meter).length, count);
    assert.ok(usage.data.every(row => Number(row.quantity) === 1));
    for (const table of ['ai_jobs', 'credit_ledger']) {
      const result = await service.from(table).select('id');
      assert.equal(result.error, null); assert.deepEqual(result.data, []);
    }
    console.log('PASS native browser seven packages, read-only history recovery, unavailable/restored ZIP, exact usage and zero AI or credit charges');
  } finally { page.off('request', observe); }
}
