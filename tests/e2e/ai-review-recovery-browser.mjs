// Requires isolated Next on 4398 and synthetic Auth/API on 4399 with
// FIXTURE_AI_DRAFT=true, FIXTURE_LOST_REVIEW_REPLY=true,
// and FIXTURE_LOST_REVIEW_QUOTE_REPLY=true.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:4398';
assert.equal((await fetch('http://127.0.0.1:4399/health').then(response => response.json())).fixture, true);
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let reviewAccepts = 0, reviewCreates = 0, keyReads = 0;
  page.on('request', request => {
    if (request.url().includes('/ai-review/quotes/') && request.url().endsWith('/accept') && request.method() === 'POST') reviewAccepts++;
    if (request.url().endsWith('/ai-review/quotes') && request.method() === 'POST') reviewCreates++;
    if (request.url().includes('/ai-review/quote-requests/') && request.method() === 'GET') keyReads++;
  });
  await page.goto(`${origin}/dashboard`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.locator('#workspace, #workspaceName').first().waitFor();
  if (await page.getByRole('button', { name: 'Create workspace', exact: true }).isVisible()) await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#workspace')?.value);
  await page.getByRole('link', { name: 'Create or import', exact: true }).click();
  await page.getByRole('button', { name: 'Start with AI', exact: true }).click();
  await page.getByLabel('Book title').fill('Review recovery fixture');
  await page.getByLabel('Story brief').fill('Private setup brief about Mara.');
  await page.getByRole('button', { name: 'Create book & Chapter 1', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Prepare exact credit quote', exact: true }).click();
  await expect(page.getByText(/Exact quote · 24 credits/)).toBeVisible();
  await page.getByRole('button', { name: 'Accept · 24 credits and generate', exact: true }).click();
  await page.getByText('Opening scene for author review', { exact: true }).waitFor();
  const bookId = new URL(page.url()).pathname.split('/')[2];
  const chapterId = new URL(page.url()).searchParams.get('chapter');
  assert.ok(chapterId);
  await page.goto(`${origin}/books/${bookId}?chapter=${chapterId}`);
  await page.getByRole('combobox', { name: 'Task' }).selectOption('proofreader');
  await page.locator('.tiptap').waitFor();
  await page.getByLabel(/I agree to send the selected saved chapter/).check();
  await expect(page.locator('#ai-model')).toHaveValue('fixture-writer');
  await expect(page.getByLabel(/I agree to send the selected saved chapter/)).toBeChecked();
  await expect(page.getByRole('button', { name: 'Prepare usage quote' })).toBeEnabled();
  await page.getByRole('button', { name: 'Prepare usage quote' }).click();
  await page.getByText('Fixture lost quote creation reply', { exact: true }).waitFor();
  assert.equal(reviewCreates, 2, 'one onboarding quote and one proofread quote expected');
  await page.reload();
  await expect(page.getByText('24 credits on acceptance')).toBeVisible();
  assert.equal(reviewCreates, 2, 'reload recovers a lost quote without another token count');
  assert.ok(keyReads > 0, 'lost reply must recover through read-only key lookup');
  await page.getByRole('button', { name: 'Accept · 24 credits' }).click();
  await expect(page.getByText('Recovered the accepted review after an uncertain reply. No second charge was made.')).toBeVisible();
  assert.equal(reviewAccepts, 2, 'one onboarding acceptance and one proofread acceptance expected; the latter loses its reply');
  await page.reload();
  // The initial empty editor can mount a temporary AI panel. Wait for the saved
  // chapter before opening history so its subsequent keyed mount cannot close it.
  await page.locator('.tiptap').waitFor();
  const history = page.locator('section[aria-labelledby="ai-assistant-title"] details').filter({ has: page.locator('summary', { hasText: 'Recent saved reviews' }) });
  await history.locator('summary').click();
  await expect(history).toHaveJSProperty('open', true);
  await page.getByText('Proofread · succeeded').waitFor();
  assert.equal(reviewAccepts, 2, 'reload must not accept or queue another paid review');
  const jobs = await page.evaluate(async id => {
    const response = await fetch(`/api/backend/v1/ai/jobs?bookId=${id}`);
    return (await response.json()).jobs;
  }, bookId);
  assert.equal(jobs.length, 2);
  assert.equal(await page.evaluate(() => Object.values(sessionStorage).some(value => value.includes('Private setup brief'))), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS web AI review: lost quote creation recovered by GET after reload without recounting; explicit priced acceptance, lost acceptance recovered with one funded review; no private brief storage; narrow-screen containment. Auth/API are fixtures.');
} finally { await browser.close(); }
