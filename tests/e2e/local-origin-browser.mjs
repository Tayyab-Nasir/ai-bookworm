// Local Next + synthetic auth provider. Tests actual Origin/cookie behavior.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
assert.equal((await fetch('http://127.0.0.1:4399/health').then(r => r.json())).fixture, true);
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
try {
  for (const host of ['localhost', '127.0.0.1']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const origin = `http://${host}:4398`;
    await page.goto(`${origin}/books/88888888-8888-4888-8888-888888888888`);
    assert.equal(new URL(page.url()).origin, origin, 'login redirect changed host');
    await page.getByLabel('Email').fill('author@example.test');
    await page.getByLabel('Password', { exact: true }).fill('fixture-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.locator('.tiptap').waitFor();
    assert.equal(new URL(page.url()).origin, origin);
    const session = await context.request.get(`${origin}/api/auth/session`);
    assert.equal(session.status(), 200);
    for (const badOrigin of ['https://evil.test', `http://${host}:4397`, `http://${host === 'localhost' ? '127.0.0.1' : 'localhost'}:4398`]) {
      const denied = await context.request.post(`${origin}/api/auth/logout`, { headers: { origin: badOrigin }, data: {} });
      assert.equal(denied.status(), 403);
    }
    const crossSite = await context.request.post(`${origin}/api/auth/logout`, { headers: { origin, 'sec-fetch-site': 'cross-site' }, data: {} });
    assert.equal(crossSite.status(), 403);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL('**/login');
    assert.equal((await context.request.get(`${origin}/api/auth/session`)).status(), 401);
    await context.close();
    console.log(`PASS ${host}: redirect, login, session, cross-origin/port/site denial and logout.`);
  }
} finally { await browser.close(); }
