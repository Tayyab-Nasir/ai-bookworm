// Real local Next UI; synthetic auth/API only. No production services.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const origin = 'http://localhost:4398';
assert.equal((await fetch('http://127.0.0.1:4399/health').then(r => r.json())).fixture, true);
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss());
  page.setDefaultTimeout(30000);
  const book = '88888888-8888-4888-8888-888888888888', chapter = '44444444-4444-4444-8444-444444444444';
  await page.route(`**/api/backend/v1/books/${book}/chapters`, route => route.fulfill({ json: { chapters: [
    { id: chapter, title: 'Arrival', book_id: book, order_index: 0 },
    { id: 'second-chapter', title: 'Second chapter', book_id: book, order_index: 1 },
  ] } }));
  await page.route('**/api/backend/v1/chapters/second-chapter/document', route => route.fulfill({ json: { role: 'viewer', document: { chapterId: 'second-chapter', version: 1, nodes: [{ id: 'p', type: 'paragraph', text: 'Second chapter text' }] } } }));
  await page.route('**/api/backend/v1/chapters/second-chapter/versions', route => route.fulfill({ json: { versions: [] } }));
  await page.goto(`${origin}/login`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/dashboard');
  await page.goto(`${origin}/books/${book}`);
  const editor = page.locator('.tiptap');
  await editor.fill('An updated harbor chapter.');
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.getByText('Saved version 2.', { exact: true }).waitFor();
  const ledger = page.getByRole('complementary', { name: 'Versions', exact: true });
  await ledger.getByLabel('Select version 2', { exact: true }).check();
  await ledger.getByLabel('Select version 1', { exact: true }).check();
  await ledger.getByRole('button', { name: 'Compare selected' }).click();
  await page.getByRole('heading', { name: 'v1 → v2' }).waitFor();
  assert.match(await ledger.locator('ins').allTextContents().then(v => v.join('')), /updated/);
  assert.match(await ledger.locator('del').allTextContents().then(v => v.join('')), /Elara/);
  await page.screenshot({ path: 'apps/web/.next-revision/revision-ledger.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await ledger.getByLabel('Select version 1', { exact: true }).uncheck();
  assert.equal(await page.getByRole('region', { name: 'Version comparison' }).count(), 0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ledger.getByLabel('Select version 1', { exact: true }).check();
  await ledger.getByRole('button', { name: 'Compare selected' }).click();
  await page.getByRole('button', { name: /Second chapter/ }).first().click();
  await page.getByText('No saved revisions yet. Save your chapter to begin its history.').waitFor();
  assert.equal(await page.getByRole('region', { name: 'Version comparison' }).count(), 0);
  assert.equal(await ledger.getByRole('button', { name: /Restore version/ }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS revision ledger: save, reverse selection, exact diff, deselection, mobile, chapter reset and viewer controls.');
} finally { await browser.close(); }
