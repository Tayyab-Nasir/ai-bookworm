/** Real browser regression for the native runner's inert EPUB boundary. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, expect } from '@playwright/test';
import { blockNativeServiceWorkers } from './native-author-files-browser.mjs';

const policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const proof = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><p>Saved Captain Mira</p>`;
const html = `<!doctype html><iframe title="Inert saved proof" sandbox="" referrerpolicy="no-referrer"
  srcdoc="${proof.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`;
let workerRequests = 0;
const server = createServer((request, response) => {
  if (request.url === '/must-not-register.js') { workerRequests++; response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); response.end(html);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript(blockNativeServiceWorkers);
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.name));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.frameLocator('iframe').getByText('Saved Captain Mira', { exact: true })).toBeVisible();
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', '');
  await expect(page.frameLocator('iframe').locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', policy);
  assert.equal(await page.evaluate(() => {
    try { document.querySelector('iframe').contentWindow.document; return false; }
    catch (error) { return error.name === 'SecurityError'; }
  }), true, 'Saved proof gained same-origin access');
  assert.equal(await page.evaluate(async () => {
    try { await navigator.serviceWorker.register('/must-not-register.js'); return false; }
    catch (error) { return error.message === 'Native browser test blocks service-worker registration.'; }
  }), true, 'Native runner allowed service-worker registration');
  await page.screenshot({ fullPage: true, animations: 'disabled' });
  assert.equal(workerRequests, 0); assert.deepEqual(context.serviceWorkers(), []);
  assert.deepEqual(errors, [], 'Runner injected an unhandled error into the saved proof');
  console.log('PASS native browser guard: opaque saved frame, denied worker registration, zero worker requests and zero page errors');
} finally {
  try { if (browser) await browser.close(); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
