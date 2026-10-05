// Real Next UI/auth with synthetic quote API responses; no database or provider calls.
import assert from 'node:assert/strict';
import { chromium, expect as baseExpect } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 20_000 });
const origin = process.env.BROWSER_TEST_ORIGIN ?? 'http://localhost:4398';
const bookId = '88888888-8888-4888-8888-888888888888';
const chapterId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const requestId = '99999999-9999-4999-8999-999999999999';
const proposalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const chapterNodeId = 'abababab-abab-4bab-8bab-abababababab';
const initialVersionId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
const appliedVersionId = 'dededede-dede-4ede-8ede-dededededede';
const aiQuoteId = '12121212-1212-4212-8212-121212121212';
const aiJobId = '13131313-1313-4313-8313-131313131313';
const aiSuggestionId = '14141414-1414-4414-8414-141414141414';
const generatedText = 'Mara stepped onto the pier as the tide began to turn.';
const blueprint = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: 3,
  story: { workingTitle: 'The Harbor Bell', premise: 'A keeper hears a bell beneath the tide.', readerPromise: 'A quiet mystery.', genre: 'Fantasy', tone: 'Hopeful', pointOfView: 'Third person', tense: 'Past', targetWordCount: 60000, synopsis: 'A keeper follows the sound.', theme: 'Trust', notes: 'Private planning notes.' },
  chapterPlan: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'The First Tide', purpose: 'Open the mystery', summary: 'A bell rings at dawn.', targetWords: 1200 }],
  materializations: [], updatedAt: '2026-09-23T00:00:00Z',
};
let statusReads = 0;
let releaseQuote = false;
let failNextRecoveryRead = false;
let quotePosts = 0;
let generationRequests = 0;
let aiGenerationRequests = 0;
let aiQuoteRequests = 0;
let aiApplyRequests = 0;
let materializeRequests = 0;
let chapterDocument = null;
let chapterVersions = [];
let acceptedReview = null;
let lostAcceptReply = true;
const errors = [];
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_TEST_CHANNEL ? { channel: process.env.BROWSER_TEST_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(45_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.dismiss());
  await page.route('**/api/backend/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/backend/v1', '');
    const json = (body, status = 200) => route.fulfill({ status, json: body, headers: { 'cache-control': 'private, no-store' } });
    if (path === `/books/${bookId}/story-blueprint` && request.method() === 'GET') return json({ blueprint, role: 'owner' });
    if (path === `/books/${bookId}/story-blueprint/models`) return json({ catalogVersion: 'synthetic-v1', models: [{ id: 'fixture-model', label: 'Synthetic test model', model: 'synthetic-model' }] });
    if (path === `/books/${bookId}/story-blueprint/chapters/cccccccc-cccc-4ccc-8ccc-cccccccccccc/materialize` && request.method() === 'POST') {
      materializeRequests++;
      const body = request.postDataJSON();
      assert.equal(body.expectedRevision, 3);
      assert.equal(body.idempotencyKey, `story-blueprint:${bookId}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`);
      blueprint.materializations = [{ planItemId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', chapterId }];
      chapterDocument = { chapterId, version: 1, nodes: [{ id: chapterNodeId, type: 'paragraph', text: '' }] };
      chapterVersions = [{ id: initialVersionId, chapter_id: chapterId, version_number: 1, plain_text: '', word_count: 0,
        created_at: '2026-09-01T00:00:00Z', change_summary: 'Initial empty chapter' }];
      return json({ chapter: { id: chapterId, book_id: bookId, order_index: 0, title: 'The First Tide', status: 'draft',
        current_document_version_id: initialVersionId, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' } }, 201);
    }
    if (path === `/books/${bookId}` && request.method() === 'GET') return json({ book: {
      id: bookId, workspace_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', title: 'The Harbor Bell', subtitle: null,
      author_name: 'Fixture Author', language: 'en', genre: 'Fantasy', status: 'draft', current_version_id: null,
      created_by: 'ffffffff-ffff-4fff-8fff-ffffffffffff', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    }, role: 'owner' });
    if (path === `/books/${bookId}/chapters` && request.method() === 'GET') return json({ chapters: [{
      id: chapterId, book_id: bookId, order_index: 0, title: 'The First Tide', status: 'draft', current_document_version_id: chapterDocument ? chapterVersions.at(-1)?.id ?? initialVersionId : null,
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    }] });
    if (path === `/chapters/${chapterId}/document` && request.method() === 'GET') return json({
      chapter: { id: chapterId, book_id: bookId, order_index: 0, title: 'The First Tide', status: 'draft', current_document_version_id: chapterVersions.at(-1)?.id ?? null },
      role: 'owner', document: chapterDocument ?? { chapterId, version: 0, nodes: [] },
    });
    if (path === `/chapters/${chapterId}/versions` && request.method() === 'GET') return json({ versions: chapterVersions });
    if (path === `/books/${bookId}/ai-review/models` && request.method() === 'GET') return json({ catalogVersion: 'fixture-v1', models: [
      { id: 'fixture-model', label: 'Synthetic test model', model: 'synthetic-model', priceVersion: 'fixture-price-v1', policyVersion: 'fixture-policy-v1' },
    ] });
    if (path === '/ai/jobs' && request.method() === 'GET') return json({ jobs: [] });
    if (path === `/books/${bookId}/ai-review/quotes` && request.method() === 'POST') {
      aiQuoteRequests++;
      const body = request.postDataJSON();
      assert.equal(body.modelId, 'fixture-model');
      assert.equal(body.agentType, 'writer');
      assert.deepEqual(body.chapterIds, [chapterId]);
      assert.equal(body.allowProviderTokenCounting, true);
      assert.deepEqual(body.contextPolicy, { includeBookBible: false, includeStyleGuide: true,
        includeRelatedContext: true, semanticTopK: 5, maxTokens: 16000 });
      assert.match(body.userInstruction, /The Harbor Bell.*The First Tide/su);
      assert.doesNotMatch(body.userInstruction, /Private planning notes|A keeper follows the sound/u);
      assert.equal(chapterDocument?.version, 1, 'the paid writer quote must bind to the saved empty chapter version');
      return json({ quote: { requestId: aiQuoteId, status: 'ready', agentType: 'writer', model: 'synthetic-model',
        countedInputTokens: 820, maxOutputTokens: 1600, reservedCredits: 42, expiresAt: '2099-01-01T00:00:00.000Z' } }, 201);
    }
    if (path === `/books/${bookId}/ai-review/quotes/${aiQuoteId}` && request.method() === 'GET') {
      assert.ok(acceptedReview, 'the acceptance must be durable before its lost response is recovered');
      return json({ quote: { requestId: aiQuoteId, status: 'ready', agentType: 'writer', model: 'synthetic-model',
        countedInputTokens: 820, maxOutputTokens: 1600, reservedCredits: 42, expiresAt: '2099-01-01T00:00:00.000Z' },
      job: { id: aiJobId, status: acceptedReview.status } });
    }
    if (path === `/books/${bookId}/ai-review/quotes/${aiQuoteId}/accept` && request.method() === 'POST') {
      aiGenerationRequests++;
      assert.deepEqual(request.postDataJSON(), { expectedCredits: 42 });
      assert.equal(chapterDocument?.version, 1);
      acceptedReview ??= {
        id: aiJobId, book_id: bookId, agent_type: 'writer', status: 'succeeded', model: 'synthetic-model', usage_json: { inputTokens: 820, outputTokens: 120 },
        error_code: null, error_message: null, created_at: '2026-09-01T00:00:00Z', started_at: '2026-09-01T00:00:01Z',
        completed_at: '2026-09-01T00:00:02Z', chapter_ids: [chapterId], context_source_count: 0,
        suggestions: [{ id: aiSuggestionId, ai_job_id: aiJobId, entity_type: 'chapter', entity_id: chapterId,
          operation_json: { operationId: '15151515-1515-4515-8515-151515151515', type: 'replace_text',
            target: { chapterId, nodeId: chapterNodeId }, payload: { nodeId: chapterNodeId, from: 0, to: 0, text: generatedText }, expectedVersion: 1 },
          rationale: 'Draft proposal based on the saved Story Blueprint', confidence: 0.9, status: 'pending',
          created_at: '2026-09-01T00:00:02Z', reviewed_by: null, reviewed_at: null }],
      };
      if (lostAcceptReply) { lostAcceptReply = false; return route.abort(); }
      return json({ jobId: aiJobId, status: 'queued' }, 202);
    }
    if (path === `/ai/jobs/${aiJobId}` && request.method() === 'GET') return json(acceptedReview);
    if (path === `/ai/suggestions/${aiSuggestionId}/apply` && request.method() === 'POST') {
      aiApplyRequests++;
      assert.equal(acceptedReview?.suggestions[0].status, 'pending');
      chapterDocument = { chapterId, version: 2, nodes: [{ id: chapterNodeId, type: 'paragraph', text: generatedText }] };
      chapterVersions = [...chapterVersions, { id: appliedVersionId, chapter_id: chapterId, version_number: 2,
        plain_text: generatedText, word_count: 10, created_at: '2026-09-01T00:00:03Z', change_summary: 'Applied writer suggestion' }];
      acceptedReview.suggestions[0].status = 'accepted';
      acceptedReview.suggestions[0].reviewed_by = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      acceptedReview.suggestions[0].reviewed_at = '2026-09-01T00:00:03Z';
      return json({ suggestionId: aiSuggestionId, status: 'accepted', version: 2, versionId: appliedVersionId });
    }
    if (path === `/books/${bookId}/story-blueprint/quotes` && request.method() === 'POST') {
      quotePosts++;
      const body = request.postDataJSON();
      assert.equal(body.modelId, 'fixture-model');
      assert.match(body.idempotencyKey, /^[0-9a-f-]{36}$/u);
      assert.equal(body.allowProviderTokenCounting, true);
      return json({ request: { id: requestId, status: 'queued' }, proposal: null }, 202);
    }
    if (path === `/books/${bookId}/story-blueprint/quote-requests/${requestId}`) {
      statusReads++;
      if (failNextRecoveryRead) {
        failNextRecoveryRead = false;
        return json({ error: { message: 'Temporary fixture read failure' } }, 503);
      }
      if (!releaseQuote) return json({ request: { id: requestId, status: 'counting' }, proposal: null });
      return json({ request: { id: requestId, status: 'ready' }, proposal: {
        id: proposalId, requestId, sourceRevision: 3, model: 'synthetic-model', reservedCredits: 42,
        expiresAt: '2099-01-01T00:00:00.000Z', acceptedJobId: null, status: 'ready',
      } });
    }
    if (/\/story-blueprint\/(proposals|quotes)\//u.test(path) && request.method() === 'POST') generationRequests++;
    if (/\/ai-review\/quotes\/[^/]+\/accept$/u.test(path) && request.method() === 'POST') aiGenerationRequests++;
    if (/\/ai-review\/quotes$/u.test(path) && request.method() === 'POST') aiQuoteRequests++;
    return route.abort();
  });

  await page.goto(`${origin}/books/${bookId}/plan`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /Generate a review-only blueprint proposal/i })).toBeVisible();
  await page.getByLabel(/I agree to send this saved Story Blueprint/i).check();
  await page.getByRole('button', { name: 'Prepare fixed quote' }).click();
  await expect(page.getByText(/queued for one provider token count/i)).toBeVisible();
  assert.equal(quotePosts, 1);
  assert.equal(generationRequests, 0);

  failNextRecoveryRead = true;
  await page.reload();
  await expect(page.locator('[aria-label="Recovering saved Story Blueprint quote"], [aria-label="Preparing Story Blueprint quote"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare fixed quote' })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.locator('[aria-label="Preparing Story Blueprint quote"]')).toBeVisible();
  await expect(page.getByText('Counting tokens', { exact: true })).toBeVisible();
  releaseQuote = true;
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByText(/42\s+credits maximum hold/u)).toBeVisible();
  assert.equal(quotePosts, 1, 'reload/status recovery must not create a second count request');
  assert.equal(generationRequests, 0, 'preparing a quote must never generate or accept a proposal');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Create empty manuscript chapter' }).click();
  await expect(page.getByText(/Created an empty manuscript chapter for “The First Tide”/u)).toBeVisible();
  assert.equal(materializeRequests, 1, 'the saved plan creates one empty manuscript chapter with its stable request key');
  assert.equal(aiGenerationRequests, 0, 'chapter materialization must not count tokens or start generation');
  const draftLink = page.getByRole('link', { name: 'Draft with saved plan' });
  const draftHref = await draftLink.getAttribute('href');
  assert.ok(draftHref);
  assert.match(draftHref, new RegExp(`chapter=${chapterId}.*draftPlan=cccccccc-cccc-4ccc-8ccc-cccccccccccc`, 'u'));
  assert.doesNotMatch(draftHref, /Harbor|Tide|bell rings|premise/iu, 'the route must contain plan IDs only, never author text');
  await draftLink.click();
  await expect(page.getByRole('combobox', { name: 'Task' })).toHaveValue('writer');
  await expect(page.locator('#ai-model')).toHaveValue('fixture-model');
  await expect(page.getByRole('textbox', { name: 'Drafting instruction' })).toHaveValue(/The Harbor Bell.*The First Tide/s);
  await expect(page.getByLabel('Include saved Book Bible canon')).toBeChecked();
  await expect(page.getByLabel('Include saved style guide')).toBeChecked();
  await page.getByLabel('Include saved Book Bible canon').uncheck();
  await expect(page.getByLabel(/I agree to send the selected saved chapter/)).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Prepare usage quote' })).toBeDisabled();
  assert.equal(aiGenerationRequests, 0, 'opening a plan draft must not count tokens or start generation');
  assert.equal(await page.evaluate(() => Object.values(sessionStorage).some(value => value.includes('The Harbor Bell') || value.includes('bell rings at dawn'))), false, 'the plan brief must remain out of browser recovery storage');
  await page.getByLabel(/I agree to send the selected saved chapter/).check();
  await page.getByRole('button', { name: 'Prepare usage quote' }).click();
  await expect(page.getByText('42 credits on acceptance', { exact: true })).toBeVisible();
  assert.equal(aiQuoteRequests, 1, 'provider token counting starts only after explicit consent');
  assert.equal(aiGenerationRequests, 0, 'counting and reviewing a quote must not start generation');
  assert.equal(aiApplyRequests, 0, 'quote preparation must not write the manuscript');
  assert.equal(await page.evaluate(() => Object.values(sessionStorage).some(value => /The Harbor Bell|bell rings at dawn|Private planning notes|A keeper follows the sound/u.test(value))), false, 'a pending paid quote stores only its recovery pointer, never the prompt text');
  await page.getByRole('button', { name: 'Accept · 42 credits' }).click();
  await expect(page.getByText('Recovered the accepted review after an uncertain reply. No second charge was made.')).toBeVisible();
  await expect(page.getByText(generatedText, { exact: true })).toBeVisible();
  await expect(page.locator('.tiptap')).not.toContainText(generatedText);
  assert.equal(aiApplyRequests, 0, 'accepted provider output remains a review-only suggestion until Apply');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.tiptap')).toContainText(generatedText);
  await expect(page.getByText(/Applied as manuscript version 2\. Other suggestions from this review may now be stale\./u)).toBeVisible();
  assert.equal(await page.evaluate(() => Object.values(sessionStorage).some(value => value.includes('The Harbor Bell') || value.includes('bell rings at dawn'))), false, 'the saved-plan brief must never enter browser recovery storage');
  assert.equal(aiQuoteRequests, 1, 'the consented quote is counted once');
  assert.equal(aiGenerationRequests, 1, 'generation begins only after explicit quote acceptance');
  assert.equal(aiApplyRequests, 1, 'the accepted draft changes the manuscript only after explicit Apply');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'quote panel overflows mobile');
  assert.deepEqual(errors, []);
  console.log('PASS Story Blueprint browser: explicit consent, quote, paid acceptance, suggestion review/apply; stable empty-chapter materialization; ID-only exact plan handoff; no raw brief storage; mobile containment. Responses are synthetic.');
} finally { await browser.close(); }
