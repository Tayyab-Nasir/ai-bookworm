/** Real Publishing Studio controls against the runner-owned services. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect as playwrightExpect } from '@playwright/test';
import { localFetch, requireNativeAuthorRunner } from './native-author-files-guard.mjs';
import { nativeBrowserJson } from './native-author-files-browser.mjs';

const expect = playwrightExpect.configure({ timeout: 30_000 });

/** Inject a client-only loss after the real server response has fully arrived. */
export function discardNextPackageReply() {
  const original = window.fetch;
  window.fetch = async (...args) => {
    const result = await original(...args);
    if (String(args[0]).endsWith('/publishing/jobs') && args[1]?.method === 'POST' && result.ok) {
      window.fetch = original;
      // Drain the real body before dropping it. Leaving an unread streaming
      // response can keep Playwright's response.json() pending on native CI.
      await result.arrayBuffer();
      throw new TypeError('Connection lost after saved export');
    }
    return result;
  };
}

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
      await download(page, desk.getByRole('button', { name: 'Download saved EPUB v1', exact: true }), artifact.asset.checksum);
      await screenshot('publishing-epub-desktop');
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot('publishing-epub-mobile');
      await page.setViewportSize({ width: 1280, height: 900 });
    } else {
      onStage('native saved print browser reopen and exact download');
      await page.reload();
      await page.getByRole('button', { name: /^print /i }).click();
      await page.getByRole('button', { name: 'Open saved print', exact: true }).click();
      await expect(page.getByText(/Package source · Saved print PDF/)).toContainText(artifact.asset.checksum.slice(0, 12));
      const link = page.getByRole('button', { name: 'Download private file', exact: true });
      const desk = page.getByRole('region', { name: 'Saved PDF page proof', exact: true });
      const image = desk.getByRole('img');
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate(node => node.complete && node.naturalWidth >= 720)).toBe(true);
      assert.match(await image.getAttribute('src'), /^data:image\/png;base64,/);
      assert.equal(await page.getByTitle('Rendered print edition preview', { exact: true }).count(), 0);
      await desk.getByRole('button', { name: 'Next page', exact: true }).click();
      await expect(desk.getByRole('img')).toHaveAttribute('alt', /^Saved interior, page 2 of /);
      await expect.poll(() => desk.getByRole('img').evaluate(node => node.complete && node.naturalWidth >= 720)).toBe(true);
      await desk.getByRole('button', { name: 'Previous page', exact: true }).click();
      await expect(desk.getByRole('img')).toHaveAttribute('alt', /^Saved interior, page 1 of /);
      // The signed URL is kept out of the DOM. Observe the actual Storage request
      // triggered by the explicit click and retain both inline and attachment checks.
      const request = page.waitForEvent('request', { predicate: value => {
        const url = new URL(value.url());
        return url.pathname.includes(artifact.asset.id) && url.searchParams.get('download') === artifact.asset.name;
      } });
      const location = page.url();
      await download(page, link, artifact.asset.checksum);
      const attachmentUrl = new URL((await request).url());
      assert.equal(attachmentUrl.searchParams.get('download'), artifact.asset.name);
      const original = new URL(attachmentUrl); original.searchParams.delete('download');
      const originalResponse = await localFetch(origins)(original.href);
      assert.equal(originalResponse.status, 200);
      assert.equal(createHash('sha256').update(Buffer.from(await originalResponse.arrayBuffer())).digest('hex'), artifact.asset.checksum);
      // The headless shell downloads inline PDFs too; require Storage's real attachment header.
      const attachment = await localFetch(origins)(attachmentUrl.href);
      assert.equal(attachment.status, 200);
      assert.match(attachment.headers.get('content-disposition') ?? '', /^attachment(?:;|$)/i);
      assert.equal(createHash('sha256').update(Buffer.from(await attachment.arrayBuffer())).digest('hex'), artifact.asset.checksum);
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
  const portals = {
    kdp: ['KDP Bookshelf', 'https://kdp.amazon.com/en_US/bookshelf'],
    apple: ['Apple Books Publishing Portal', 'https://authors.apple.com/epub-upload'],
    barnesnoble: ['B&N Press', 'https://press.barnesandnoble.com/'],
    lulu: ['Lulu print book projects', 'https://www.lulu.com/create/print-books'],
    googleplay: ['Google Play Books Partner Center', 'https://play.google.com/books/publish/'],
  };
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
  let finishedCover;
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(publishUrl);
    await expect(page.getByRole('heading', { name: 'Layout & publishing', exact: true })).toBeVisible();
    for (const edition of retailer.editions) {
      onStage(`retailer browser ${edition.kind} saved edition selection and rendering`);
      await select(edition);
      await expect(page.getByRole('checkbox', { name: 'Add QR code', exact: true })).toBeChecked();
      await expect(page.getByLabel('HTTPS destination', { exact: true })).toHaveValue('https://example.com/harbor');
      if (edition.isbn13) {
        await expect(page.getByRole('textbox', { name: 'Print ISBN-13', exact: true })).toHaveValue(edition.isbn13);
        await expect(page.getByRole('combobox', { name: 'ISBN barcode', exact: true })).toHaveValue(edition.barcode);
      }
      const [rendered] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/editions/${edition.id}/render`) && response.request().method() === 'POST', { timeout: 90_000 }),
        page.getByRole('button', { name: edition.kind === 'ebook' ? 'Render EPUB' : 'Render PDF', exact: true }).click(),
      ]);
      assert.equal(rendered.status(), 201);
      const render = await nativeBrowserJson(rendered);
      assert.equal(render.status, 'succeeded');
      await expect(page.getByText('Private render completed.', { exact: true })).toBeVisible();
      if (edition.kind === 'print' && edition.channels.includes('barnesnoble')) {
        const cover = render.artifacts.find(artifact => artifact.role === 'rendered_cover');
        assert.equal(cover.asset.mime_type, 'application/pdf');
        const readPrivateFile = localFetch(new Set([new URL(service.supabaseUrl).origin]));
        const response = await readPrivateFile(cover.download.url);
        assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(createHash('sha256').update(bytes).digest('hex'), cover.asset.checksum);
        finishedCover = { bytes, checksum: cover.asset.checksum, workspaceId: cover.asset.workspace_id, edition };
      }
      let sourceEpub, sourcePrint;
      if (edition.kind === 'ebook') {
        const originalCount = requests.filter(path => path.endsWith(`/editions/${edition.id}/render`)).length;
        sourceEpub = { jobId: render.jobId, sha256: render.artifacts.find(artifact => artifact.role === 'rendered_ebook').asset.checksum };
        onStage('retailer browser reopens a saved EPUB for packaging after reload');
        await page.reload();
        await select(edition);
        const desk = page.getByRole('region', { name: 'Saved EPUB proof', exact: true });
        await desk.getByRole('combobox', { name: 'Saved EPUB export', exact: true }).selectOption(render.jobId);
        await desk.getByRole('button', { name: 'Use this EPUB for packaging', exact: true }).click();
        await expect(history.getByText(/Package source · Saved EPUB/)).toContainText(sourceEpub.sha256.slice(0, 12));
        assert.equal(requests.filter(path => path.endsWith(`/editions/${edition.id}/render`)).length, originalCount);
      } else {
        sourcePrint = { jobId: render.jobId, sha256: render.artifacts.find(artifact => artifact.role === 'rendered_print').asset.checksum,
          coverSha256: render.artifacts.find(artifact => artifact.role === 'rendered_cover')?.asset.checksum ?? null };
        onStage('retailer browser reopens a saved print proof after reload');
        await page.reload();
        await select(edition);
        const savedRow = page.getByRole('region', { name: 'Saved print proofs', exact: true }).getByRole('listitem')
          .filter({ hasText: sourcePrint.sha256.slice(0, 16) }).first();
        await savedRow.getByRole('button', { name: 'Open saved print', exact: true }).click();
        await expect(history.getByText(/Package source · Saved print PDF/)).toContainText(sourcePrint.sha256.slice(0, 12));
      }
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
        assert.deepEqual(preflight.sourceEpub, sourceEpub);
        assert.deepEqual(preflight.sourcePrint, sourcePrint);
        const bnPolicyCodes = ['BN-CATALOG-ELIGIBILITY', 'BN-PRINT-MINIMUM-PRICE'];
        const bnPolicyFindings = preflight.findings.filter(item => bnPolicyCodes.includes(item.code));
        if (channel === 'barnesnoble') {
          const expectedCodes = edition.kind === 'print' ? bnPolicyCodes : bnPolicyCodes.slice(0, 1);
          assert.match(preflight.ruleVersion, /\+barnesnoble-1\.4\.0$/);
          assert.deepEqual(bnPolicyFindings.map(item => item.code).sort(), expectedCodes);
          for (const finding of bnPolicyFindings) {
            assert.equal(finding.severity, 'warning');
            await expect(page.getByText(finding.message, { exact: false })).toBeVisible();
          }
        } else {
          assert.deepEqual(bnPolicyFindings, []);
        }
        if (channel === 'barnesnoble' && edition.kind === 'ebook') {
          assert.ok(!preflight.findings.some(item => item.code === 'BN-EPUBCHECK-NO-ARTIFACT'));
        }
        const review = history.getByText('Review retailer listing', { exact: true });
        await review.click();
        await expect(history.locator('details dd').filter({ hasText: preflight.listing.metadata.title }).first()).toBeVisible();
        const loseReply = packages.length === 6;
        if (loseReply) await page.evaluate(discardNextPackageReply);
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
        onStage(`retailer browser ${channel} ${edition.kind} exact package history row`);
        const row = history.locator(`#package-${job.id}`);
        await expect(row.getByText('ready', { exact: true })).toBeVisible();
        const checksum = job.package.asset.checksum;
        await expect(row).toContainText(checksum.slice(0, 12));
        onStage(`retailer browser ${channel} ${edition.kind} package portal`);
        const [label, href] = portals[channel];
        const portal = row.getByRole('link', { name: label, exact: true });
        assert.equal(await portal.getAttribute('href'), href);
        assert.equal(await portal.getAttribute('target'), '_blank');
        onStage(`retailer browser ${channel} ${edition.kind} exact private ZIP download`);
        const bytes = await download(page, row.getByRole('button', { name: 'Download private ZIP', exact: true }), checksum);
        assert.equal(page.url(), publishUrl, 'ZIP download replaced the author interface');
        onStage(`retailer browser ${channel} ${edition.kind} exact private ZIP contents`);
        const archive = inspectNativePackage(bytes, { scanCovers: true });
        assert.equal(archive.manifest.channel, channel); assert.equal(archive.preflight.errors, 0);
        const coverName = edition.kind === 'ebook' ? 'cover.png' : 'cover.pdf';
        assert.deepEqual(archive.coverQr[coverName], ['https://example.com/harbor'], `${channel} ${coverName} QR destination`);
        assert.deepEqual(
          archive.preflight.findings.filter(item => bnPolicyCodes.includes(item.code)),
          bnPolicyFindings,
          'the downloaded ZIP must preserve the reviewed B&N warnings',
        );
        assert.deepEqual(archive.metadata, preflight.listing);
        if (channel === 'kdp' && edition.kind === 'ebook') {
          assert.deepEqual(archive.coverQr['cover.jpg'], ['https://example.com/harbor'], 'Kindle upload JPEG QR destination');
          assert.equal(archive.files['cover.jpg'].signature, 'ffd8ff');
          assert.equal(archive.manifest.files['cover.jpg'], archive.files['cover.jpg'].sha256);
          assert.match(archive.readme, /Upload book\.epub and cover\.jpg/);
          assert.match(archive.readme, /up to seven keywords or phrases and up to three categories/);
          assert.match(archive.readme, /description at 4,000 characters or fewer/);
        }
        if (channel === 'barnesnoble' && edition.kind === 'ebook') {
          assert.equal(archive.manifest.ruleVersion, preflight.ruleVersion);
          assert.match(archive.readme, /upload book\.epub in your eBook project/);
          assert.match(archive.readme, /B&N Press generative AI questions/);
        }
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
    assert.ok(jobs.some(job => job.id === saved.job.id && job.editionId === saved.edition.id));
    const row = history.locator(`#package-${saved.job.id}`);
    const checksum = saved.job.package.asset.checksum;
    const savedBytes = await download(page, row.getByRole('button', { name: 'Download private ZIP', exact: true }), checksum);
    const savedListing = await api('GET', `/publishing/jobs/${saved.job.id}/listing?checksum=${checksum}`);
    assert.deepEqual(savedListing.metadata, inspectNativePackage(savedBytes).metadata.metadata);
    const listingToggle = row.getByText('Copy package listing', { exact: true });
    await listingToggle.click();
    await expect(row.getByText(savedListing.metadata.description, { exact: true })).toBeVisible();
    await listingToggle.click();
    const expectedReport = await api('GET', `/publishing/jobs/${saved.job.id}/preflight`);
    assert.equal(expectedReport.preflightJobId, saved.job.sourcePreflightJobId);
    const reportToggle = row.getByText('Review package preflight', { exact: true });
    await reportToggle.click();
    await expect(row.getByText(`Rules ${expectedReport.ruleVersion}`, { exact: true })).toBeVisible();
    await reportToggle.click();
    onStage('retailer browser deleted package history');
    await api('DELETE', `/assets/${saved.job.package.asset.id}`);
    await history.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(row.getByText('unavailable', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Download private ZIP', exact: true })).toHaveCount(0);
    await expect(row.getByText(/This job is saved in history, but its file is currently unavailable/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot('retailer-unavailable-mobile');
    onStage('retailer browser restored exact package download');
    await api('POST', `/assets/${saved.job.package.asset.id}/restore`);
    await history.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(row.getByText('ready', { exact: true })).toBeVisible();
    await download(page, row.getByRole('button', { name: 'Download private ZIP', exact: true }), saved.job.package.asset.checksum);
    await screenshot('retailer-restored-mobile');
    await page.setViewportSize({ width: 1280, height: 900 });
    await screenshot('retailer-history-desktop');
    assert.equal(requests.length, mutations, 'History recovery must not render, validate or package again');

    assert.ok(finishedCover, 'A matching paperback template is required for the uploaded-cover journey');
    onStage('retailer browser follows exact package links from dashboard and book overview');
    const linked = packages.at(-1);
    const target = `/books/${retailer.bookId}/publish?packageJob=${linked.job.id}`;
    for (const source of [`/dashboard?ws=${finishedCover.workspaceId}`, `/books/${retailer.bookId}/overview`]) {
      await page.goto(origin + source);
      await page.locator(`a[href="${target}"]`).click();
      await expect(page).toHaveURL(origin + target);
      await expect(page.getByRole('combobox', { name: 'Format', exact: true })).toHaveValue(linked.edition.kind);
      const exact = history.locator(`#package-${linked.job.id}`);
      await expect(exact).toContainText(linked.job.package.asset.checksum.slice(0, 12));
      await download(page, exact.getByRole('button', { name: 'Download private ZIP', exact: true }), linked.job.package.asset.checksum);
    }
    assert.equal(requests.length, mutations, 'Opening and downloading an exact activity link must not create work');
    console.log('PASS native dashboard and book overview open exact retailer package ZIP without creating work');

    onStage('retailer browser saves an author report from the exact package');
    const currentPackage = page.locator(`#package-${linked.job.id}`);
    await currentPackage.getByText('Retailer submission status', { exact: true }).click();
    await expect(currentPackage.getByText('Author-reported status · No status recorded', { exact: true })).toBeVisible();
    await currentPackage.getByRole('combobox', { name: 'Update status', exact: true }).selectOption('changes_requested');
    await currentPackage.getByRole('button', { name: 'Save status', exact: true }).click();
    await expect(currentPackage.getByText('Submission status saved.', { exact: true })).toBeVisible();

    onStage('retailer browser reopens the author report from the book overview');
    await page.goto(origin + `/books/${retailer.bookId}/overview`);
    const reports = page.getByRole('region', { name: 'Retailer submission updates' });
    const reportLink = reports.getByRole('link', { name: /Author-reported · Changes requested/ });
    await expect(reportLink).toHaveAttribute('href', `${target}#package-${linked.job.id}`);
    await reportLink.click();
    const reportedPackage = page.locator(`#package-${linked.job.id}`);
    await expect(reportedPackage).toBeFocused();
    await reportedPackage.getByText('Retailer submission status', { exact: true }).click();
    await expect(reportedPackage.getByText('Author-reported status · Changes requested')).toBeVisible();
    assert.equal(requests.length, mutations, 'Opening the reported package status must not create work');

    onStage('retailer browser finished cover PDF upload and clean scan');
    await page.goto(`${origin}/assets?ws=${finishedCover.workspaceId}`);
    const pickingFile = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload asset', exact: true }).click();
    const chooser = await pickingFile;
    const filename = 'native-finished-paperback-cover.pdf';
    await chooser.setFiles({ name: filename, mimeType: 'application/pdf', buffer: finishedCover.bytes });
    await expect(page.getByText(`${filename} passed integrity checks and malware screening.`, { exact: true })).toBeVisible();
    const { assets } = await api('GET', `/assets?workspaceId=${finishedCover.workspaceId}`);
    const source = assets.find(asset => asset.name === filename);
    assert.equal(source.current_scan_status, 'clean');
    assert.equal(source.current_version_number, 1);
    assert.equal(source.checksum, finishedCover.checksum);

    onStage('retailer browser saves and renders uploaded paperback cover');
    await page.goto(publishUrl);
    const print = finishedCover.edition;
    await select(print);
    await page.getByRole('combobox', { name: 'Cover source', exact: true }).selectOption('uploaded');
    const pdf = page.getByRole('combobox', { name: 'Finished paperback cover PDF', exact: true });
    await pdf.selectOption(`${source.id}:1`);
    const [savedEdition] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/editions/${print.id}`) && response.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Save edition', exact: true }).click(),
    ]);
    assert.equal(savedEdition.status(), 200);
    const settings = (await nativeBrowserJson(savedEdition)).edition_metadata_json;
    assert.equal(settings.cover.asset_id, source.id);
    assert.equal(settings.wrap_cover.source_pdf_version, 1);
    assert.equal(settings.cover.qr_code.enabled, false);
    const [renderReply] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/editions/${print.id}/render`) && response.request().method() === 'POST', { timeout: 90_000 }),
      page.getByRole('button', { name: 'Render PDF', exact: true }).click(),
    ]);
    assert.equal(renderReply.status(), 201);
    const uploadedRender = await nativeBrowserJson(renderReply);
    assert.equal(uploadedRender.artifacts.find(artifact => artifact.role === 'rendered_cover').asset.checksum, finishedCover.checksum);
    const interior = uploadedRender.artifacts.find(artifact => artifact.role === 'rendered_print').asset.checksum;
    await expect(page.getByText('Private render completed.', { exact: true })).toBeVisible();

    onStage('retailer browser reopens the uploaded cover proof');
    await page.reload();
    await select(print);
    await expect(pdf).toHaveValue(`${source.id}:1`);
    const proof = page.getByRole('region', { name: 'Saved print proofs', exact: true }).getByRole('listitem')
      .filter({ hasText: interior.slice(0, 16) }).first();
    await proof.getByRole('button', { name: 'Open saved print', exact: true }).click();
    await expect(history.getByText(/Package source · Saved print PDF/)).toContainText(interior.slice(0, 12));
    onStage('retailer browser preflights the uploaded cover proof');
    await page.getByRole('combobox', { name: 'Preflight target', exact: true }).selectOption('barnesnoble');
    const [preflightReply] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/publishing/validate') && response.request().method() === 'POST', { timeout: 90_000 }),
      page.getByRole('button', { name: 'Run preflight', exact: true }).click(),
    ]);
    assert.equal(preflightReply.status(), 201);
    const uploadedPreflight = await nativeBrowserJson(preflightReply);
    assert.equal(uploadedPreflight.errors, 0);
    assert.deepEqual(uploadedPreflight.sourcePrint, { jobId: uploadedRender.jobId, sha256: interior, coverSha256: finishedCover.checksum });
    onStage('retailer browser downloads the exact uploaded cover from the private package');
    const [packageReply] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/publishing/jobs') && response.request().method() === 'POST', { timeout: 90_000 }),
      history.getByRole('button', { name: 'Create retailer package', exact: true }).click(),
    ]);
    assert.equal(packageReply.status(), 201);
    const uploadedPackage = await nativeBrowserJson(packageReply);
    assert.equal(uploadedPackage.status, 'succeeded');
    assert.equal(uploadedPackage.sourceRenderJobId, uploadedRender.jobId);
    assert.equal(uploadedPackage.sourcePreflightJobId, uploadedPreflight.jobId);
    await expect(page.getByText('barnesnoble package is ready for manual submission.', { exact: true })).toBeVisible();
    const packageChecksum = uploadedPackage.package.asset.checksum;
    const packageRow = history.locator(`#package-${uploadedPackage.id}`);
    await expect(packageRow).toContainText(packageChecksum.slice(0, 12));
    const archiveBytes = await download(page, packageRow.getByRole('button', { name: 'Download private ZIP', exact: true }), packageChecksum);
    const archive = inspectNativePackage(archiveBytes);
    assert.deepEqual(archive.metadata, uploadedPreflight.listing);
    assert.equal(archive.files['cover.pdf'].sha256, finishedCover.checksum);
    assert.equal(archive.files['book.pdf'].sha256, interior);
    await screenshot('retailer-uploaded-paperback-cover');
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    const usage = await service.from('usage_events').select('meter,quantity');
    assert.equal(usage.error, null); assert.equal(usage.data.length, 28);
    for (const [meter, count] of [['rendering', 13], ['publishing', 15]]) assert.equal(usage.data.filter(row => row.meter === meter).length, count);
    assert.ok(usage.data.every(row => Number(row.quantity) === 1));
    for (const table of ['ai_jobs', 'credit_ledger']) {
      const result = await service.from(table).select('id');
      assert.equal(result.error, null); assert.deepEqual(result.data, []);
    }
    console.log('PASS native browser eight packages, exact uploaded cover, read-only recovery, restored ZIP and zero AI or credit charges');
  } finally { page.off('request', observe); }
}
