// Synthetic UI acceptance for assigned, version-pinned artwork review.
// Auth uses the isolated GoTrue fixture; review API responses are in-memory.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const origin = process.env.BROWSER_TEST_ORIGIN ?? 'http://localhost:4398';
const fixtureOrigin = process.env.BROWSER_TEST_FIXTURE_ORIGIN ?? 'http://127.0.0.1:4399';
const fixtureHealth = await fetch(`${fixtureOrigin}/health`).then((response) => response.json());
assert.equal(fixtureHealth.fixture, true);

const workspaceId = '33333333-3333-4333-8333-333333333333';
const bookId = '88888888-8888-4888-8888-888888888888';
const chapterId = '44444444-4444-4444-8444-444444444444';
const assetId = '55555555-5555-4555-8555-555555555555';
const authorId = '11111111-1111-4111-8111-111111111111';
const reviewerId = '22222222-2222-4222-8222-222222222222';
const users = new Map([
  [authorId, { id: authorId, email: 'author@example.test', displayName: 'Fixture author' }],
  [reviewerId, { id: reviewerId, email: 'reviewer@example.test', displayName: 'Riley Reviewer' }],
]);

const book = { id: bookId, workspace_id: workspaceId, title: 'Harbor browser journey', subtitle: null,
  author_name: 'Fixture author', language: 'en', genre: 'Fantasy', status: 'draft', updated_at: '2026-09-28T00:00:00.000Z' };
const asset = { id: assetId, workspace_id: workspaceId, type: 'illustration', name: 'Harbor lantern illustration',
  mime_type: 'image/png', storage_path: `${workspaceId}/${assetId}.png`, checksum: 'a'.repeat(64), size_bytes: 68,
  status: 'draft', deleted_at: null, requires_approval: true, current_version_number: 3, current_scan_status: 'clean' };
const members = [
  { workspace_id: workspaceId, user_id: authorId, role: 'editor', status: 'active' },
  { workspace_id: workspaceId, user_id: reviewerId, role: 'reviewer', status: 'active' },
];
const profiles = [
  { id: authorId, display_name: 'Fixture author', avatar_url: null },
  { id: reviewerId, display_name: 'Riley Reviewer', avatar_url: null },
];
const approvals = [];
const createBodies = [];
const decisionBodies = [];
const downloadVersions = [];
let serial = 0;

function approvalFrom(body, requestedBy) {
  const now = '2026-09-29T00:00:00.000Z';
  return {
    id: `approval-${++serial}`, workspace_id: body.workspaceId, entity_type: 'asset', entity_id: body.entityId,
    requested_by: requestedBy, reviewer_id: body.reviewerId, entity_version_number: body.entityVersionNumber,
    request_key: body.idempotencyKey, status: 'pending', comment: body.comment ?? null, resolution_note: null,
    resolved_by: null, resolved_at: null, superseded_at: null, created_at: now, updated_at: now,
  };
}

async function reply(route, status, value) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
}

async function installFixtureRoutes(page, sessionUserId, pageErrors) {
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.route('**/api/auth/session', (route) => reply(route, 200, { user: users.get(sessionUserId) ?? null }));
  await page.route('**/api/backend/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/backend', '');
    const method = request.method();
    if (method === 'GET' && path === `/v1/assets/${assetId}/download-url`) {
      downloadVersions.push(url.searchParams.get('versionNumber'));
      return route.continue();
    }
    if (method === 'GET' && path === '/v1/workspaces') {
      return reply(route, 200, { workspaces: [{ id: workspaceId, name: 'Harbor project', organization_id: 'org-fixture', created_by: authorId }] });
    }
    if (method === 'GET' && path === `/v1/workspaces/${workspaceId}/members`) return reply(route, 200, { members, profiles });
    if (method === 'GET' && path === '/v1/activity') return reply(route, 200, { events: [] });
    if (method === 'GET' && path === '/v1/books') return reply(route, 200, { books: [book] });
    if (method === 'GET' && path === '/v1/assets') return reply(route, 200, { assets: [{ ...asset }] });
    if (method === 'GET' && path === '/v1/approvals') return reply(route, 200, { approvals: approvals.map((item) => ({ ...item })) });
    if (method === 'POST' && path === '/v1/approvals') {
      const body = request.postDataJSON();
      createBodies.push(body);
      let approval = approvals.find((item) => item.request_key === body.idempotencyKey);
      if (!approval) {
        if (body.entityVersionNumber !== asset.current_version_number) return reply(route, 409, { error: { message: 'Artwork version is no longer current.' } });
        approval = approvalFrom(body, sessionUserId);
        approvals.unshift(approval);
        // Server commits, but response is lost. Retry must reuse the exact request key.
        if (createBodies.length === 1) return reply(route, 503, { error: { message: 'Review request reply was lost.' } });
      }
      return reply(route, 201, approval);
    }
    const decision = path.match(/^\/v1\/approvals\/([^/]+)\/(approve|reject)$/u);
    if (method === 'POST' && decision) {
      const [, approvalId, action] = decision;
      const body = request.postDataJSON();
      decisionBodies.push({ approvalId, action, body, actorId: sessionUserId });
      const approval = approvals.find((item) => item.id === approvalId);
      if (!approval || approval.reviewer_id !== sessionUserId || approval.requested_by === sessionUserId) {
        return reply(route, 403, { error: { message: 'Only the assigned independent reviewer may decide.' } });
      }
      if (action === 'reject' && !body.comment?.trim()) return reply(route, 422, { error: { message: 'A rejection note is required.' } });
      if (approval.status !== 'pending') {
        if (approval.resolved_by !== sessionUserId || approval.status !== (action === 'approve' ? 'approved' : 'rejected')
          || approval.resolution_note !== (action === 'reject' ? body.comment.trim() : null)) {
          return reply(route, 409, { error: { message: 'Decision differs from the saved result.' } });
        }
        return reply(route, 200, approval);
      }
      approval.status = action === 'approve' ? 'approved' : 'rejected';
      approval.resolved_by = sessionUserId;
      approval.resolution_note = action === 'reject' ? body.comment.trim() : null;
      approval.resolved_at = '2026-09-29T00:01:00.000Z';
      approval.updated_at = approval.resolved_at;
      if (action === 'approve') asset.status = 'approved';
      if (action === 'reject' && decisionBodies.filter((item) => item.action === 'reject').length === 1) {
        return reply(route, 503, { error: { message: 'Decision reply was lost.' } });
      }
      return reply(route, 200, approval);
    }
    return route.continue();
  });
}

const browser = await chromium.launch({ headless: true,
  ...(process.env.BROWSER_TEST_CHANNEL ? { channel: process.env.BROWSER_TEST_CHANNEL } : {}) });
const errors = [];
let authorContext;
let reviewerContext;
try {
  authorContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const authorPage = await authorContext.newPage();
  await installFixtureRoutes(authorPage, authorId, errors);
  await authorPage.goto(`${origin}/dashboard`);
  await authorPage.getByLabel('Email').fill('author@example.test');
  await authorPage.getByLabel('Password', { exact: true }).fill('fixture-password');
  await authorPage.getByRole('button', { name: /sign in/i }).click();
  await authorPage.locator('#workspace, #workspaceName').first().waitFor();
  await authorPage.goto(`${origin}/approvals?ws=${workspaceId}`);
  const artwork = authorPage.getByLabel('Artwork', { exact: true });
  await artwork.waitFor();
  await artwork.selectOption(assetId);
  const reviewer = authorPage.getByLabel('Assigned reviewer', { exact: true });
  const reviewerOptions = await reviewer.locator('option').allTextContents();
  assert.equal(reviewerOptions.some((option) => option.includes('Fixture author')), false, 'requester cannot assign self');
  await reviewer.selectOption(reviewerId);
  await authorPage.getByLabel('Review brief (optional)').fill('Check the lantern crest and blue palette.');
  await authorPage.getByRole('button', { name: 'Request artwork approval', exact: true }).click();
  await authorPage.getByRole('status').filter({ hasText: 'The response was uncertain.' }).waitFor();
  await authorPage.getByRole('button', { name: 'Retry saved review request', exact: true }).click();
  await authorPage.getByText('You requested this review and cannot decide it.', { exact: true }).waitFor();
  assert.equal(createBodies.length, 2);
  assert.deepEqual(createBodies[1], createBodies[0], 'lost reply retry must replay exact version/reviewer/note/key');
  assert.equal(createBodies[0].entityVersionNumber, 3);

  // A pending request for current version must not remain requestable in UI.
  const pendingOptions = await artwork.locator('option').allTextContents();
  assert.equal(pendingOptions.some((option) => option.includes('v3')), false, 'pending version remains selectable for duplicate review');

  const savedAuth = await authorContext.storageState();
  reviewerContext = await browser.newContext({ storageState: savedAuth, viewport: { width: 1280, height: 900 } });
  const reviewerPage = await reviewerContext.newPage();
  await installFixtureRoutes(reviewerPage, reviewerId, errors);
  await reviewerPage.goto(`${origin}/approvals?ws=${workspaceId}`);
  const assigned = reviewerPage.locator('article').filter({ hasText: 'Harbor lantern illustration' }).filter({ hasText: 'Version 3' });
  await assigned.getByLabel('Required note when rejecting').fill('Please revise the lantern crest.');
  const rejectButton = assigned.getByRole('button', { name: 'Request a revision', exact: true });
  await rejectButton.click();
  await reviewerPage.getByText('The reject response was uncertain. Retry uses the same saved note.', { exact: true }).waitFor();
  await assigned.getByRole('button', { name: 'Request a revision', exact: true }).click();
  await reviewerPage.getByText('Reviewer note: Please revise the lantern crest.', { exact: true }).waitFor();
  const rejectCalls = decisionBodies.filter((item) => item.action === 'reject');
  assert.equal(rejectCalls.length, 2);
  assert.equal(rejectCalls[0].body.comment, rejectCalls[1].body.comment, 'reject recovery changed reviewer note');
  assert.equal(rejectCalls[0].actorId, reviewerId);

  asset.current_version_number = 4;
  asset.status = 'draft';
  await authorPage.reload();
  await authorPage.getByLabel('Artwork', { exact: true }).selectOption(assetId);
  await authorPage.getByLabel('Assigned reviewer', { exact: true }).selectOption(reviewerId);
  await authorPage.getByLabel('Review brief (optional)').fill('Review revised version four.');
  await authorPage.getByRole('button', { name: 'Request artwork approval', exact: true }).click();
  await authorPage.getByText('You requested this review and cannot decide it.', { exact: true }).waitFor();
  assert.equal(createBodies.at(-1).entityVersionNumber, 4);

  await reviewerPage.reload();
  const revised = reviewerPage.locator('article').filter({ hasText: 'Harbor lantern illustration' }).filter({ hasText: 'Version 4' });
  await revised.getByRole('button', { name: 'Approve version', exact: true }).click();
  await reviewerPage.getByText('Artwork version approved.', { exact: true }).waitFor();
  assert.equal(asset.status, 'approved');

  const artworkPage = await authorContext.newPage();
  await installFixtureRoutes(artworkPage, authorId, errors);
  await artworkPage.goto(`${origin}/books/${bookId}`);
  const initialDocument = await artworkPage.evaluate(async (id) => {
    const response = await fetch(`/api/backend/v1/chapters/${id}/document`);
    return response.json();
  }, chapterId);
  await artworkPage.getByRole('button', { name: 'Illustration', exact: true }).click();
  const workspaceImage = artworkPage.getByLabel('Workspace image', { exact: true });
  await workspaceImage.locator(`option[value="${assetId}"]`).waitFor({ state: 'attached' });
  const insertOptions = await workspaceImage.locator('option').allTextContents();
  assert.equal(insertOptions.some((option) => option.includes('Harbor lantern illustration')), true, 'approved exact version missing from chapter picker');
  await workspaceImage.selectOption(assetId);
  await artworkPage.getByLabel('Image description (alt text)').fill('The approved harbor lantern crest');
  const insertButton = artworkPage.getByRole('button', { name: 'Insert illustration', exact: true });
  await artworkPage.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Insert illustration');
    return Boolean(button && !button.disabled);
  });
  await insertButton.click();
  await artworkPage.getByRole('button', { name: 'Save chapter', exact: true }).click();
  await artworkPage.getByText(`Saved version ${initialDocument.document.version + 1}.`, { exact: true }).waitFor();
  const savedDocument = await artworkPage.evaluate(async (id) => {
    const response = await fetch(`/api/backend/v1/chapters/${id}/document`);
    return response.json();
  }, chapterId);
  const imageNode = savedDocument.document.nodes.filter((node) => node.type === 'image').at(-1);
  assert.equal(imageNode.assetId, assetId);
  assert.equal(imageNode.assetVersionNumber, 4, 'chapter placement did not pin approved version');
  await artworkPage.reload();
  await artworkPage.getByAltText('The approved harbor lantern crest', { exact: true }).last().waitFor();
  assert.ok(downloadVersions.length > 0);
  assert.ok(downloadVersions.every(version => version === '4'), 'preview requested unpinned or wrong-version artwork');
  await artworkPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await artworkPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'artwork overflows mobile viewport');
  if (process.env.BROWSER_TEST_SCREENSHOT) await artworkPage.screenshot({ path: process.env.BROWSER_TEST_SCREENSHOT });
  if (process.env.BROWSER_TEST_ARTWORK_JSON) await writeFile(process.env.BROWSER_TEST_ARTWORK_JSON, JSON.stringify(imageNode), 'utf8');
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log('PASS illustration review browser: idempotent request recovery, no duplicate pending review, assigned reject/approve, new version gate, exact-version placement/download, save/reload and mobile containment.');
} catch (error) {
  const page = authorContext?.pages().at(-1);
  console.error('Author UI at failure:', await page?.locator('body').innerText().then(text => text.slice(0, 3000)));
  console.error('Runtime errors:', errors);
  throw error;
} finally {
  await reviewerContext?.close();
  await authorContext?.close();
  await browser.close();
}
