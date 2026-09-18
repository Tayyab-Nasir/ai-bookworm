// UI acceptance against the isolated auth fixture. Image bytes and API storage are fixtures.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

assert.equal((await fetch('http://127.0.0.1:4399/health').then((response) => response.json())).fixture, true);
const origin = 'http://localhost:4398';
const bookId = '88888888-8888-4888-8888-888888888888';
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_TEST_CHANNEL ? { channel: process.env.BROWSER_TEST_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(25000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.goto(`${origin}/books/${bookId}`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.getByRole('button', { name: 'Illustration', exact: true }).click();
  await page.getByLabel('Workspace image').selectOption({ index: 1 });
  await page.getByLabel('Image description (alt text)').fill('Elara crossing the blue harbor');
  await page.getByLabel('Print placement').selectOption('fullBleed');
  await page.getByLabel('Horizontal focus').selectOption('0');
  await page.getByLabel('Vertical focus').selectOption('100');
  await page.getByRole('button', { name: 'Insert illustration', exact: true }).click();
  await page.getByRole('button', { name: 'Artwork settings', exact: true }).click();
  assert.equal(await page.getByLabel('Print placement').inputValue(), 'fullBleed');
  assert.equal(await page.getByLabel('Horizontal focus').inputValue(), '0');
  assert.equal(await page.getByLabel('Vertical focus').inputValue(), '100');
  await page.getByRole('button', { name: 'Save chapter', exact: true }).click();
  await page.getByText('Saved version 2.', { exact: true }).waitFor();
  const saved = await page.evaluate(async () => {
    const response = await fetch('/api/backend/v1/chapters/44444444-4444-4444-8444-444444444444/document');
    return response.json();
  });
  const image = saved.document.nodes.find((node) => node.type === 'image');
  assert.deepEqual(image.attributes, { widthPercent: 100, decorative: false, printPlacement: 'fullBleed', printFocalX: 0, printFocalY: 100 });
  await page.reload();
  await page.getByRole('button', { name: 'Artwork settings', exact: true }).click();
  assert.equal(await page.getByLabel('Print placement').inputValue(), 'fullBleed');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'full-bleed controls overflow mobile');
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log('PASS full-bleed artwork browser: insert, crop focus, save, reload and mobile containment. Rendering bytes are verified separately.');
} finally { await browser.close(); }
