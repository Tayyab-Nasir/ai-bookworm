// Real Next form/cookie/BFF acceptance; AI generation is a held browser response.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
assert.equal((await fetch('http://127.0.0.1:4399/health').then(r => r.json())).fixture, true);
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.dismiss());
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { started = resolve; });
  let saves = 0, generations = 0;
  page.on('request', request => {
    if (request.url().endsWith('/metadata') && request.method() === 'PUT') saves++;
  });
  const description = 'An unexpected arrival leads a young traveler into a world of found family and hidden magic.';
  await page.route('**/metadata/generate', async route => {
    generations++; started(); await gate;
    await route.fulfill({ json: { candidate: { description, keywords: ['found family'], categories: ['Fiction / Fantasy'], sourceRefs: [{ chapterId: '44444444-4444-4444-8444-444444444444', nodeId: 'n1' }] } } });
  });
  await page.goto('http://127.0.0.1:4398/books/88888888-8888-4888-8888-888888888888/memory');
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.getByRole('button', { name: 'Generate draft', exact: true }).click();
  await received;
  await expect(page.getByRole('button', { name: 'Reload saved data' })).toBeDisabled();
  await expect(page.getByLabel('Title', { exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Book description', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save book details' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeDisabled();
  release();
  await page.getByRole('button', { name: 'Use this draft' }).click();
  await expect(page.getByRole('textbox', { name: 'Book description', exact: true })).toHaveValue(description);
  assert.equal(saves, 0, 'adopting AI draft implicitly persisted metadata');
  await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
  await page.getByText('Publishing metadata saved.', { exact: true }).waitFor();
  assert.equal(saves, 1); assert.equal(generations, 1);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Book description', exact: true })).toHaveValue(description);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS metadata browser: delayed generation locks reload/saves, explicit adoption, one save, reload persistence, mobile containment. AI response and storage remain fixtures.');
} finally { await browser.close(); }
