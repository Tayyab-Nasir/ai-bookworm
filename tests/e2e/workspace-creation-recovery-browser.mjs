// Isolated Next app and synthetic Auth/API only; no real customer data.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:4398';
assert.equal((await fetch('http://127.0.0.1:4399/health').then(response => response.json())).fixture, true);
const channel = process.env.BROWSER_TEST_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/dashboard`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.getByLabel('Workspace name').fill('Synthetic recovery studio');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Check workspace creation' })).toBeVisible();
  const pending = await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith('bookworm:workspace-creation:'))?.[1]);
  assert.match(pending ?? '', /^[a-f0-9-]{36}$/i);
  assert.equal(pending.includes('Synthetic recovery studio'), false);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Check workspace creation' })).toBeVisible();
  await page.getByRole('button', { name: 'Check request status', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).not.toHaveValue('');
  await expect(page.getByRole('region', { name: 'Check workspace creation' })).toHaveCount(0);
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('bookworm:workspace-creation:'))), false);
  const counts = await fetch('http://127.0.0.1:4399/fixture-setup-counts').then(response => response.json());
  assert.equal(counts.workspaces, 1, 'A lost reply must not create another workspace');
  assert.deepEqual(errors, []);
  console.log('PASS lost workspace reply, reload, exact receipt recovery and one synthetic workspace');
} finally { await browser.close(); }
