// Real editor, synthetic restore transport. No production backend mutations.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
assert.equal((await fetch('http://127.0.0.1:4399/health').then(r => r.json())).fixture, true);
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30000);
  page.on('dialog', d => d.accept());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const requests = [], receipts = new Map();
  let conflict = false, failHistory = false;
  const chapter = '44444444-4444-4444-8444-444444444444';
  await page.route(`**/api/backend/v1/chapters/${chapter}/versions`, async route => {
    if (failHistory) return route.fulfill({ status: 503, json: { error: { message: 'fixture history outage' } } });
    return route.continue();
  });
  await page.route(`**/api/backend/v1/chapters/${chapter}/versions/*/restore`, async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    if (conflict) return route.fulfill({ status: 409, json: { error: { message: 'A collaborator saved another version.' } } });
    if (receipts.has(body.operationId)) {
      failHistory = true;
      return route.fulfill({ json: receipts.get(body.operationId) });
    }
    receipts.set(body.operationId, { version: 2, versionId: 'restored-fixture', document: { chapterId: chapter, version: 2, nodes: [{ id: 'restored', type: 'paragraph', text: 'Confirmed restored manuscript.' }] } });
    return route.abort('failed'); // Write accepted, response lost.
  });
  await page.goto('http://127.0.0.1:4398/books/88888888-8888-4888-8888-888888888888');
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  const editor = page.locator('.tiptap');
  await editor.fill('My unsaved draft survives uncertain restore.');
  await page.getByRole('button', { name: 'Restore version 1', exact: true }).click();
  await page.getByRole('button', { name: 'Retry original restore' }).waitFor();
  assert.match(await editor.innerText(), /unsaved draft survives/);
  assert.equal(await editor.getAttribute('contenteditable'), 'false');
  await page.getByRole('button', { name: 'Retry original restore' }).click();
  await page.getByText('Restored as version 2.', { exact: true }).waitFor();
  await page.getByText('Restore succeeded, but version history could not refresh. Reload the chapter to refresh history.').waitFor();
  assert.equal((await editor.innerText()).trim(), 'Confirmed restored manuscript.');
  assert.deepEqual(requests[0], requests[1]); assert.equal(receipts.size, 1);
  assert.equal(await page.getByRole('button', { name: 'Retry original restore' }).count(), 0);
  conflict = true;
  await editor.fill('Keep this draft after a restore conflict.');
  await page.getByRole('button', { name: 'Restore version 1', exact: true }).click();
  await page.getByRole('button', { name: 'Reload saved version', exact: true }).waitFor();
  assert.match(await editor.innerText(), /Keep this draft/);
  assert.equal(await page.getByRole('button', { name: 'Download my draft', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Save chapter', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS restore: lost response retry identity, one accepted version, draft protection, confirmed receipt despite history outage and conflict recovery.');
} finally { await browser.close(); }
