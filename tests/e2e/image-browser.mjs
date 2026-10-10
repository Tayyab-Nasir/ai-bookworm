// Real Next UI/auth, isolated fixture API; no image provider or spending.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
assert.equal((await fetch('http://127.0.0.1:4399/health').then(r => r.json())).fixture, true);
const workspace = '33333333-3333-4333-8333-333333333333';
const assets = Array.from({ length: 5 }, (_, i) => ({ id: `55555555-5555-4555-8555-55555555555${i}`, workspace_id: workspace,
  name: `Reference ${i + 1}.png`, mime_type: 'image/png', checksum: 'a'.repeat(64), size_bytes: 68, type: 'illustration', status: 'approved', folder_id: null }));
const imageModel = { id: 'illustration-v1', label: 'Bookworm illustration', model: 'fixture-image-model', size: '1024x1024', quality: 'high', maxReferenceImages: 3, maxPromptBytes: 8000, priceVersion: 'fixture-price-v1', policyVersion: 'fixture-policy-v1' };
const quoteId = '77777777-7777-4777-8777-777777777777';
const quote = { id: quoteId, status: 'ready', model: imageModel.model, size: imageModel.size, quality: imageModel.quality, kind: 'illustration', reservedCredits: '42', expiresAt: '2099-01-01T00:00:00.000Z', pricingBasis: 'maximum_token_budget', purchaseAvailable: false };
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(60000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const createRequests = [];
  const recoveryKeys = [];
  const acceptRequests = [];
  let quoteSaved = false;
  let acceptedJob = null;
  let purchaseAvailable = false;
  let historyFails = false;
  let accessMode = 'editor';
  const jobs = ['running', 'failed', 'succeeded'].map((status, i) => ({ id: `history-${i}`, bookId: null, kind: 'illustration', status, createdAt: '2026-09-12T00:00:00Z', completedAt: null }));
  await page.route('**/api/backend/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/workspaces')) return route.fulfill({ json: { workspaces: [{ id: workspace, name: 'Image test' }] } });
    if (url.pathname.endsWith('/folders')) return route.fulfill({ json: { folders: [] } });
    if (url.pathname.endsWith('/books')) return route.fulfill({ json: { books: [] } });
    if (url.pathname.endsWith('/assets')) return route.fulfill({ json: { assets } });
    if (url.pathname.endsWith('/image-models')) return route.fulfill({ json: { catalogVersion: 'fixture-v1', pricingBasis: 'maximum_token_budget', purchaseAvailable, models: [imageModel] } });
    if (url.pathname.endsWith('/assets/access')) return accessMode === 'error'
      ? route.fulfill({ status: 503, json: { error: { message: 'Permission service unavailable' } } })
      : route.fulfill({ json: { canEdit: accessMode === 'editor' } });
    if (url.pathname.endsWith('/assets/generation-jobs')) return historyFails
      ? route.fulfill({ status: 503, json: { error: { message: 'History unavailable' } } })
      : route.fulfill({ json: { jobs } });
    if (url.pathname.endsWith('/image-quotes/recover')) {
      recoveryKeys.push(route.request().postDataJSON().idempotencyKey);
      return quoteSaved ? route.fulfill({ json: { quoteId } }) : route.fulfill({ status: 404, json: { error: { message: 'No saved image quote exists for this request.' } } });
    }
    if (url.pathname.endsWith('/image-quotes') && route.request().method() === 'POST') {
      createRequests.push(route.request().postDataJSON());
      quoteSaved = true;
      return route.fulfill({ status: 503, json: { error: { message: 'Quote response interrupted. Recover the same request.' } } });
    }
    if (url.pathname.endsWith(`/image-quotes/${quoteId}`) && route.request().method() === 'GET') return route.fulfill({ json: { quote } });
    if (url.pathname.endsWith(`/image-quotes/${quoteId}/job`)) return route.fulfill({ json: { quoteId, accepted: Boolean(acceptedJob), job: acceptedJob } });
    if (url.pathname.endsWith(`/image-quotes/${quoteId}/accept`)) {
      acceptRequests.push(route.request().postDataJSON());
      acceptedJob = { id: 'image-job-fixture', status: 'queued', assetId: null };
      if (acceptRequests.length === 1) return route.fulfill({ status: 503, json: { error: { message: 'Acceptance reply lost after saving the job.' } } });
      return route.fulfill({ json: { quoteId, jobId: acceptedJob.id, status: acceptedJob.status } });
    }
    if (url.pathname.endsWith('/versions')) return route.fulfill({ json: { versions: [] } });
    if (url.pathname.endsWith('/usage')) return route.fulfill({ json: { links: [] } });
    return route.continue();
  });
  await page.goto(`http://127.0.0.1:4398/assets?ws=${workspace}`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  for (let i = 1; i <= 3; i++) await page.getByRole('checkbox', { name: `Reference ${i}.png`, exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Reference 4.png', exact: true })).toBeDisabled();
  await page.getByLabel(/Describe the scene, characters, mood and visual style/).fill('Draw the same character exploring an ancient forest.');
  await page.getByLabel(/Save this private prompt and selected source references/).check();
  await page.getByRole('button', { name: 'Prepare image quote', exact: true }).click();
  await page.getByText('Quote response interrupted. Recover the same request.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Recover same quote request', exact: true }).click();
  await page.getByText('Maximum credit hold', { exact: true }).waitFor();
  assert.equal(createRequests.length, 1, 'retry created a second immutable offer');
  assert.equal(recoveryKeys.length, 1);
  assert.equal(recoveryKeys[0], createRequests[0].idempotencyKey);
  assert.equal(createRequests[0].consentToQuoteStorage, true);
  assert.deepEqual(createRequests[0].referenceAssetIds, assets.slice(0, 3).map(asset => asset.id));
  await expect(page.getByLabel(/Describe the scene, characters, mood and visual style/)).toBeDisabled();
  await expect(page.getByLabel('Artwork type')).toBeDisabled();
  const generationConsent = page.getByLabel(/I approve sending this saved prompt and selected references/);
  await expect(generationConsent).toBeDisabled();
  await expect(generationConsent).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Purchases not enabled', exact: true })).toBeDisabled();
  assert.equal(acceptRequests.length, 0, 'disabled purchases triggered paid acceptance');
  const storageKey = `bookworm.image-quote.v1:${workspace}`;
  assert.equal((await page.evaluate(key => sessionStorage.getItem(key), storageKey)).includes('ancient forest'), false);
  assert.equal(page.url().includes('ancient forest'), false);

  purchaseAvailable = true;
  await page.reload();
  await page.getByText('Maximum credit hold', { exact: true }).waitFor();
  await expect(generationConsent).toBeEnabled();
  await expect(generationConsent).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Accept quote · 42 credits', exact: true })).toBeDisabled();
  await generationConsent.check();
  await expect(generationConsent).toBeChecked();
  await page.getByRole('button', { name: 'Accept quote · 42 credits', exact: true }).click();
  const imageAlerts = page.getByRole('region', { name: 'Illustrations and cover art', exact: true }).getByRole('alert');
  await expect(imageAlerts).toHaveCount(1);
  await expect(imageAlerts).toHaveText('Acceptance reply lost after saving the job. Refresh saved status before accepting again. No new purchase will be sent by recovery.');
  assert.equal(acceptRequests.length, 1);
  assert.deepEqual(acceptRequests[0], { expectedCredits: '42', consentToGenerate: true });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.getByText(/Generation queued/).waitFor();
  assert.equal(acceptRequests.length, 1, 'status recovery accepted the quote again');
  acceptedJob = { id: 'image-job-fixture', status: 'succeeded', assetId: assets[0].id };
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.getByText('Artwork is saved in your private asset library and ready to select in Publishing Studio.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create another image', exact: true }).click();
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), null);
  historyFails = true;
  await page.getByRole('button', { name: 'Refresh image history' }).click();
  await page.getByText('Image request history is temporarily unavailable. Your asset files are unchanged.', { exact: true }).waitFor();
  await expect(page.getByRole('checkbox', { name: 'Reference 1.png', exact: true })).toBeVisible();
  historyFails = false;
  jobs.length = 0;
  await page.getByRole('button', { name: 'Refresh image history' }).click();
  await page.getByText('No image requests found.', { exact: true }).waitFor();
  assert.equal(createRequests.length, 1, 'history refresh created another quote');
  assert.equal(acceptRequests.length, 1, 'history refresh triggered another acceptance');
  accessMode = 'viewer';
  await page.reload();
  await page.getByText('Read-only access: you can view assets, but cannot upload, generate, or change them.', { exact: true }).waitFor();
  await expect(page.getByRole('button', { name: 'Upload asset', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Prepare image quote', exact: true })).toBeDisabled();
  await expect(page.getByLabel(/Describe the scene, characters, mood and visual style/)).toBeDisabled();
  accessMode = 'error';
  await page.reload();
  await page.getByText('Editing permissions are unavailable. Your files remain viewable; changes are disabled.', { exact: true }).waitFor();
  await expect(page.getByRole('button', { name: 'Upload asset', exact: true })).toBeDisabled();
  accessMode = 'editor';
  await page.getByRole('button', { name: 'Retry permission check' }).click();
  await expect(page.getByLabel(/Describe the scene, characters, mood and visual style/)).toBeEnabled();
  assert.equal(createRequests.length, 1, 'permission recovery created another quote');
  assert.equal(acceptRequests.length, 1, 'permission recovery accepted another quote');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS image browser: same-key quote recovery, immutable brief, paid-consent gate, lost-acceptance status recovery without duplicate work, permissions, history and mobile. Provider/API/Storage are simulated.');
} finally { await browser.close(); }
