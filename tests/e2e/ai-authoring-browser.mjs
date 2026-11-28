// Requires the isolated auth fixture with FIXTURE_AI_DRAFT=true on 4399 and
// a separate Next output on 4398. FIXTURE_DASHBOARD_RECOVERY=true also exercises
// a failed summary reload and scoped retry. Never uses a personal browser profile.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
const origin = 'http://127.0.0.1:4398';
const health = await fetch('http://127.0.0.1:4399/health').then((r) => r.json());
assert.equal(health.fixture, true);
const artifacts = await mkdtemp(resolve(tmpdir(), 'bookworm-dashboard-author-'));
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_TEST_CHANNEL ? { channel: process.env.BROWSER_TEST_CHANNEL } : {}) });
try {
  const errors = [], bounds = {};
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && (url.hostname !== '127.0.0.1' || url.port !== '4398')) {
      errors.push('Unexpected network destination in isolated author journey');
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await context.newPage();
  // Next's separate route announcer also has role=alert; it is not a dashboard error.
  const dashboardAlert = page.getByRole('main').getByRole('alert');
  page.setDefaultTimeout(20000);
  async function dashboardSnapshot(name) {
    await page.evaluate(() => document.fonts.ready);
    const measured = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      bodyFont: getComputedStyle(document.body).fontFamily,
      controls: [...document.querySelectorAll('#workspace, button[aria-label="Reload dashboard"], [role="alert"] button')]
        .map(element => ({ name: element.getAttribute('aria-label') || element.id || element.textContent.trim(),
          width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })) }));
    assert(measured.scrollWidth <= measured.viewport, `${name} dashboard overflows`);
    assert(measured.controls.every(control => control.width >= 44 && control.height >= 44), `${name} dashboard control too small`);
    bounds[name] = measured;
    await page.screenshot({ path: resolve(artifacts, `dashboard-${name}.png`), fullPage: true });
    await writeFile(resolve(artifacts, 'dashboard-bounds.json'), JSON.stringify(bounds, null, 2));
  }
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.goto(`${origin}/dashboard`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.locator('#workspace, #workspaceName').first().waitFor();
  if (await page.getByRole('button', { name: 'Create workspace', exact: true }).isVisible()) await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Workspace summary', exact: true })).toBeVisible();
  await expect(dashboardAlert).toHaveCount(0);
  await expect(page.getByText('120', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your library is ready for its first book.', exact: true })).toBeVisible();
  const workspaceId = await page.getByRole('combobox', { name: 'Workspace', exact: true }).inputValue();
  assert(workspaceId, 'dashboard must confirm a workspace, not merely display a fallback option');
  await expect(page.getByRole('link', { name: 'Create or import', exact: true })).toHaveAttribute('href', `/books/new?ws=${workspaceId}`);
  await dashboardSnapshot('initial-desktop');
  await page.getByRole('link', { name: 'Create or import', exact: true }).click();
  await page.getByRole('button', { name: 'Start with AI', exact: true }).click();
  await page.getByLabel('Book title').fill('Harbor browser journey');
  await page.getByLabel('Story brief').fill('Private story brief for Mara at the harbor.');
  await page.getByRole('button', { name: 'Create book & Chapter 1', exact: true }).click();
  await page.getByRole('checkbox', { name: /I agree to send .*OpenAI for token counting/ }).check();
  await page.getByRole('button', { name: 'Prepare exact credit quote', exact: true }).click();
  await page.getByText(/Exact quote · 24 credits/).waitFor();
  await page.getByRole('button', { name: 'Accept · 24 credits and generate', exact: true }).click();
  await page.getByText('Opening scene for author review', { exact: true }).waitFor();
  const proof = page.getByRole('region', { name: 'Proposed manuscript text change' });
  await proof.getByText('01 / Current saved text').waitFor();
  await proof.getByText('02 / Proposed text').waitFor();
  await proof.getByText('Mara reached the harbor before dawn.').waitFor();
  const editor = page.locator('.tiptap');
  assert.equal((await editor.innerText()).trim(), '', 'AI wrote before approval');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.tiptap')?.textContent.includes('Mara reached the harbor'));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.tiptap')?.textContent.includes('Mara reached the harbor'));
  const read = (path) => page.evaluate(async (path) => { const response = await fetch('/api/backend/v1/' + path); if (!response.ok) throw new Error('Fixture read failed'); return response.json(); }, path);
  const bookId = new URL(page.url()).pathname.split('/')[2];
  await page.getByLabel('New chapter', { exact: true }).fill('The second tide');
  await page.getByLabel('Optional AI drafting brief').fill('Mara follows the letter.');
  await page.getByRole('button', { name: 'Add & review AI brief', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'recover the original chapter request' }).waitFor();
  await page.getByRole('button', { name: 'Retry chapter creation', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#ai-instruction')?.value === 'Mara follows the letter.');
  assert.equal((await read(`ai/jobs?bookId=${bookId}`)).jobs.length, 1, 'creating a chapter must not start AI generation');
  assert.equal((await editor.innerText()).trim(), '', 'new chapter has no automatically generated text');
  await page.getByRole('checkbox', { name: /I agree to send .*OpenAI for token counting/ }).check();
  await page.getByRole('button', { name: 'Prepare usage quote', exact: true }).click();
  await page.getByText('24 credits on acceptance', { exact: true }).waitFor();
  assert.equal((await read(`ai/jobs?bookId=${bookId}`)).jobs.length, 1, 'counting a quote must not start generation');
  await page.getByRole('button', { name: 'Accept · 24 credits', exact: true }).click();
  await page.getByText('Opening scene for author review', { exact: true }).waitFor();
  assert.equal((await editor.innerText()).trim(), '', 'second draft wrote before approval');
  const chapters = (await read(`books/${bookId}/chapters`)).chapters;
  assert.equal(chapters.length, 2, 'lost chapter reply duplicated chapter');
  assert.equal((await read(`ai/jobs?bookId=${bookId}`)).jobs.length, 2, 'explicit quote acceptance must create only one job per chapter');
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.getByText('rejected', { exact: true }).waitFor();
  assert.equal((await editor.innerText()).trim(), '', 'rejected draft changed manuscript');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'editor overflows mobile');
  assert.equal(await page.evaluate(() => [...Object.values(sessionStorage), ...Object.values(localStorage)].some((v) => v.includes('Private story brief') || v.includes('Mara follows'))), false, 'private brief persisted in web storage');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/dashboard?ws=${workspaceId}`);
  const summary = page.getByRole('region', { name: 'Workspace summary', exact: true });
  await expect(summary).toBeVisible();
  await expect(dashboardAlert).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Harbor browser journey', exact: true })).toBeVisible();
  await expect(summary.getByText('Active books', { exact: true }).locator('..').getByText('1', { exact: true })).toBeVisible();
  await expect(page.getByText('72', { exact: true })).toBeVisible();
  await expect(page.locator('section[aria-label="Recent workspace state"] ul > li')).toHaveCount(2);
  await expect(page.getByText('Sales data is not connected', { exact: true })).toBeVisible();
  await dashboardSnapshot('populated-desktop');
  await page.setViewportSize({ width: 375, height: 844 });
  await dashboardSnapshot('populated-mobile');
  if (process.env.FIXTURE_DASHBOARD_RECOVERY === 'true') {
    await page.getByRole('button', { name: 'Reload dashboard', exact: true }).click();
    await expect(dashboardAlert).toContainText('Fixture dashboard summary unavailable');
    await expect(summary).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Publishing operations', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Harbor browser journey', exact: true })).toHaveCount(0);
    await expect(page.getByText('72', { exact: true })).toHaveCount(0);
    const retry = dashboardAlert.getByRole('button', { name: 'Try again', exact: true });
    await retry.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await expect(retry).toBeFocused();
    assert.equal(await retry.evaluate(element => getComputedStyle(element).boxShadow !== 'none'), true, 'retry lacks a visible focus ring');
    await dashboardSnapshot('failed-reload-mobile');
    await retry.click();
    await expect(summary).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Harbor browser journey', exact: true })).toBeVisible();
    await expect(page.getByText('72', { exact: true })).toBeVisible();
    await expect(dashboardAlert).toHaveCount(0);
    await dashboardSnapshot('retried-mobile');
  }
  const current = await read(`dashboard?workspaceId=${workspaceId}`);
  assert.equal(current.workspace.id, workspaceId);
  assert.deepEqual(current.books.map(book => book.id), [bookId]);
  assert.equal(current.summary.activeBooks, 1);
  assert.equal(current.summary.pendingJobs, 0);
  assert.equal(current.summary.readyPackages, 0);
  assert.equal(current.usage.usage.ai_credits, 48);
  assert.equal((await read(`ai/jobs?bookId=${bookId}`)).jobs.length, 2, 'dashboard reload must not generate another job');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'dashboard overflows mobile');
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log(`PASS AI browser journey: authenticated dashboard summary, setup, review/apply/reload, lost chapter reply recovery, separate counted quote and generation consent, reject, two chapters/two jobs, returned scoped library/usage, ${process.env.FIXTURE_DASHBOARD_RECOVERY === 'true' ? 'read-only summary retry' : 'summary retry not enabled'}, mobile containment, private brief storage.`);
} finally { await browser.close(); console.log(JSON.stringify({ dashboardAuthorArtifacts: artifacts })); }
