// Real Next UI/auth, isolated fixture API; no image provider or spending.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
assert.equal((await fetch('http://127.0.0.1:4399/health').then(r => r.json())).fixture, true);
const workspace = '33333333-3333-4333-8333-333333333333';
const assets = Array.from({ length: 5 }, (_, i) => ({ id: `55555555-5555-4555-8555-55555555555${i}`, workspace_id: workspace,
  name: `Reference ${i + 1}.png`, mime_type: 'image/png', checksum: 'a'.repeat(64), size_bytes: 68, type: 'illustration', status: 'approved', folder_id: null }));
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(60000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  let historyFails = false;
  let finalizations = 0;
  let accessMode = 'editor';
  const jobs = ['running', 'failed', 'succeeded'].map((status, i) => ({ id: `history-${i}`, bookId: null, kind: 'illustration', status, createdAt: '2026-09-12T00:00:00Z', completedAt: null }));
  await page.route('**/api/backend/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/workspaces')) return route.fulfill({ json: { workspaces: [{ id: workspace, name: 'Image test' }] } });
    if (url.pathname.endsWith('/folders')) return route.fulfill({ json: { folders: [] } });
    if (url.pathname.endsWith('/books')) return route.fulfill({ json: { books: [] } });
    if (url.pathname.endsWith('/assets')) return route.fulfill({ json: { assets } });
    if (url.pathname.endsWith('/assets/access')) return accessMode === 'error'
      ? route.fulfill({ status: 503, json: { error: { message: 'Permission service unavailable' } } })
      : route.fulfill({ json: { canEdit: accessMode === 'editor' } });
    if (url.pathname.endsWith('/finalize')) {
      finalizations++;
      if (finalizations === 1) return route.fulfill({ status: 409, json: { error: { message: 'No saved completion record is available yet.' } } });
      jobs[0].status = 'succeeded';
      return route.fulfill({ json: { jobId: jobs[0].id, status: 'succeeded' } });
    }
    if (url.pathname.endsWith('/assets/generation-jobs')) return historyFails
      ? route.fulfill({ status: 503, json: { error: { message: 'History unavailable' } } })
      : route.fulfill({ json: { jobs } });
    if (url.pathname.endsWith('/assets/generate')) {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) return route.fulfill({ status: 503, json: { error: { message: 'Image response interrupted. Retry unchanged settings.' } } });
      return route.fulfill({ json: { asset: { ...assets[0], name: 'Recovered artwork' }, preview: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=' }, jobId: 'fixture-job', model: 'fixture-model' } });
    }
    if (url.pathname.endsWith('/versions')) return route.fulfill({ json: { versions: [] } });
    if (url.pathname.endsWith('/usage')) return route.fulfill({ json: { links: [] } });
    return route.continue();
  });
  await page.goto(`http://127.0.0.1:4398/assets?ws=${workspace}`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  for (let i = 1; i <= 4; i++) await page.getByRole('checkbox', { name: `Reference ${i}.png`, exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Reference 5.png', exact: true })).toBeDisabled();
  await page.getByLabel('Asset name', { exact: true }).fill('Recovered artwork');
  await page.getByLabel('Creative brief', { exact: true }).fill('Draw the same character exploring an ancient forest.');
  await page.getByRole('button', { name: 'Generate image', exact: true }).click();
  await page.getByText('Image response interrupted. Retry unchanged settings.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Generate image', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[0].referenceAssetIds, assets.slice(0, 4).map(asset => asset.id));
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByText('Pending confirmation', { exact: true }).waitFor();
  await page.getByText('Failed — review before starting again', { exact: true }).waitFor();
  await page.getByText('Saved to asset library', { exact: true }).waitFor();
  assert.equal(requests.length, 2, 'reload submitted another generation');
  await page.getByRole('button', { name: 'Finalize saved image', exact: true }).click();
  await page.getByText('No saved completion record is available yet.', { exact: true }).waitFor();
  assert.equal(requests.length, 2, 'missing receipt triggered another generation');
  await page.getByRole('button', { name: 'Finalize saved image', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finalize saved image', exact: true })).toHaveCount(0);
  await expect(page.getByText('Saved to asset library', { exact: true })).toHaveCount(2);
  assert.equal(finalizations, 2); assert.equal(requests.length, 2, 'finalization called generation');
  historyFails = true;
  await page.getByRole('button', { name: 'Refresh image history' }).click();
  await page.getByText('Image request history is temporarily unavailable. Your asset files are unchanged.', { exact: true }).waitFor();
  await expect(page.getByRole('checkbox', { name: 'Reference 1.png', exact: true })).toBeVisible();
  historyFails = false;
  jobs.length = 0;
  await page.getByRole('button', { name: 'Refresh image history' }).click();
  await page.getByText('No image requests found.', { exact: true }).waitFor();
  assert.equal(requests.length, 2, 'history refresh triggered spending');
  accessMode = 'viewer';
  await page.reload();
  await page.getByText('Read-only access: you can view assets, but cannot upload, generate, or change them.', { exact: true }).waitFor();
  await expect(page.getByRole('button', { name: 'Upload asset', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Generate image', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Asset name', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Finalize saved image', exact: true })).toHaveCount(0);
  accessMode = 'error';
  await page.reload();
  await page.getByText('Editing permissions are unavailable. Your files remain viewable; changes are disabled.', { exact: true }).waitFor();
  await expect(page.getByRole('button', { name: 'Upload asset', exact: true })).toBeDisabled();
  accessMode = 'editor';
  await page.getByRole('button', { name: 'Retry permission check' }).click();
  await expect(page.getByLabel('Asset name', { exact: true })).toBeEnabled();
  assert.equal(requests.length, 2, 'permission recovery triggered generation');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS image browser: references, same-key recovery, preview, history states, explicit finalization/missing receipt without regeneration, mobile. Provider/API storage are simulated.');
} finally { await browser.close(); }
