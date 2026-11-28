// Actual React history UI and project styles; isolated browser, no HTTP services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const bundle = await build({ stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client";
  import Timeline from "./apps/web/components/VersionTimeline";
  const root = createRoot(document.getElementById("root"));
  window.renderHistory = (chapterId = "chapter") => root.render(React.createElement(Timeline, {
    key: chapterId, chapterId, versions: window.versions, readOnly: true,
    onRestore: () => { window.writes++; }, loadVersion: window.loadVersion }));`, loader: 'tsx', resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: 'history.js' });
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
const artifacts = await mkdtemp(resolve(tmpdir(), 'bookworm-history-mounted-'));
test.after(() => browser.close());
async function fixture(width = 390) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.route('**/*', route => route.abort());
  await page.setContent('<html><body style="margin:0;background:#131413"><div id="root" style="max-width:420px"></div></body></html>');
  for (const file of bundle.outputFiles.filter(file => file.path.endsWith('.css'))) await page.addStyleTag({ content: file.text });
  await page.evaluate(() => {
    window.writes = 0; window.reads = []; window.mode = 'success'; window.pending = [];
    window.versions = [1, 2].map(version_number => ({ id: `v${version_number}`, chapter_id: 'chapter', version_number,
      plain_text: 'Unchanged text', created_at: '2026-10-23T10:00:00Z' }));
    window.loadVersion = async id => {
      window.reads.push(id);
      if (window.mode === 'defer') await new Promise(resolve => window.pending.push(resolve));
      if (window.mode === 'fail') throw new Error('Saved revision read is unavailable.');
      const version = window.versions.find(v => v.id === id), n = version.version_number;
      return { version: { ...version, chapter_id: window.mode === 'foreign' ? 'foreign' : 'chapter' }, document: {
        chapterId: 'chapter', version: n, nodes: [
          { id: 'heading', type: 'heading', level: n, text: 'Same title' },
          { id: 'image', type: 'image', assetId: '11111111-1111-4111-8111-111111111111', assetVersionNumber: n, caption: n === 1 ? 'Day' : '<img src=x onerror=alert(1)>' },
          { id: 'list', type: 'listItem', text: 'Same list', attributes: { listStart: n, listStyle: 'ordered' } },
          { id: 'table', type: 'table', rows: [[n === 1 ? 'Old cell' : 'New cell']] },
        ] } };
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
  await page.evaluate(() => window.renderHistory());
  await page.getByLabel('Select version 2', { exact: true }).check();
  await page.getByLabel('Select version 1', { exact: true }).check();
  await page.getByRole('button', { name: 'Compare selected' }).click();
  return page;
}
test('read-only history exposes real formatting/image/table changes without mutations or image downloads', async () => {
  const page = await fixture();
  try {
    assert.equal(await page.getByRole('button', { name: /Restore version/ }).count(), 0);
    await page.getByRole('button', { name: 'Compare blocks & formatting' }).click();
    await page.getByText('0 added · 0 removed · 4 changed · 0 reordered', { exact: true }).waitFor();
    await page.locator('summary').filter({ hasText: 'image' }).click();
    await page.getByRole('heading', { name: 'Image revision', exact: true }).waitFor();
    assert.equal(await page.locator('pre').filter({ hasText: '<img src=x' }).textContent(), '<img src=x onerror=alert(1)>');
    assert.equal(await page.locator('img, script[src]').count(), 0, 'Historical data is escaped, not rendered as live media.');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(await page.evaluate(() => ({ reads: window.reads, writes: window.writes })), { reads: ['v1', 'v2'], writes: 0 });
    await page.screenshot({ path: resolve(artifacts, 'history-blocks-narrow.png'), fullPage: true });
  } finally { await page.close(); }
});
test('read failures retry through fresh GETs; wrong-scope responses are never labeled as this chapter', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.mode = 'fail');
    await page.getByRole('button', { name: 'Compare blocks & formatting' }).click();
    await page.getByRole('alert').filter({ hasText: 'unavailable' }).waitFor();
    await page.evaluate(() => window.mode = 'foreign');
    await page.getByRole('button', { name: 'Retry block comparison' }).click();
    await page.getByRole('alert').filter({ hasText: 'identity did not match' }).waitFor();
    assert.equal(await page.locator('summary').count(), 0);
    await page.evaluate(() => window.mode = 'success');
    await page.getByRole('button', { name: 'Retry block comparison' }).click();
    await page.getByText('0 added · 0 removed · 4 changed · 0 reordered', { exact: true }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await page.evaluate(() => window.reads.length), 6);
    assert.equal(await page.evaluate(() => window.writes), 0);
  } finally { await page.close(); }
});
test('late reads cannot repopulate a closed comparison or a different chapter', async () => {
  for (const target of ['closed', 'other-chapter']) {
    const page = await fixture();
    try {
      await page.evaluate(() => window.mode = 'defer');
      await page.getByRole('button', { name: 'Compare blocks & formatting' }).click();
      await page.getByRole('status').filter({ hasText: 'Reading v1 and v2' }).waitFor();
      if (target === 'closed') await page.getByRole('button', { name: 'Close comparison' }).click();
      else await page.evaluate(() => { window.versions = []; window.renderHistory('other-chapter'); });
      await page.evaluate(() => { window.mode = 'success'; window.pending.forEach(resolve => resolve()); });
      assert.equal(await page.getByRole('region', { name: 'Saved block comparison' }).count(), 0);
      assert.equal(await page.evaluate(() => window.writes), 0);
    } finally { await page.close(); }
  }
});
test('large changed-block lists are paged and explicit value previews stay bounded', async () => {
  const page = await fixture(1280);
  try {
    await page.evaluate(() => {
      window.loadVersion = async id => {
        const version = window.versions.find(v => v.id === id);
        return { version, document: { chapterId: 'chapter', version: version.version_number,
          nodes: Array.from({ length: 45 }, (_, index) => ({ id: String(index), type: 'paragraph', text: id === 'v1' ? 'Old' : 'Long '.repeat(500) })) } };
      }; window.renderHistory();
    });
    await page.getByRole('button', { name: 'Compare blocks & formatting' }).click();
    await page.getByText('Showing 20 of 45 changed blocks.', { exact: true }).waitFor();
    assert.equal(await page.locator('summary').count(), 20);
    await page.locator('summary').first().click();
    await page.locator('details').first().getByText('Preview limited to 2,000 characters. The full value remains saved.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show next 20 changes' }).click();
    await page.getByRole('button', { name: 'Show next 5 changes' }).click();
    assert.equal(await page.locator('summary').count(), 45);
  } finally { await page.close(); }
});
console.log(`History UI artifacts: ${artifacts}`);
