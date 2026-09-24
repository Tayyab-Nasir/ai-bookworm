// Native Edge acceptance against synthetic auth/API: saved-source search and navigation.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

assert.equal((await fetch('http://127.0.0.1:4399/health').then(response => response.json())).fixture, true);
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4398/books/88888888-8888-4888-8888-888888888888/memory');
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  const search = page.getByRole('searchbox', { name: 'Words or phrase' });
  await search.fill('Elara');
  await page.getByRole('button', { name: 'Search saved sources' }).click();
  await expect(page.getByRole('link', { name: 'Open saved chapter' })).toBeVisible();
  await search.fill('Zarina');
  await expect(page.getByRole('link', { name: 'Open saved chapter' })).toHaveCount(0);
  await expect(page.getByText('matching passages', { exact: false })).toHaveCount(0);

  await page.getByRole('button', { name: 'Add memory entry' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Zarina');
  await page.getByLabel('Description', { exact: true }).fill('Keeper of the northern observatory.');
  await page.getByRole('button', { name: 'Save memory entry' }).click();
  await expect(page.getByText('“Zarina” saved to this book’s memory.')).toBeVisible();
  await page.getByRole('button', { name: 'Search saved sources' }).click();
  await expect(page.getByRole('button', { name: 'Open Book Bible entry' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Book Bible entry' }).click();
  await expect(page.locator('#bible-entry-details').getByLabel('Name', { exact: true })).toHaveValue('Zarina');

  await search.fill('Elara');
  await page.getByRole('button', { name: 'Search saved sources' }).click();
  await page.getByRole('link', { name: 'Open saved chapter' }).click();
  await expect(page).toHaveURL(/\?chapter=44444444-4444-4444-8444-444444444444$/);
  await expect(page.getByRole('heading', { name: 'Arrival' })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS book search browser: stale-query reset, saved Bible selection, chapter navigation and mobile containment. Auth/API are fixtures.');
} finally { await browser.close(); }
