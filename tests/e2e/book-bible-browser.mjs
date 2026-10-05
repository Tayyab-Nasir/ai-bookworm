// Real Next UI/cookies/BFF; AI jobs/evidence are simulated and storage is local fixture state.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium, expect as playwrightExpect } from '@playwright/test';
const expect = playwrightExpect.configure({ timeout: 30000 });

assert.equal((await fetch('http://127.0.0.1:4399/health').then(r => r.json())).fixture, true);
const bookId = '88888888-8888-4888-8888-888888888888';
const chapterId = '44444444-4444-4444-8444-444444444444';
const laterChapterId = '44444444-4444-4444-8444-444444444447';
const text = 'Elara arrived before the bells. The harbor was quiet, and a silver compass rested in her palm.';
const citation = { chapterId, documentVersionId: '66666666-6666-4666-8666-666666666666', nodeId: 'opening', textHash: createHash('sha256').update(text).digest('hex') };
const candidate = { suggestionKind: 'book_bible_candidate', status: 'pending', type: 'character', name: 'Elara', description: 'Arrives at the harbor carrying a silver compass.', attributes: { possession: 'silver compass' }, confidence: 0.9, sourceRefs: [citation] };
const job = { id: '99999999-9999-4999-8999-999999999999', status: 'running', createdAt: '2026-09-24T00:00:00Z' };
const quoteJob = { id: '77777777-7777-4777-8777-777777777777', status: 'succeeded' };
const quoteRequestId = '22222222-2222-4222-8222-222222222222';
const reservedCredits = 7;
const quotedAt = new Date(Date.now() + 5 * 60_000).toISOString();
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.dismiss());
  let pending = [job], drafts = [], generations = 0, quoteRequests = 0, acceptances = 0, recoveries = 0, saves = 0, evidenceReads = 0;
  page.on('request', request => { if (request.url().endsWith('/bible') && request.method() === 'POST') saves++; });
  await page.route('**/v1/books/*/memory', async route => {
    const response = await route.fetch();
    const memory = await response.json();
    memory.chapters.push(...['Crossing', 'Letter', 'Return'].map((title, index) => ({
      id: `44444444-4444-4444-8444-44444444444${index + 5}`, title,
      current_document_version_id: citation.documentVersionId,
    })));
    await route.fulfill({ response, json: memory });
  });
  await page.route('**/metadata/drafts', route => route.fulfill({ json: { drafts: [], pending: [] } }));
  await page.route('**/bible/drafts', route => route.fulfill({ json: { drafts, pending } }));
  await page.route('**/bible/reading-plan', route => route.fulfill({ json: {
    fingerprint: 'a'.repeat(64),
    pages: [{ pageIndex: 0, bytes: 20000, completedJobId: 'previous-batch' },
      { pageIndex: 1, bytes: 10000, completedJobId: drafts.length ? job.id : null }],
  } }));
  await page.route('**/bible/models', route => route.fulfill({ json: { catalogVersion: 'fixture-v1', models: [
    { id: 'writer', label: 'Bookworm test model', model: 'gpt-6-astra-2026-09-01', maxOutputTokens: 1200,
      priceVersion: 'price-v1', policyVersion: 'policy-v1' },
  ] } }));
  await page.route('**/bible/quotes', async route => {
    assert.equal(route.request().method(), 'POST');
    const body = route.request().postDataJSON();
    assert.equal(body.allowProviderTokenCounting, true);
    assert.equal(body.maxTokens, 12000);
    assert.ok(body.chapterIds.length >= 1 && body.chapterIds.length <= 3);
    quoteRequests++;
    await route.fulfill({ status: 201, json: { quote: { requestId: quoteRequestId, status: 'ready',
      model: 'gpt-6-astra-2026-09-01', countedInputTokens: 420, maxOutputTokens: 1200,
      reservedCredits, expiresAt: quotedAt } } });
  });
  await page.route('**/bible/quotes/*/accept', async route => {
    assert.equal(route.request().method(), 'POST');
    assert.equal(route.request().postDataJSON().expectedCredits, reservedCredits);
    acceptances++;
    await route.fulfill({ status: 202, json: { jobId: quoteJob.id, status: 'queued' } });
  });
  await page.route('**/bible/quotes/*', async route => {
    assert.equal(route.request().method(), 'GET');
    await route.fulfill({ json: { quote: { requestId: quoteRequestId, status: 'accepted',
      model: 'gpt-6-astra-2026-09-01', countedInputTokens: 420, maxOutputTokens: 1200,
      reservedCredits, expiresAt: quotedAt }, job: quoteJob } });
  });
  await page.route('**/bible/generate', async route => {
    generations++;
    await route.fulfill({ status: 410, json: { error: { code: 'gone', message: 'A funded token quote is required.' } } });
  });
  await page.route('**/bible/jobs/*/recover', async route => {
    recoveries++; pending = [];
    drafts = [{ id: job.id, createdAt: job.createdAt, candidates: [candidate] }];
    await route.fulfill({ json: { candidates: [candidate] } });
  });
  await page.route('**/bible/evidence', async route => {
    evidenceReads++;
    const request = route.request().postDataJSON();
    const later = 'She checked the compass again before leaving the harbor.';
    assert.deepEqual(request, { ...citation, offset: request.offset });
    assert.ok([0, text.length].includes(request.offset));
    if (evidenceReads === 1 || evidenceReads === 3) {
      await route.fulfill({ status: 503, json: { error: { message: 'Saved passage temporarily unavailable.' } } });
      return;
    }
    await route.fulfill({ json: { chapterTitle: 'Arrival', versionNumber: 1, isCurrentVersion: false,
      text: request.offset === 0 ? text : later, truncated: request.offset === 0,
      startOffset: request.offset, endOffset: request.offset === 0 ? text.length : text.length + later.length,
      totalLength: text.length + later.length, nextOffset: request.offset === 0 ? text.length : null } });
  });
  await page.goto(`http://127.0.0.1:4398/books/${bookId}/memory`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  const bible = page.getByRole('region', { name: 'Book Bible' });
  const generate = page.getByRole('button', { name: 'Count tokens and request quote', exact: true });
  const chapter = bible.getByRole('checkbox', { name: 'Arrival', exact: true });
  // First navigation compiles login, memory and BFF routes in isolated dev mode.
  await chapter.waitFor({ timeout: 60000 });
  await expect(chapter).toBeChecked();
  await expect(generate).toBeDisabled();
  await expect(bible.getByRole('checkbox', { name: 'Return', exact: true })).toBeDisabled();
  await expect(bible.getByRole('checkbox', { name: 'Crossing', exact: true })).toBeDisabled();
  await expect(bible.getByRole('checkbox', { name: 'Letter', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Prepare reading batches · no credits' }).click();
  await expect(page.getByRole('combobox', { name: /Reading batch/ })).toHaveValue('1');
  assert.equal(generations, 0, 'planning must not generate');
  await expect(page.getByText('One extraction is still pending.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Load saved candidate drafts · no credits' }).click();
  await expect(generate).toBeDisabled();
  await page.getByRole('button', { name: 'Recover existing result', exact: true }).click();
  await bible.getByRole('checkbox', { name: 'Crossing', exact: true }).uncheck();
  await bible.getByRole('checkbox', { name: 'Letter', exact: true }).uncheck();
  await chapter.uncheck(); await expect(generate).toBeDisabled();
  await chapter.check();
  await bible.getByRole('checkbox', { name: 'Return', exact: true }).check();
  await page.getByRole('button', { name: 'Prepare reading batches · no credits' }).click();
  await page.getByRole('button', { name: 'Read source passage' }).click();
  await expect(page.getByText('Saved passage temporarily unavailable.', { exact: true })).toBeVisible();
  await expect(page.locator('blockquote')).toHaveCount(0);
  await page.getByRole('button', { name: 'Read source passage' }).click();
  await expect(page.locator('blockquote')).toHaveText(text);
  await expect(page.getByText(/an earlier version; the chapter has changed/)).toBeVisible();
  await page.getByRole('button', { name: 'Hide source passage' }).click();
  await page.getByRole('button', { name: 'Read source passage' }).click();
  assert.equal(evidenceReads, 2, 'reopening should reuse the verified passage after one retry');
  await page.getByRole('button', { name: 'Next passage section' }).click();
  await expect(page.getByText('Saved passage temporarily unavailable.', { exact: true })).toBeVisible();
  await expect(page.locator('blockquote')).toHaveText(text);
  await page.getByRole('button', { name: 'Next passage section' }).click();
  await expect(page.locator('blockquote')).toHaveText('She checked the compass again before leaving the harbor.');
  await expect(page.getByRole('button', { name: 'Next passage section' })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous passage section' }).click();
  await expect(page.locator('blockquote')).toHaveText(text);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Open as unsaved entry' }).click();
  assert.equal(saves, 0, 'candidate review must not persist canon');
  await page.getByRole('button', { name: 'Save memory entry', exact: true }).click();
  await expect(page.getByText('1 saved entry · changes are saved only when you choose Save.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('1 saved entry · changes are saved only when you choose Save.', { exact: true })).toBeVisible();
  await bible.getByRole('checkbox', { name: 'Crossing', exact: true }).uncheck();
  await bible.getByRole('checkbox', { name: 'Letter', exact: true }).uncheck();
  await bible.getByRole('checkbox', { name: 'Return', exact: true }).check();
  await page.getByRole('button', { name: 'Prepare reading batches · no credits' }).click();
  await expect(page.getByRole('combobox', { name: /Reading batch · 2 of 2 completed/ })).toBeVisible();
  await expect(generate).toBeDisabled();
  assert.equal(saves, 1); assert.equal(generations, 0); assert.equal(recoveries, 1);
  await bible.getByRole('checkbox', { name: 'Return', exact: true }).uncheck();
  await bible.getByRole('checkbox', { name: 'Arrival', exact: true }).check();
  await page.getByRole('button', { name: 'Prepare reading batches · no credits' }).click();
  await page.getByLabel('Approved AI model').waitFor();
  await page.getByLabel(/I agree to send the selected saved manuscript batch to OpenAI for input-token counting/).check();
  await page.getByRole('button', { name: 'Count tokens and request quote', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Exact quote' })).toBeVisible();
  await expect(page.getByText('420 tokens', { exact: true })).toBeVisible();
  await page.getByLabel(/I approve this quote and authorize one candidate extraction/).check();
  await page.getByRole('button', { name: 'Accept quote and start extraction', exact: true }).click();
  await expect(page.getByText(/Accepted extraction · succeeded/)).toBeVisible();
  assert.equal(quoteRequests, 1); assert.equal(acceptances, 1); assert.equal(generations, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS Book Bible browser: chapter selection, pending legacy recovery, historical source reading, explicit save, token quote consent, exact credit acceptance, no fixed-credit generation, reload persistence, mobile containment. AI/evidence/storage are fixtures.');
} finally { await browser.close(); }
