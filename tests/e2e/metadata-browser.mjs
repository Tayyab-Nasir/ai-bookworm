// Real Next form/cookie/BFF acceptance; quote, acceptance, and AI result are synthetic.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
assert.equal((await fetch('http://127.0.0.1:4399/health').then(r => r.json())).fixture, true);
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.dismiss());
  let saves = 0, quoteRequests = 0, acceptances = 0, statusReads = 0;
  page.on('request', request => {
    if (request.url().endsWith('/metadata') && request.method() === 'PUT') saves++;
  });
  const description = 'An unexpected arrival leads a young traveler into a world of found family and hidden magic.';
  const requestId = '77777777-7777-4777-8777-777777777777';
  const jobId = '99999999-9999-4999-8999-999999999999';
  const candidate = { suggestionKind: 'metadata_candidate', status: 'pending', description, keywords: ['found family'], categories: ['Fiction / Fantasy'], audience: 'Adult fantasy readers', rationale: 'Grounded in the saved opening.', confidence: 0.9, sourceRefs: [{ chapterId: '44444444-4444-4444-8444-444444444444', documentVersionId: '66666666-6666-4666-8666-666666666666', nodeId: 'n1', textHash: 'a'.repeat(64) }] };
  await page.route('**/metadata/models', route => route.fulfill({ json: { models: [{ id: 'astra', label: 'GPT latest', model: 'gpt-6-astra-fixture', priceVersion: 'test-price', policyVersion: 'test-policy' }] } }));
  await page.route('**/metadata/quotes', async route => {
    quoteRequests++;
    const body = route.request().postDataJSON();
    assert.equal(body.allowProviderTokenCounting, true);
    assert.deepEqual(body.chapterIds, ['44444444-4444-4444-8444-444444444444']);
    assert.match(body.idempotencyKey, /^[a-f0-9-]{36}$/);
    await route.fulfill({ status: 201, json: { request: { id: requestId, status: 'ready', createdAt: new Date().toISOString() }, quote: { id: requestId, model: 'gpt-6-astra-fixture', reservedCredits: 37, expiresAt: new Date(Date.now() + 300000).toISOString(), status: 'ready', acceptedJobId: null } } });
  });
  await page.route('**/metadata/quotes/*/accept', async route => {
    acceptances++;
    assert.deepEqual(route.request().postDataJSON(), { expectedCredits: 37 });
    await route.fulfill({ status: 202, json: { jobId, status: 'queued' } });
  });
  await page.route('**/metadata/quote-requests/*', async route => {
    statusReads++;
    await route.fulfill({ json: { request: { id: requestId, status: 'ready' }, quote: { id: requestId, model: 'gpt-6-astra-fixture', reservedCredits: 37, expiresAt: new Date(Date.now() + 300000).toISOString(), status: 'accepted', acceptedJobId: jobId }, job: statusReads === 1 ? { id: jobId, status: 'running' } : { id: jobId, status: 'succeeded' }, candidate: statusReads === 1 ? null : candidate } });
  });
  await page.route('**/metadata/drafts', route => route.fulfill({ json: { drafts: [], pending: [] } }));
  await page.goto('http://127.0.0.1:4398/books/88888888-8888-4888-8888-888888888888/memory');
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  const requestQuote = page.getByRole('button', { name: 'Request token quote', exact: true });
  await requestQuote.waitFor();
  await page.getByLabel(/I agree to send the selected saved chapters/).check();
  await requestQuote.click();
  await expect(page.getByRole('article', { name: /Review your quote/ }).getByRole('strong')).toHaveText('37 credits');
  assert.equal(quoteRequests, 1);
  assert.equal(acceptances, 0, 'counting consent must not accept or generate');
  await page.getByLabel(/I confirm: reserve up to 37 credits/).check();
  await page.getByRole('button', { name: 'Accept quote · 37 credits', exact: true }).click();
  await expect(page.getByText('Generation is running.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh saved result status', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this draft', exact: true })).toBeVisible();
  assert.equal(acceptances, 1);
  assert.equal(statusReads, 2);
  assert.equal(quoteRequests, 1, 'status recovery must not recount or regenerate');
  await page.getByRole('button', { name: 'Use this draft' }).click();
  await expect(page.getByRole('textbox', { name: 'Book description', exact: true })).toHaveValue(description);
  assert.equal(saves, 0, 'adopting AI draft implicitly persisted metadata');
  await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
  await page.getByText('Publishing metadata saved.', { exact: true }).waitFor();
  assert.equal(saves, 1); assert.equal(quoteRequests, 1); assert.equal(acceptances, 1);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Book description', exact: true })).toHaveValue(description);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS metadata browser: explicit counting consent, exact credit acceptance, read-only paid result recovery, explicit adoption/save, reload persistence and mobile containment. Provider/database outcomes remain fixtures.');
} finally { await browser.close(); }
