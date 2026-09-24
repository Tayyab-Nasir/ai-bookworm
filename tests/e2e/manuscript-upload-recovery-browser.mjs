// Isolated Next UI with synthetic Auth/API/Storage. Run with one of
// FIXTURE_LOST_UPLOAD_ALLOCATION_REPLY or FIXTURE_LOST_UPLOAD_PUT_REPLY.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const origin = 'http://localhost:4398';
const lostAllocation = process.env.FIXTURE_LOST_UPLOAD_ALLOCATION_REPLY === 'true';
const lostPut = process.env.FIXTURE_LOST_UPLOAD_PUT_REPLY === 'true';
assert.notEqual(lostAllocation, lostPut, 'choose exactly one upload failure mode');
assert.equal((await fetch('http://127.0.0.1:4399/health').then((r) => r.json())).fixture, true);
const file = fileURLToPath(new URL('./fixtures/import-recovery.txt', import.meta.url));
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/dashboard`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.locator('#workspace, #workspaceName').first().waitFor();
  if (await page.getByRole('button', { name: 'Create workspace', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  }
  await page.waitForFunction(() => document.querySelector('#workspace')?.value);
  await page.goto(`${origin}/books/new`);
  await page.getByRole('button', { name: 'Import manuscript', exact: true }).click();
  await page.getByLabel('Book title').fill('Harbor upload recovery');
  await page.locator('input[type=file]').setInputFiles(file);
  await page.getByRole('button', { name: 'Create and import', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: lostAllocation ? 'allocation reply' : 'Source upload failed' }).waitFor();
  const saved = await page.evaluate(() => JSON.parse(Object.entries(sessionStorage).find(([key]) => key.startsWith('bookworm:setup:'))[1]));
  assert.equal(saved.source?.uploaded, false);
  assert.match(saved.source?.assetId ?? '', /^[0-9a-f-]{36}$/i);
  assert.equal(JSON.stringify(saved).includes('import-recovery.txt'), false, 'checkpoint stored filename');
  await page.reload();
  await page.getByRole('button', { name: 'Retry import', exact: true }).waitFor();
  if (lostAllocation) await page.locator('input[type=file]').setInputFiles(file);
  await page.getByRole('button', { name: 'Retry import', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Fixture lost scan response' }).waitFor();
  await page.getByRole('button', { name: 'Retry import', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /Import (queued|failed|running)/ }).first().waitFor();
  const resumed = await page.evaluate(() => JSON.parse(Object.entries(sessionStorage).find(([key]) => key.startsWith('bookworm:setup:'))[1]));
  assert.equal(resumed.bookId, saved.bookId);
  assert.equal(resumed.source.assetId, saved.source.assetId);
  assert.equal(resumed.source.uploaded, true);
  const counts = await fetch('http://127.0.0.1:4399/fixture-setup-counts').then((r) => r.json());
  assert.equal(counts.books, 1);
  assert.equal(counts.assets, 1);
  assert.equal(counts.uploads, 1);
  assert.equal(counts.allocationRequests, lostAllocation ? 2 : 1);
  assert.ok(counts.jobReads >= 1, 'durable import was not queued');
  assert.deepEqual(errors, []);
  console.log(`PASS manuscript upload recovery: ${lostAllocation ? 'lost allocation reply' : 'lost PUT reply'}, one book/asset/upload, queued import.`);
} finally { await browser.close(); }
