import assert from 'node:assert/strict';
import { chromium, expect as baseExpect } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 30000 });

const origin = 'http://localhost:4398';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(60000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const publicId = 'b1000000-0000-4000-8000-000000000001';
  const communities = [
    { id: publicId, name: 'Fiction workshop', description: 'Share your next chapter.', visibility: 'public' },
    { id: 'b1000000-0000-4000-8000-000000000002', name: 'Private circle', description: '<script>private text</script>', visibility: 'private' },
  ];
  let mode = 'normal'; let joins = 0; let releaseJoin;
  let postReads = [];
  await page.route('**/api/backend/v1/communities**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/join')) {
      joins++;
      if (mode === 'join-error') return route.fulfill({ status: 503, json: { error: { message: 'Join unavailable' } } });
      await new Promise(resolve => { releaseJoin = resolve; });
      return route.fulfill({ json: { communityId: publicId, role: 'member' } });
    }
    if (path.endsWith('/posts')) {
      postReads.push(path);
      return route.fulfill({ json: { posts: [], role: 'member' } });
    }
    if (mode === 'error') return route.fulfill({ status: 503, json: { error: { message: 'Directory unavailable' } } });
    return route.fulfill({ json: { communities: mode === 'empty' ? [] : communities } });
  });
  await page.goto(`${origin}/community?ws=demo-workspace`);
  await page.getByLabel('Email').fill('author@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: 'Fiction workshop' })).toBeVisible();
  assert.equal(postReads.length, 0, 'Directory must not request posts using a workspace ID');
  const privateCard = page.getByRole('article').filter({ hasText: 'Private circle' });
  await expect(privateCard.getByRole('button', { name: 'Join community' })).toHaveCount(0);
  await expect(privateCard.getByText('<script>private text</script>', { exact: true })).toBeVisible();
  await page.getByLabel('Find a community').fill('nonexistent');
  await expect(page.getByRole('heading', { name: 'No matching communities' })).toBeVisible();
  await page.getByLabel('Find a community').fill('');
  mode = 'join-error';
  await page.getByRole('button', { name: 'Join community', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Join unavailable' })).toHaveText('Join unavailable');
  mode = 'normal';
  await page.getByRole('button', { name: 'Join community', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Joining…', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Refresh communities' })).toBeDisabled();
  await expect.poll(() => typeof releaseJoin).toBe('function'); releaseJoin();
  await expect(page.getByRole('button', { name: 'Joined', exact: true })).toBeDisabled();
  assert.equal(joins, 2);
  await page.getByRole('article').filter({ hasText: 'Fiction workshop' }).getByRole('link', { name: 'Open discussion' }).click();
  await expect(page).toHaveURL(`${origin}/community/${publicId}`);
  await expect.poll(() => postReads.length).toBeGreaterThan(0);
  assert.ok(postReads.every(path => path.includes(publicId)));
  await page.goto(`${origin}/community`);
  mode = 'error'; await page.getByRole('button', { name: 'Refresh communities' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Directory unavailable' })).toHaveText('Directory unavailable');
  await expect(page.getByRole('heading', { name: 'No communities available yet' })).toHaveCount(0);
  mode = 'empty'; await page.getByRole('button', { name: 'Refresh communities' }).click();
  await expect(page.getByRole('heading', { name: 'No communities available yet' })).toBeVisible();
  mode = 'normal'; await page.getByRole('button', { name: 'Refresh communities' }).click();
  await expect(page.getByRole('heading', { name: 'Fiction workshop' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS community directory, safe join, navigation, recovery and mobile fixture acceptance');
} finally { await browser.close(); }
