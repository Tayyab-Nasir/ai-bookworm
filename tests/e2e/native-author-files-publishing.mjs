/** Real Publishing Studio controls against the runner-owned services. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect as playwrightExpect } from '@playwright/test';
import { localFetch, requireNativeAuthorRunner } from './native-author-files-guard.mjs';

const expect = playwrightExpect.configure({ timeout: 30_000 });

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
  const download = async (link, checksum) => {
    const transferred = page.waitForEvent('download');
    await link.click();
    const file = await transferred;
    assert.equal(await file.failure(), null);
    assert.equal(createHash('sha256').update(await readFile(await file.path())).digest('hex'), checksum);
  };

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
      await download(desk.getByRole('link', { name: 'Download saved EPUB v1', exact: true }), artifact.asset.checksum);
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
      await download(link, artifact.asset.checksum);
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
