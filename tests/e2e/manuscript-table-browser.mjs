// Real Next/editor UI with synthetic Auth/API persistence. No hosted services.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const origin = process.env.BROWSER_TEST_ORIGIN ?? 'http://localhost:4498';
const fixtureOrigin = process.env.BROWSER_TEST_FIXTURE_ORIGIN ?? 'http://127.0.0.1:4499';
assert.equal((await fetch(`${fixtureOrigin}/health`).then(r => r.json())).fixture, true);
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
const bookId = '88888888-8888-4888-8888-888888888888';
const chapterId = '44444444-4444-4444-8444-444444444444';
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.dismiss());
  const rows = [['Name', '', 'Role'], ['Mira', 'Captain', 'Harbor'], ['', 'Navigator', 'Sea']];
  const text = rows.map(row => row.join('\t')).join('\n');
  const imported = { id: 'imported-table', type: 'table', rows, text, attributes: { tableHeaderRows: 1,
    tableSpanSource: createHash('sha256').update(text).digest('hex'), tableSpans: [
      { row: 0, col: 0, rowspan: 1, colspan: 2 }, { row: 1, col: 0, rowspan: 2, colspan: 1 },
    ] } };
  let seeded = false, viewer = false, saved, initialVersion;
  await page.route(`**/api/backend/v1/chapters/${chapterId}/document`, async route => {
    if (route.request().method() === 'PUT') {
      saved = route.request().postDataJSON();
      return route.continue();
    }
    const response = await route.fetch();
    const body = await response.json();
    if (!seeded) { body.document.nodes = [imported]; initialVersion = body.document.version; seeded = true; }
    if (viewer) body.role = 'viewer';
    return route.fulfill({ response, json: body });
  });
  await page.goto(`${origin}/books/${bookId}`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  const table = page.getByRole('region', { name: 'Manuscript table', exact: true });
  await table.locator('th[colspan="2"]').waitFor();
  assert.equal(await table.locator('td[rowspan="2"]').count(), 1);
  await table.getByRole('button', { name: 'Edit table', exact: true }).click();
  await table.getByLabel('Row 2, column 1', { exact: true }).fill('Mira revised');
  assert.equal(await table.locator('td[rowspan="2"]').count(), 1, 'cell edit flattened imported merge');
  const select = (row, col) => table.getByRole('button', { name: `Select row ${row}, column ${col}`, exact: true }).click();
  await select(2, 2); await select(3, 3);
  await table.getByRole('button', { name: 'Merge selected', exact: true }).click();
  assert.equal(await table.getByLabel('Row 2, column 2', { exact: true }).inputValue(), 'Captain\nHarbor\nNavigator\nSea');
  assert.equal(await table.locator('td[rowspan="2"][colspan="2"]').count(), 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await table.getByLabel('Row 3, column 3', { exact: true }).waitFor();
  assert.equal(await table.getByLabel('Row 2, column 1', { exact: true }).inputValue(), 'Mira revised', 'undo merge also undid cell typing');
  assert.equal(await table.getByLabel('Row 2, column 2', { exact: true }).inputValue(), 'Captain');
  await table.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await select(2, 2); await select(3, 3);
  await table.getByRole('button', { name: 'Merge selected', exact: true }).click();
  await table.getByRole('button', { name: 'Split selected cell', exact: true }).click();
  assert.equal(await table.getByLabel('Row 2, column 2', { exact: true }).inputValue(), 'Captain\nHarbor\nNavigator\nSea');
  assert.equal(await table.getByLabel('Row 3, column 3', { exact: true }).inputValue(), '');
  await table.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await select(1, 1); await select(2, 1);
  await table.getByRole('button', { name: 'Merge selected', exact: true }).click();
  await table.getByRole('alert').filter({ hasText: 'Header and body cells cannot be merged together.' }).waitFor();
  await page.getByRole('button', { name: 'Save chapter', exact: true }).click();
  await page.getByText(`Saved version ${initialVersion + 1}.`, { exact: true }).waitFor();
  const savedTable = saved.nodes.find(node => node.type === 'table');
  assert.equal(savedTable.rows[1][0], 'Mira revised');
  assert.equal(savedTable.rows[1][1], 'Captain\nHarbor\nNavigator\nSea');
  assert.deepEqual(savedTable.attributes.tableSpans, imported.attributes.tableSpans);
  assert.equal(savedTable.attributes.tableSpanSource, `v2:${createHash('sha256').update(JSON.stringify(savedTable.rows)).digest('hex')}`);
  if (process.env.BROWSER_TEST_TABLE_JSON) await writeFile(process.env.BROWSER_TEST_TABLE_JSON, JSON.stringify(savedTable), 'utf8');
  await page.reload();
  await table.locator('th[colspan="2"]').waitFor();
  assert.match(await table.locator('td[rowspan="2"]').innerText(), /Mira revised/);
  if (process.env.BROWSER_TEST_SCREENSHOT) await table.screenshot({ path: process.env.BROWSER_TEST_SCREENSHOT });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'table overflows mobile viewport');
  await table.getByRole('button', { name: 'Edit table', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'table editing overflows mobile viewport');
  viewer = true;
  await page.reload();
  await page.getByText('Read-only access', { exact: true }).waitFor();
  await table.locator('th[colspan="2"]').waitFor();
  assert.equal(await table.getByRole('button').count(), 0, 'viewer received table edit controls');
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log('PASS table browser: imported spans, text edit, merge, undo, split, header boundary, save/reload, mobile containment and read-only access. Auth/storage are synthetic.');
} finally { await browser.close(); }
