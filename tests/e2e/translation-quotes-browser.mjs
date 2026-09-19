// Real Next UI + synthetic authentication and translation responses; no provider calls.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

assert.equal((await fetch('http://127.0.0.1:4399/health').then(r => r.json())).fixture, true);
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const bookId = '88888888-8888-4888-8888-888888888888';
  const id = '99999999-9999-4999-8999-999999999999';
  const request = { id, bookId, status: 'queued', chapterCount: 1, countedChapters: 0, proposalId: null,
    createdAt: new Date().toISOString(), targetLanguage: 'es', modelId: 'fixture-model' };
  const proposal = { id, bookId, sourceLanguage: 'en', targetLanguage: 'es', reservedCredits: 12,
    expiresAt: new Date(Date.now() + 600000).toISOString(), status: 'ready', acceptedProjectId: null,
    chapters: [{ chapterId: 'chapter-fixture', documentVersionId: 'version-fixture', chapterOrder: 0, reservedCredits: '12', model: 'synthetic-model' }] };
  const project = { id, bookId, sourceLanguage: 'en', targetLanguage: 'es', status: 'queued', chapterCount: 1,
    completedChapterCount: 0, creditUnits: 0, adoptedBookId: null, createdAt: request.createdAt,
    completedAt: null, chapters: [], billingMode: 'quoted', canViewBilling: false, canCancelBeforeDispatch: false };
  const sent = []; let accepts = 0, history = [], loseRequest = true, loseAccept = true, failHistory = false, viewer = false;
  await page.route('**/api/backend/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/backend/v1', '');
    const json = body => route.fulfill({ json: body });
    if (path === '/translations/models') return json({ catalogVersion: 'synthetic', models: [{ id: 'fixture-model', label: 'Synthetic test model', model: 'synthetic-model', priceVersion: 'test', policyVersion: 'test' }] });
    if (path === `/books/${bookId}` && viewer) return json({ book: { id: bookId, title: 'Synthetic book', language: 'en' }, role: 'viewer' });
    if (path === `/books/${bookId}/translations`) return failHistory
      ? route.fulfill({ status: 503, json: { error: { message: 'Synthetic history unavailable' } } }) : json({ projects: [] });
    if (path === `/books/${bookId}/translation-quotes`) {
      if (route.request().method() === 'GET') return json({ requests: history });
      sent.push(route.request().postDataJSON()); history = [request];
      if (loseRequest) { loseRequest = false; return route.fulfill({ status: 503, json: { error: { message: 'Synthetic lost response. Refresh before retrying.' } } }); }
      return json(request);
    }
    if (path === `/translation-quotes/${id}`) return json(proposal);
    if (path === `/translation-quotes/${id}/accept`) {
      accepts++; assert.deepEqual(route.request().postDataJSON(), { expectedCredits: 12 });
      if (loseAccept) { loseAccept = false; return route.fulfill({ status: 503, json: { error: { message: 'Synthetic uncertain acceptance. Refresh the same quote.' } } }); }
      return json(project);
    }
    if (path === `/translations/${id}`) return json(project);
    return route.continue();
  });
  await page.goto(`http://localhost:4398/books/${bookId}/translate`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  const prepare = page.getByRole('button', { name: 'Prepare quote', exact: true });
  const consent = page.getByRole('checkbox');
  await expect(prepare).toBeDisabled({ timeout: 30000 });
  await page.getByLabel('Target language code').fill('es');
  assert.equal(sent.length, 0);
  await consent.check(); await prepare.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic lost response' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh quotes' }).click();
  await expect(page.getByText('Waiting for the quote worker', { exact: true })).toBeVisible();
  await prepare.click();
  await expect(page.getByText(/Quote preparation requested/)).toBeVisible();
  assert.equal(sent.length, 2); assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey);
  assert.equal(sent[0].allowProviderTokenCounting, true); assert.equal(accepts, 0);
  request.status = 'failed';
  await page.getByRole('button', { name: 'Refresh quotes' }).click();
  await page.getByRole('button', { name: 'Prepare a new quote', exact: true }).click();
  await expect(consent).not.toBeChecked(); await expect(prepare).toBeDisabled();
  request.status = 'ready'; request.countedChapters = 1; request.proposalId = id;
  await consent.check(); await prepare.click();
  await page.getByRole('button', { name: 'Review quote', exact: true }).click();
  assert.notEqual(sent[2].idempotencyKey, sent[1].idempotencyKey);
  const confirm = page.getByRole('button', { name: 'Confirm 12-credit hold & translate', exact: true });
  await expect(confirm).toBeVisible(); assert.equal(accepts, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await confirm.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic uncertain acceptance' })).toBeVisible();
  // A committed purchase must recover via read, not a second purchase.
  proposal.status = 'accepted'; proposal.acceptedProjectId = id;
  await page.getByRole('button', { name: 'Refresh quotes' }).click();
  await page.getByRole('button', { name: 'Open accepted translation' }).click();
  await expect(page.getByText('Translation purchase confirmed. Track chapter progress and your held credits below.')).toBeVisible();
  assert.equal(accepts, 1);
  proposal.status = 'expired'; proposal.acceptedProjectId = null; proposal.expiresAt = new Date(Date.now() - 1000).toISOString();
  await page.getByRole('button', { name: 'Refresh quotes' }).click();
  await expect(confirm).toBeDisabled();
  await page.getByRole('button', { name: 'Request a fresh quote', exact: true }).click();
  await expect(consent).not.toBeChecked();
  failHistory = true;
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic history unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh history', exact: true })).toBeEnabled();
  failHistory = false; viewer = true;
  await page.reload();
  await expect(page.getByText('Editing access is required to request or accept a quote.')).toBeVisible();
  await expect(prepare).toBeDisabled(); await expect(consent).toBeDisabled();
  await page.getByRole('button', { name: 'Review quote', exact: true }).click();
  await expect(confirm).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Request a fresh quote', exact: true })).toBeDisabled();
  assert.equal(sent.length, 3); assert.equal(accepts, 1);
  assert.deepEqual(errors, []);
  console.log('PASS translation quote UI: explicit consent, lost-request stable retry, fresh intent, review-only no purchase, accepted recovery, expiry, mobile containment, history failure recovery, viewer controls. Provider/database responses synthetic.');
} finally { await browser.close(); }
