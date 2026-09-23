// Real Next UI/auth with synthetic quote API responses; no database or provider calls.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const origin = process.env.BROWSER_TEST_ORIGIN ?? 'http://localhost:4398';
const bookId = '88888888-8888-4888-8888-888888888888';
const requestId = '99999999-9999-4999-8999-999999999999';
const proposalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const blueprint = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: 3,
  story: { workingTitle: 'The Harbor Bell', premise: 'A keeper hears a bell beneath the tide.', readerPromise: 'A quiet mystery.', genre: 'Fantasy', tone: 'Hopeful', pointOfView: 'Third person', tense: 'Past', targetWordCount: 60000, synopsis: 'A keeper follows the sound.', theme: 'Trust', notes: 'Private planning notes.' },
  chapterPlan: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'The First Tide', purpose: 'Open the mystery', summary: 'A bell rings at dawn.', targetWords: 1200 }],
  materializations: [], updatedAt: '2026-09-23T00:00:00Z',
};
let statusReads = 0;
let releaseQuote = false;
let failNextRecoveryRead = false;
let quotePosts = 0;
let generationRequests = 0;
const errors = [];
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_TEST_CHANNEL ? { channel: process.env.BROWSER_TEST_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.dismiss());
  await page.route('**/api/backend/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/backend/v1', '');
    const json = (body, status = 200) => route.fulfill({ status, json: body, headers: { 'cache-control': 'private, no-store' } });
    if (path === `/books/${bookId}/story-blueprint` && request.method() === 'GET') return json({ blueprint, role: 'owner' });
    if (path === `/books/${bookId}/story-blueprint/models`) return json({ catalogVersion: 'synthetic-v1', models: [{ id: 'fixture-model', label: 'Synthetic test model', model: 'synthetic-model' }] });
    if (path === `/books/${bookId}/story-blueprint/quotes` && request.method() === 'POST') {
      quotePosts++;
      const body = request.postDataJSON();
      assert.equal(body.modelId, 'fixture-model');
      assert.match(body.idempotencyKey, /^[0-9a-f-]{36}$/u);
      assert.equal(body.allowProviderTokenCounting, true);
      return json({ request: { id: requestId, status: 'queued' }, proposal: null }, 202);
    }
    if (path === `/books/${bookId}/story-blueprint/quote-requests/${requestId}`) {
      statusReads++;
      if (failNextRecoveryRead) {
        failNextRecoveryRead = false;
        return json({ error: { message: 'Temporary fixture read failure' } }, 503);
      }
      if (!releaseQuote) return json({ request: { id: requestId, status: 'counting' }, proposal: null });
      return json({ request: { id: requestId, status: 'ready' }, proposal: {
        id: proposalId, requestId, sourceRevision: 3, model: 'synthetic-model', reservedCredits: 42,
        expiresAt: '2099-01-01T00:00:00.000Z', acceptedJobId: null, status: 'ready',
      } });
    }
    if (/\/story-blueprint\/(proposals|quotes)\//u.test(path) && request.method() === 'POST') generationRequests++;
    return route.continue();
  });

  await page.goto(`${origin}/books/${bookId}/plan`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /Generate a review-only blueprint proposal/i })).toBeVisible();
  await page.getByLabel(/I agree to send this saved Story Blueprint/i).check();
  await page.getByRole('button', { name: 'Prepare fixed quote' }).click();
  await expect(page.getByText(/queued for one provider token count/i)).toBeVisible();
  assert.equal(quotePosts, 1);
  assert.equal(generationRequests, 0);

  failNextRecoveryRead = true;
  await page.reload();
  await expect(page.locator('[aria-label="Recovering saved Story Blueprint quote"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare fixed quote' })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.locator('[aria-label="Preparing Story Blueprint quote"]')).toBeVisible();
  await expect(page.getByText('Counting tokens', { exact: true })).toBeVisible();
  releaseQuote = true;
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByText(/42\s+credits maximum hold/u)).toBeVisible();
  assert.equal(quotePosts, 1, 'reload/status recovery must not create a second count request');
  assert.equal(generationRequests, 0, 'preparing a quote must never generate or accept a proposal');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'quote panel overflows mobile');
  assert.deepEqual(errors, []);
  console.log('PASS Story Blueprint quote browser: explicit consent, queued count, reload recovery, status progression, no pre-accept generation, mobile containment. Responses are synthetic.');
} finally { await browser.close(); }
