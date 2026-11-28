import assert from 'node:assert/strict';
import { chromium, expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 30000 });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const id = 'b2000000-0000-4000-8000-000000000001';
  const post = { id: 'post-one', community_id: id, author_id: 'author-one', body: 'An opening chapter', title: 'Workshop', status: 'published', created_at: '2026-09-12T00:00:00Z' };
  const posts = [post]; const comments = [];
  let role = 'member'; let fail = ''; let writes = 0; let release;
  let holdPost = false; let reports = [{ id: 'report-one', entity_type: 'post', entity_id: post.id, reason: 'Please review', status: 'open' }];
  await page.route('**/api/backend/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const method = request.method();
    const deny = () => route.fulfill({ status: 503, json: { error: { message: 'Fixture request unavailable' } } });
    if (path.endsWith(`/communities/${id}/posts`)) {
      if (method === 'GET') return fail === 'load' ? deny() : route.fulfill({ json: { posts, role } });
      writes++;
      if (fail === 'post') return deny();
      if (holdPost) await new Promise(resolve => { release = resolve; });
      const created = { ...post, id: 'new-post', title: null, body: request.postDataJSON().body };
      posts.unshift(created); return route.fulfill({ status: 201, json: created });
    }
    if (path.endsWith('/comments')) {
      if (fail === 'comment') return deny();
      if (method === 'POST') {
        const comment = { id: 'comment-one', post_id: post.id, author_id: 'author-one', body: request.postDataJSON().body };
        comments.push(comment); return route.fulfill({ status: 201, json: comment });
      }
      return route.fulfill({ json: { comments } });
    }
    if (path.endsWith('/reactions')) return fail === 'reaction' ? deny() : route.fulfill({ json: { active: true } });
    if (path.endsWith('/reports')) return fail === 'report' ? deny() : route.fulfill({ status: 201, json: { id: 'new-report' } });
    if (path.includes('/moderation')) {
      if (fail === 'moderation') return deny();
      if (method === 'GET') return route.fulfill({ json: { reports } });
      reports = []; return route.fulfill({ json: { status: 'dismissed' } });
    }
    return route.continue();
  });
  await page.goto(`http://localhost:4398/community/${id}`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByLabel('Post text')).toBeVisible();
  await page.getByLabel('Post text').fill('My draft must survive');
  fail = 'post'; await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Fixture request unavailable' })).toBeVisible();
  await expect(page.getByLabel('Post text')).toHaveValue('My draft must survive');
  fail = ''; holdPost = true;
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByLabel('Post text')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Refresh discussion' })).toBeDisabled();
  await expect.poll(() => typeof release).toBe('function'); release();
  await expect(page.getByRole('status').filter({ hasText: 'Post published.' })).toBeVisible();
  assert.equal(writes, 2);
  await expect(page.getByLabel('Post text')).toHaveValue('');
  const card = page.getByRole('article').filter({ hasText: 'An opening chapter' });
  await card.getByLabel('Comment text').fill('A thoughtful reply');
  fail = 'comment'; await card.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(card.getByLabel('Comment text')).toHaveValue('A thoughtful reply');
  await expect(page.getByRole('alert').filter({ hasText: 'Fixture request unavailable' })).toBeVisible();
  fail = ''; await card.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(card.getByText('A thoughtful reply', { exact: true })).toBeVisible();
  fail = 'reaction'; await card.getByRole('button', { name: 'like', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Fixture request unavailable' })).toBeVisible();
  fail = ''; await card.getByRole('button', { name: 'like', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'like reaction added.' })).toBeVisible();
  await card.getByRole('button', { name: 'Report', exact: true }).click();
  await card.getByLabel('Report reason').fill('Needs moderation');
  fail = 'report'; await card.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Fixture request unavailable' })).toBeVisible();
  await expect(card.getByLabel('Report reason')).toHaveValue('Needs moderation');
  fail = ''; await card.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Report sent for moderation.' })).toBeVisible();
  role = null; await page.reload();
  await expect(page.getByText(/You can read this discussion/)).toBeVisible();
  await expect(page.getByLabel('Post text')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'like', exact: true })).toBeDisabled();
  fail = 'load'; await page.getByRole('button', { name: 'Refresh discussion' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Fixture request unavailable' })).toBeVisible();
  await expect(page.getByText('No posts yet', { exact: true })).toHaveCount(0);
  fail = ''; role = 'moderator'; await page.getByRole('button', { name: 'Refresh discussion' }).click();
  await page.getByRole('button', { name: 'Moderation Queue', exact: true }).click();
  await expect(page.getByText(/Please review/)).toBeVisible();
  fail = 'moderation'; await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Fixture request unavailable' })).toBeVisible();
  await expect(page.getByText(/Please review/)).toBeVisible();
  fail = ''; await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.getByText('No open reports.', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS discussion post/reply preservation, pending guards, reactions, reports, moderation, read-only, load recovery, mobile');
} finally { await browser.close(); }
