// UI acceptance only: fixture files are diagnostic text, not real EPUB/ZIPs.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const fixtureOrigin = process.env.BROWSER_TEST_FIXTURE_ORIGIN ?? 'http://127.0.0.1:4399';
const appOrigin = process.env.BROWSER_TEST_ORIGIN ?? 'http://127.0.0.1:4398';
for (const origin of [fixtureOrigin, appOrigin]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'publishing acceptance must remain loopback-only');
assert.equal((await fetch(`${fixtureOrigin}/health`).then((r) => r.json())).fixture, true);
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_TEST_CHANNEL ? { channel: process.env.BROWSER_TEST_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(25000);
  page.setDefaultNavigationTimeout(60000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const audioResponses = [];
  page.on('response', async (response) => {
    if (response.url().includes('/audio-download')) audioResponses.push(await response.allHeaders());
  });
  page.on('dialog', (dialog) => dialog.dismiss());
  const url = `${appOrigin}/books/88888888-8888-4888-8888-888888888888/publish`;
  await page.goto(url);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/books\/88888888-8888-4888-8888-888888888888\/publish(?:\?|$)/, { timeout: 60000 });
  await page.getByRole('button', { name: 'New EPUB', exact: true }).click();
  assert.equal(await page.getByLabel('Layout starter').count(), 0, 'reflowable EPUB offered paginated layout starters');
  await page.getByLabel('Include EPUB title page', { exact: false }).check();
  await page.getByLabel('Publisher or imprint', { exact: true }).fill('Finch & Fox');
  await page.getByLabel('Copyright notice', { exact: true }).fill('Copyright Ada\nPermission required.');
  await page.getByLabel('Add QR code').check();
  await page.getByLabel('HTTPS destination').fill('https://author.example/harbor');
  await page.getByLabel('QR label', { exact: true }).fill('Read more');
  await page.getByLabel('Flow').selectOption('fixed');
  await page.getByLabel('Layout starter').selectOption('trade-paperback');
  assert.equal(await page.getByLabel('Body size (pt)').inputValue(), '11');
  assert.equal(await page.getByLabel('Line spacing (pt)').inputValue(), '14.5');
  assert.equal(await page.getByLabel('Include EPUB title page', { exact: false }).isChecked(), true);
  assert.equal(await page.getByLabel('HTTPS destination').inputValue(), 'https://author.example/harbor');
  await page.getByRole('button', { name: 'Save edition', exact: true }).click();
  await page.getByText('Edition settings saved.', { exact: true }).waitFor();
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some((e) => e.value === 'https://author.example/harbor'));
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some((e) => e.value === 'Copyright Ada\nPermission required.'));
  assert.equal(await page.getByLabel('Publisher or imprint', { exact: true }).inputValue(), 'Finch & Fox');
  assert.equal(await page.getByRole('textbox', { name: 'Copyright notice', exact: true }).inputValue(), 'Copyright Ada\nPermission required.');
  assert.equal(await page.getByLabel('Include EPUB title page', { exact: false }).isChecked(), true);
  assert.equal(await page.getByLabel('Flow').inputValue(), 'fixed');
  assert.equal(await page.getByLabel('Line spacing (pt)').inputValue(), '14.5');
  const packageButton = page.getByRole('button', { name: 'Create retailer package', exact: true });
  assert.equal(await packageButton.isEnabled(), false);
  await page.getByLabel('Preflight target').selectOption('kdp');
  await page.getByRole('button', { name: 'Render EPUB', exact: true }).click();
  await page.getByRole('link', { name: 'Download private file', exact: true }).waitFor();
  assert.equal(await packageButton.isEnabled(), false, 'packaging allowed before preflight');
  await page.getByRole('button', { name: 'Run preflight', exact: true }).click();
  await page.getByText('0 errors', { exact: true }).waitFor();
  await packageButton.click();
  const download = page.getByRole('link', { name: 'Download private ZIP', exact: true });
  await download.waitFor();
  const before = await download.getAttribute('href');
  const transfer = page.waitForEvent('download'); await download.click();
  assert.equal(await (await transfer).failure(), null, 'fixture download failed');
  await page.reload(); await download.waitFor();
  assert.notEqual(await download.getAttribute('href'), before, 'history did not refresh download URL');
  await page.getByRole('button', { name: 'New print', exact: true }).click();
  await page.getByLabel('Include chapter contents', { exact: false }).check();
  await page.getByLabel('Publisher or imprint', { exact: true }).fill('Print Imprint');
  await page.getByLabel('Copyright notice', { exact: true }).fill('Print permission notice.');
  await page.getByLabel('Body font').selectOption('BookwormVera');
  await page.getByLabel('Cover artwork').selectOption({ index: 1 });
  await page.getByLabel('Create full cover PDF', { exact: true }).check();
  await page.getByLabel('Paper and printer').selectOption('custom');
  await page.getByLabel('Template spine width (in)', { exact: true }).fill('0.415');
  await page.getByLabel('Template page count', { exact: true }).fill('184');
  await page.getByLabel('Back cover text', { exact: true }).fill('A journey through the harbor.');
  await page.getByLabel('Spine text (optional)', { exact: true }).fill('The Long Way Home');
  await page.getByLabel('Starting page number').fill('17');
  await page.getByLabel('Bleed').selectOption('0.125');
  await page.getByLabel('Interior bleed edges').selectOption('all');
  await page.getByLabel('Add QR code').check();
  await page.getByLabel('HTTPS destination').fill('https://author.example/print');
  await page.getByLabel('QR label', { exact: true }).fill('Print companion');
  await page.getByLabel('Layout starter').selectOption('large-print');
  assert.equal(await page.getByLabel('Body size (pt)').inputValue(), '16');
  assert.equal(await page.getByLabel('Line spacing (pt)').inputValue(), '20');
  assert.equal(await page.getByLabel('Trim size').inputValue(), '6x9');
  assert.equal(await page.getByLabel('Cover artwork').inputValue(), '55555555-5555-4555-8555-555555555555');
  assert.equal(await page.getByLabel('Interior bleed edges').inputValue(), 'all');
  assert.equal(await page.getByLabel('Starting page number').inputValue(), '17');
  assert.equal(await page.getByLabel('HTTPS destination').inputValue(), 'https://author.example/print');
  assert.equal(await page.getByLabel('Include chapter contents', { exact: false }).isChecked(), true);
  await page.getByRole('button', { name: 'Save edition', exact: true }).click();
  await page.getByText('Edition settings saved.', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: /^print /i }).click();
  assert.equal(await page.getByLabel('Include chapter contents', { exact: false }).isChecked(), true);
  assert.equal(await page.getByLabel('Publisher or imprint', { exact: true }).inputValue(), 'Print Imprint');
  assert.equal(await page.getByRole('textbox', { name: 'Copyright notice', exact: true }).inputValue(), 'Print permission notice.');
  assert.equal(await page.getByLabel('Create full cover PDF', { exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel('Template spine width (in)', { exact: true }).inputValue(), '0.415');
  assert.equal(await page.getByLabel('Template page count', { exact: true }).inputValue(), '184');
  assert.equal(await page.getByLabel('Back cover text').inputValue(), 'A journey through the harbor.');
  assert.equal(await page.getByLabel('Body font').inputValue(), 'BookwormVera');
  assert.equal(await page.getByLabel('Body size (pt)').inputValue(), '16');
  assert.equal(await page.getByLabel('Interior bleed edges').inputValue(), 'all');
  assert.equal(await page.getByLabel('HTTPS destination').inputValue(), 'https://author.example/print');
  await page.getByLabel('Preflight target').selectOption('lulu');
  await page.getByRole('button', { name: 'Render PDF', exact: true }).click();
  await page.getByRole('link', { name: 'Download private file', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Run preflight', exact: true }).click();
  await page.getByText('0 errors', { exact: true }).waitFor();
  assert.equal(await packageButton.isEnabled(), true, 'saved large-print proof was not ready for packaging');
  await page.getByLabel('Layout starter').selectOption('poetry');
  assert.equal(await page.getByLabel('Body size (pt)').inputValue(), '12');
  assert.equal(await page.getByLabel('Line spacing (pt)').inputValue(), '18');
  assert.equal(await page.getByRole('button', { name: 'Render PDF', exact: true }).isEnabled(), false);
  assert.equal(await page.getByRole('button', { name: 'Run preflight', exact: true }).isEnabled(), false);
  assert.equal(await packageButton.isEnabled(), false, 'stale render/preflight allowed packaging after a preset change');
  await page.getByRole('button', { name: 'Save edition', exact: true }).click();
  await page.getByText('Edition settings saved.', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: /^print /i }).click();
  assert.equal(await page.getByLabel('Body size (pt)').inputValue(), '12');
  assert.equal(await page.getByLabel('Line spacing (pt)').inputValue(), '18');
  assert.equal(await page.getByLabel('Create full cover PDF', { exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel('HTTPS destination').inputValue(), 'https://author.example/print');
  assert.equal(await page.getByLabel('Interior bleed edges').inputValue(), 'all');
  await page.getByLabel('Preflight target').selectOption('lulu');
  await page.getByRole('button', { name: 'Render PDF', exact: true }).click();
  await page.getByRole('link', { name: 'Download private file', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Run preflight', exact: true }).click();
  await page.getByText('0 errors', { exact: true }).waitFor();
  await page.getByLabel('Preflight target').selectOption('apple');
  assert.equal(await page.getByRole('button', { name: 'Run preflight', exact: true }).isEnabled(), false, 'print accepted for Apple');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'publishing mobile overflow');
  await page.getByRole('button', { name: 'New audio', exact: true }).click();
  await page.getByRole('button', { name: 'Save edition', exact: true }).click();
  const audioButton = page.getByRole('button', { name: 'Download chapter + QC report', exact: true });
  await audioButton.click();
  await page.getByRole('alert').filter({ hasText: 'Fixture assembly busy. Try again.' }).waitFor();
  const audioTransfer = page.waitForEvent('download');
  await audioButton.click();
  const audioFile = await audioTransfer;
  assert.equal(await audioFile.failure(), null);
  assert.match(audioFile.suggestedFilename(), /^chapter-.*\.mp3$/);
  const qcReport = page.getByRole('region', { name: 'Audiobook audio quality report' });
  await qcReport.waitFor();
  await qcReport.getByText(/-20\.0 dB RMS/).waitFor();
  await qcReport.getByText(/noise Floor: manual review — listening required/i).waitFor();
  await qcReport.getByText(/not marked ACX-eligible/i).waitFor();
  assert.equal(audioResponses.length, 2, 'audio retry sequence changed');
  assert.equal(audioResponses[1]['content-disposition'], 'attachment; filename="chapter.mp3"');
  assert.match(audioResponses[1]['x-bookworm-audio-qc'] ?? '', /"acxNarrationPolicy":"explicit_authorization_required_for_ai_voice"/);
  assert.equal(audioResponses[1]['x-bookworm-audio-qc-report-id'], 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  const listeningAttestation = page.getByLabel('I listened through this exact downloaded chapter and reviewed its narration, edits, room tone, and pronunciation.');
  await listeningAttestation.waitFor();
  await listeningAttestation.check();
  await page.getByRole('button', { name: 'Save listening sign-off', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Listening sign-off saved for this exact audio file.' }).waitFor();
  await page.getByText(/signed by you/i).waitFor();
  await page.getByLabel('ISBN-13 or publisher book ID', { exact: true }).fill('9780306406157');
  await page.getByLabel('Audiobook cover', { exact: false }).selectOption('55555555-5555-4555-8555-555555555555');
  const queueExport = page.getByRole('button', { name: 'Queue Google Play archive', exact: true });
  await queueExport.click();
  await page.getByRole('alert').filter({ hasText: 'Fixture export reply lost. Retry safely.' }).waitFor();
  await queueExport.click();
  await page.getByRole('status').filter({ hasText: 'Export queued.' }).waitFor();
  const state = () => fetch(`${fixtureOrigin}/fixture-export-state`).then((r) => r.json());
  assert.equal((await state()).jobs.length, 1, 'uncertain response retry created duplicate exports');
  assert.equal((await state()).keys.length, 1, 'retry rotated the idempotency key');
  await page.reload();
  await page.getByRole('button', { name: /^audiobook /i }).click();
  await page.getByRole('progressbar', { name: 'Audiobook export progress' }).waitFor();
  await page.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Export cancelled.' }).waitFor();
  await page.getByText('This export was cancelled before completion.', { exact: true }).waitFor();
  await page.getByLabel('ISBN-13 or publisher book ID', { exact: true }).fill('9780306406157');
  await page.getByLabel('Audiobook cover', { exact: false }).selectOption('55555555-5555-4555-8555-555555555555');
  await queueExport.click();
  await page.getByRole('status').filter({ hasText: 'Export queued.' }).waitFor();
  assert.equal((await state()).jobs.length, 2, 'new request reused cancelled export identity');
  const advance = (status) => fetch(`${fixtureOrigin}/fixture-export-state`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }),
  });
  await advance('running');
  await page.getByText('Assembling and verifying private files', { exact: true }).waitFor();
  await advance('succeeded');
  const archiveLink = page.getByRole('link', { name: 'Download private ZIP', exact: true });
  await archiveLink.waitFor();
  const archiveUrl = await archiveLink.getAttribute('href');
  const googlePlayTransfer = page.waitForEvent('download');
  await archiveLink.click();
  assert.equal(await (await googlePlayTransfer).failure(), null);
  await page.getByText(/disclose “Synthesized voice” on upload/).waitFor();
  await page.reload();
  await page.getByRole('button', { name: /^audiobook /i }).click();
  await archiveLink.waitFor();
  assert.notEqual(await archiveLink.getAttribute('href'), archiveUrl, 'export history did not refresh private download URL');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'audiobook mobile overflow');
  // Seed saved string overrides only in the authenticated local fixture. Native
  // shaping and PNG/EPUB bytes are covered by Python tests, not these UI files.
  const editionsUrl = `${appOrigin}/api/backend/v1/books/88888888-8888-4888-8888-888888888888/editions`;
  // Chromium sends the real HttpOnly secure cookie on the trusted loopback
  // origin. Playwright's separate API client filters it on HTTP 127.0.0.1;
  // use the authenticated browser without copying or relaxing those cookies.
  const editionRequest = (method, body) => page.evaluate(async ({ url, method, body }) => {
    if (new URL(url).origin !== location.origin) throw new Error('Fixture request must stay same-origin');
    const response = await fetch(url, { method, credentials: 'same-origin',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, payload: await response.json() };
  }, { url: editionsUrl, method, body });
  let selectedSafetyEditionId;
  await page.route(editionsUrl, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    const selected = payload.editions.find((edition) => edition.id === selectedSafetyEditionId);
    assert.ok(selected, 'saved safety fixture edition missing on reload');
    await route.fulfill({ response, json: { ...payload, editions: [selected, ...payload.editions.filter((edition) => edition.id !== selected.id)] } });
  });
  const renderRequests = [];
  page.on('request', (request) => { if (/\/api\/backend\/v1\/editions\/[^/]+\/render$/.test(new URL(request.url()).pathname)) renderRequests.push(request.url()); });
  const artwork = { asset_id: '55555555-5555-4555-8555-555555555555', title_on_cover: true, subtitle_on_cover: true, author_on_cover: true };
  const emptyText = { title: '', subtitle: '', author: '' };
  const safetyCases = [
    { name: 'override RTL after English edition', language: 'en', config: { kind: 'ebook', flow: 'reflowable', cover: artwork, metadata_overrides: { language: 'ar' } }, coverBlocked: true, printBlocked: false },
    { name: 'explicit LTR does not waive override shaping', language: 'en', config: { kind: 'ebook', text_direction: 'ltr', cover: artwork, metadata_overrides: { language: 'ar' } }, coverBlocked: true, printBlocked: false },
    { name: 'empty overlays retain artwork-only RTL render', language: 'ar', config: { kind: 'ebook', cover: artwork, metadata_overrides: { ...emptyText, language: 'ar' } }, coverBlocked: false, printBlocked: false, saveReload: true },
    { name: 'English override wins over RTL edition', language: 'ar', config: { kind: 'ebook', cover: artwork, metadata_overrides: { language: 'en' } }, coverBlocked: false, printBlocked: false },
    { name: 'fixed layout still requires shaping without visible cover text', language: 'en', config: { kind: 'ebook', flow: 'fixed', text_direction: 'ltr', cover: artwork, metadata_overrides: { ...emptyText, language: 'ar' } }, coverBlocked: false, printBlocked: true },
    { name: 'print explicit LTR does not waive base typography', language: 'ar', config: { kind: 'print', text_direction: 'ltr', cover: artwork }, coverBlocked: true, printBlocked: true },
    { name: 'legacy English cover remains renderable', language: 'en', config: { kind: 'ebook', cover: artwork }, coverBlocked: false, printBlocked: false },
  ];
  for (const safety of safetyCases) {
    const saved = await editionRequest('POST', { language: safety.language, config: safety.config });
    assert.equal(saved.status, 201, `${safety.name}: fixture save failed`);
    selectedSafetyEditionId = saved.payload.id;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('fieldset')?.disabled === false);
    assert.equal(await page.getByLabel('Language', { exact: true }).inputValue(), safety.language);
    const renderButton = page.getByRole('button', { name: safety.config.kind === 'print' ? 'Render PDF' : 'Render EPUB', exact: true });
    const blocked = safety.coverBlocked || safety.printBlocked;
    assert.equal(await renderButton.isEnabled(), !blocked, safety.name);
    assert.equal(await page.getByText('RTL cover text cannot be safely composed with the current cover renderer.', { exact: true }).count(), Number(safety.coverBlocked), `${safety.name}: cover guidance mismatch`);
    assert.equal(await page.getByText('RTL print PDF and fixed EPUB are not available with the current fonts.', { exact: true }).count(), Number(safety.printBlocked), `${safety.name}: pagination guidance mismatch`);
    assert.equal(await page.getByRole('button', { name: 'Run preflight', exact: true }).isEnabled(), true, `${safety.name}: preflight should remain available`);
    if (safety.saveReload) {
      await page.getByLabel('Publisher or imprint', { exact: true }).fill('Fixture Imprint');
      await page.getByRole('button', { name: 'Save edition', exact: true }).click();
      await page.getByText('Edition settings saved.', { exact: true }).waitFor();
      const savedSettings = await editionRequest('GET');
      assert.equal(savedSettings.status, 200, 'saved override settings could not be read');
      const persisted = savedSettings.payload.editions.find((edition) => edition.id === selectedSafetyEditionId);
      assert.deepEqual(persisted.edition_metadata_json.metadata_overrides, safety.config.metadata_overrides, 'saving artwork settings dropped explicit empty text overrides');
      await page.reload();
      await page.waitForFunction(() => document.querySelector('fieldset')?.disabled === false);
      assert.equal(await renderButton.isEnabled(), true, 'saved artwork-only override safety changed on reload');
    }
    const beforeRender = renderRequests.length;
    if (blocked) {
      await renderButton.evaluate((button) => button.click());
      assert.equal(renderRequests.length, beforeRender, `${safety.name}: disabled render sent a request`);
      assert.equal(await renderButton.getAttribute('aria-describedby'), 'rtl-render-guidance');
    } else {
      await renderButton.click();
      await page.getByText('Private render completed.', { exact: true }).waitFor();
      assert.equal(renderRequests.length, beforeRender + 1, `${safety.name}: expected one fixture render request`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${safety.name}: mobile overflow`);
  }
  await page.unroute(editionsUrl);
  assert.deepEqual(errors, []);
  console.log('PASS publishing browser: layout starters for fixed EPUB and print, preserved settings, save/reload, render/preflight/package, audio QC/sign-off, async export response-loss retry identity, reload recovery, cancellation, polled progress, refreshed download URL, disclosure, effective RTL metadata/empty overrides/explicit-LTR shaping guards and mobile. Artifact bytes remain fixtures.');
} finally { await browser.close(); }
