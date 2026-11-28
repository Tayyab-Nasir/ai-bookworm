// Isolated Next UI and synthetic Auth/API. Use FIXTURE_LOST_BOOK_REPLY=true
// or FIXTURE_REFUSE_BOOK_BEFORE_ACCEPTANCE=true for the matching journey.
// No hosted Supabase or customer data is involved.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const origin = 'http://localhost:4398';
const refusedBeforeAcceptance = process.env.FIXTURE_REFUSE_BOOK_BEFORE_ACCEPTANCE === 'true';
assert.equal((await fetch('http://127.0.0.1:4399/health').then((r) => r.json())).fixture, true);
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
  await page.getByLabel('Book title').fill('Harbor recovery journey');
  await page.getByRole('button', { name: 'Create book', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Creation may have reached the server' }).waitFor();
  const pending = await page.evaluate(() => {
    const raw = Object.entries(sessionStorage).find(([key]) => key.startsWith('bookworm:setup:'))?.[1];
    return raw ? JSON.parse(raw) : null;
  });
  assert.equal(pending?.bookCreated, false);
  assert.match(pending?.bookId ?? '', /^[0-9a-f-]{36}$/i);
  assert.equal(JSON.stringify(pending).includes('Harbor recovery journey'), false, 'local checkpoint stored title');
  await page.reload();
  if (refusedBeforeAcceptance) {
    await page.getByRole('status').filter({ hasText: 'Book creation was interrupted' }).waitFor();
    assert.equal((await fetch('http://127.0.0.1:4399/fixture-setup-counts').then((r) => r.json())).books, 0);
    await page.getByLabel('Book title').fill('Harbor recovery journey');
    await page.getByRole('button', { name: 'Retry book creation', exact: true }).click();
    await page.waitForURL(`${origin}/books/${pending.bookId}*`);
  } else {
    await page.getByRole('button', { name: 'Continue to editor', exact: true }).waitFor();
  }
  const recovered = await page.evaluate(() => {
    const raw = Object.entries(sessionStorage).find(([key]) => key.startsWith('bookworm:setup:'))?.[1];
    return raw ? JSON.parse(raw) : null;
  });
  assert.equal(recovered.bookCreated, true);
  assert.equal(recovered.bookId, pending.bookId);
  const counts = await fetch('http://127.0.0.1:4399/fixture-setup-counts').then((r) => r.json());
  assert.equal(counts.books, 1, 'lost response created duplicate book');
  if (!refusedBeforeAcceptance) {
    await page.getByRole('button', { name: 'Continue to editor', exact: true }).click();
    await page.waitForURL(`${origin}/books/${pending.bookId}*`);
  }
  assert.deepEqual(errors, []);
  console.log(`PASS book creation recovery: ${refusedBeforeAcceptance ? 'pre-accept 503, reload 404, same-ID retry' : 'accepted/lost reply, reload GET recovery'}, one book, editor navigation.`);
} finally { await browser.close(); }
