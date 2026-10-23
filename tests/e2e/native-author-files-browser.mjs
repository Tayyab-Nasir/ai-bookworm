/** Production UI, actual SSR cookies/BFF, real native services; no response fixtures. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { nativeWebEnvironment, requireNativeAuthorRunner } from './native-author-files-guard.mjs';

const expect = playwrightExpect.configure({ timeout: 30_000 });

export async function nativeBrowserJson(response, timeout = 30_000) {
  let timer;
  try {
    return await Promise.race([response.json(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Native browser response body deadline exceeded.'), { name: 'TimeoutError' })), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

export function browserErrorSummary(error) {
  if (/^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications\.)$/.test(error?.message ?? '')) return 'ResizeObserver loop';
  return ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'SecurityError', 'AbortError'].includes(error?.name)
    ? error.name : 'Unknown browser error';
}

export function blockNativeServiceWorkers() {
  // Playwright's serviceWorkers:'block' init script reads this getter outside
  // a try/catch. Opaque sandboxed reader frames already deny it themselves.
  let worker;
  try { worker = navigator.serviceWorker; }
  catch (error) { if (error?.name === 'SecurityError') return; throw error; }
  if (worker) worker.register = async () => { throw new Error('Native browser test blocks service-worker registration.'); };
}

export async function runNativeAuthorBrowser({ setup, service, apiOrigin, origins, foreignBookId, prepareRetailer }) {
  requireNativeAuthorRunner();
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const webOrigin = `http://127.0.0.1:${port}`;
  const web = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', 'apps/web', '-H', '127.0.0.1', '-p', String(port)],
    { cwd: root, env: nativeWebEnvironment(setup, webOrigin, apiOrigin), stdio: ['ignore', 'ignore', 'pipe'] });
  web.stderr.resume(); // Never retain raw server logs, cookies or signed URLs.
  let spawnError;
  web.on('error', error => { spawnError = error; });
  const stopped = new Promise(resolve => web.once('close', resolve));
  const artifacts = join(root, '.git/bookworm-native-browser');
  let browser, page, stage = 'production web startup';
  const errors = [];
  origins.add(webOrigin);
  async function context() {
    const value = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await value.addInitScript(blockNativeServiceWorkers);
    await value.route('**/*', route => {
      const target = new URL(route.request().url());
      if (!['http:', 'https:'].includes(target.protocol) || [webOrigin, setup.url].includes(target.origin)) return route.continue();
      errors.push({ kind: 'Unowned browser destination', stage }); return route.abort('blockedbyclient');
    });
    const nextPage = await value.newPage(); nextPage.setDefaultTimeout(30_000);
    nextPage.on('pageerror', error => errors.push({ kind: browserErrorSummary(error), stage }));
    nextPage.on('dialog', dialog => dialog.dismiss());
    return nextPage;
  }
  async function screenshot(name) {
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page overflows its viewport');
    await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true, animations: 'disabled', mask: [page.locator('input[type=password]')] });
  }
  const succeeded = label => console.log(`PASS native browser ${label}`);
  try {
    await mkdir(artifacts, { recursive: true });
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      assert.ok(!spawnError && web.exitCode === null && web.signalCode === null, 'Owned web process exited');
      try {
        const response = await fetch(`${webOrigin}/login`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
        await response.body?.cancel(); if (response.status === 200) { ready = true; break; }
      } catch { /* The newly spawned production server is still starting. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(ready, 'Owned production web server did not start');
    browser = await chromium.launch({ headless: true });
    page = await context();
    stage = 'signup and private cookies';
    const email = `${randomUUID()}@bookworm.local.test`, password = `Bwk-${randomUUID()}!`;
    await page.goto(`${webOrigin}/signup`);
    await page.getByLabel('Name', { exact: true }).fill('Native browser author');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    const [signup] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/signup'),
      page.getByRole('button', { name: 'Create account', exact: true }).click()]);
    stage = 'successful signup response';
    assert.equal(signup.status(), 200);
    stage = 'authenticated dashboard redirect';
    await page.waitForURL(`${webOrigin}/dashboard`);
    // AuthCard performs a full navigation, invalidating the prior fetch body's
    // Playwright handle. Verify the new document's actual session and identity.
    stage = 'persisted public signup identity';
    const session = await page.evaluate(async () => {
      const response = await fetch('/api/auth/session');
      return { status: response.status, body: await response.json() };
    });
    assert.equal(session.status, 200);
    const user = session.body.user;
    assert.ok(user?.id); assert.equal(user.email, email);
    assert.deepEqual(Object.keys(user).sort(), ['displayName', 'email', 'id']);
    stage = 'signup profile persistence';
    const profile = await service.from('profiles').select('id').eq('id', user.id).single();
    assert.equal(profile.data?.id, user.id);
    stage = 'session cookie persistence';
    const cookies = (await page.context().cookies()).filter(c => c.name.startsWith('sb-'));
    assert.ok(cookies.length);
    stage = 'session cookie HttpOnly policy';
    assert.ok(cookies.every(c => c.httpOnly));
    stage = 'session cookie Secure policy';
    assert.ok(cookies.every(c => c.secure));
    stage = 'session cookie SameSite policy';
    assert.ok(cookies.every(c => c.sameSite === 'Lax'));
    stage = 'session cookies inaccessible to page JavaScript';
    assert.ok(!(await page.evaluate(() => document.cookie)).includes('sb-'));
    succeeded('signup, durable profile and HttpOnly Secure cookies');

    stage = 'workspace onboarding and dashboard';
    await page.locator('#workspaceName').fill('Native browser workspace');
    const [workspaceResponse] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/workspaces') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create workspace', exact: true }).click()]);
    assert.equal(workspaceResponse.status(), 201);
    const workspace = await workspaceResponse.json();
    await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveValue(workspace.id);
    await expect(page.getByRole('region', { name: 'Workspace summary', exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    await screenshot('dashboard-desktop');
    succeeded('workspace creation and tenant-scoped dashboard');

    stage = 'manuscript signed upload and real import';
    await page.getByRole('link', { name: 'Create or import', exact: true }).click();
    await page.getByRole('button', { name: 'Import manuscript', exact: true }).click();
    await page.getByLabel('Book title').fill('Native browser manuscript');
    await page.locator('input[type=file]').setInputFiles({ name: 'browser-table-image.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(setup.docx, 'base64') });
    const [queued] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/import-jobs') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create and import', exact: true }).click()]);
    assert.equal(queued.status(), 202);
    const bookId = new URL(queued.url()).pathname.match(/\/books\/([a-f0-9-]{36})\/import-jobs$/)[1];
    const queuedJob = (await queued.json()).job;
    const { runOneDocumentJob } = await import('../../services/api/src/lib/document-worker.ts');
    const imported = await runOneDocumentJob(service);
    assert.equal(imported.status, 'succeeded'); assert.equal(imported.jobId, queuedJob.id);
    await expect(page.getByRole('heading', { name: 'Your manuscript, brought in.', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Continue to editor', exact: true }).click();
    await page.waitForURL(`${webOrigin}/books/${bookId}*`);
    await expect(page.locator('.tiptap')).toContainText('Captain');
    succeeded('signed DOCX upload, scan, durable worker and imported editor');

    stage = 'chapter creation and persistent editing';
    await page.getByLabel('New chapter', { exact: true }).fill('Browser review');
    const [chapterResponse] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/chapters') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Add chapter', exact: true }).click()]);
    assert.equal(chapterResponse.status(), 201);
    const chapter = (await chapterResponse.json()).chapter;
    const passage = 'Captain Mira returned to the harbor after the browser review.';
    await expect(page.locator('.tiptap')).toHaveText('');
    await page.locator('.tiptap').fill(passage);
    await page.getByRole('button', { name: 'Save chapter', exact: true }).click();
    await expect(page.getByText('Saved · v2', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('navigation', { name: 'Chapters', exact: true }).getByRole('button', { name: /^\d+ Browser review$/ }).click();
    await expect(page.locator('.tiptap')).toHaveText(passage);
    await screenshot('editor-desktop');
    succeeded('new chapter, real save and exact text after reload');

    stage = 'persistent Book Bible image and chapter links';
    await page.goto(`${webOrigin}/books/${bookId}/memory`);
    await page.getByRole('button', { name: 'Add memory entry', exact: true }).click();
    const form = page.locator('#bible-entry-details');
    await form.getByLabel('Name', { exact: true }).fill('Browser Captain Mira');
    await form.getByRole('textbox', { name: 'Description', exact: true }).fill('A browser-saved captain with an imported visual reference.');
    await expect(form.getByRole('checkbox')).toHaveCount(1);
    await form.getByRole('checkbox').check();
    await form.getByRole('button', { name: '+ Add chapter source', exact: true }).click();
    await form.getByRole('combobox', { name: 'Source chapter', exact: true }).selectOption(chapter.id);
    stage = 'Book Bible create response';
    const [canonResponse] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/bible') && r.request().method() === 'POST'),
      form.getByRole('button', { name: 'Save memory entry', exact: true }).click()]);
    assert.equal(canonResponse.status(), 201);
    const canon = (await canonResponse.json()).item;
    assert.equal(canon.type, 'character');
    assert.equal(canon.attributes_json.imageAssetIds.length, 1);
    assert.equal(canon.source_refs_json[0].chapterId, chapter.id);
    stage = 'Book Bible confirmed save interface';
    await expect(page.getByText('“Browser Captain Mira” saved to this book’s memory.', { exact: true })).toBeVisible();
    await expect(form.getByText('Unsaved changes', { exact: true })).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Save memory entry', exact: true })).toBeEnabled();
    stage = 'Book Bible reload after confirmed save';
    await page.reload();
    stage = 'saved Book Bible entry selection';
    await page.getByRole('button', { name: /Browser Captain Mira/ }).click();
    stage = 'saved Book Bible image and source values';
    await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Browser Captain Mira');
    await expect(form.getByRole('checkbox')).toBeChecked();
    await expect(form.getByRole('combobox', { name: 'Source chapter', exact: true })).toHaveValue(chapter.id);
    succeeded('Book Bible save/reload with scanned image and version-pinned chapter');

    stage = 'publishing metadata and responsive memory';
    const metadata = page.getByRole('region', { name: 'Publishing metadata', exact: true });
    await metadata.getByRole('textbox', { name: 'Book description', exact: true }).fill('An author-reviewed harbor adventure.');
    await metadata.getByRole('textbox', { name: 'Keywords · one per line', exact: true }).fill('harbor\nadventure');
    const [savedMetadata] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/metadata') && r.request().method() === 'PUT'),
      metadata.getByRole('button', { name: 'Save metadata', exact: true }).click()]);
    assert.equal(savedMetadata.status(), 200);
    await expect(page.getByText('Publishing metadata saved.', { exact: true })).toBeVisible();
    await page.reload();
    await expect(metadata.getByRole('textbox', { name: 'Book description', exact: true })).toHaveValue('An author-reviewed harbor adventure.');
    await expect(metadata.getByRole('textbox', { name: 'Keywords · one per line', exact: true })).toHaveValue('harbor\nadventure');
    await screenshot('memory-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot('memory-mobile');
    succeeded('publishing metadata persistence and desktop/mobile containment');

    stage = 'book desk current saved state and scoped navigation';
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${webOrigin}/books/${bookId}/overview`);
    await expect(page.getByRole('heading', { name: 'Native browser manuscript', exact: true })).toBeVisible();
    const readDesk = () => page.evaluate(async path => {
      const response = await fetch(path, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
      return { status: response.status, cacheControl: response.headers.get('cache-control'), body: await response.json() };
    }, `/api/backend/v1/books/${bookId}/overview`);
    const deskResponse = await readDesk();
    assert.equal(deskResponse.status, 200);
    assert.equal(deskResponse.cacheControl, 'private, no-store');
    const desk = deskResponse.body;
    assert.equal(desk.viewerId, user.id); assert.equal(desk.book.id, bookId);
    assert.equal(desk.workspace.id, workspace.id); assert.equal(desk.workspace.role, 'owner');
    assert.ok(desk.manuscript.wordCount >= 12); assert.ok(desk.manuscript.chapterCount >= 2);
    assert.equal(desk.manuscript.wordCount, desk.chapters.reduce((n, c) => n + c.wordCount, 0));
    const savedChapter = desk.chapters.find(c => c.id === chapter.id);
    assert.equal(savedChapter.versionNumber, 2); assert.equal(desk.bibleItems, 1);
    assert.equal(desk.listing.description, true); assert.equal(desk.listing.keywords, 2);
    assert.ok(!JSON.stringify(desk).includes('An author-reviewed harbor adventure.'));
    await expect(page.getByRole('navigation', { name: 'Book tools' }).getByRole('link', { name: 'Workspace artwork', exact: true }))
      .toHaveAttribute('href', `/assets?ws=${workspace.id}`);
    await screenshot('book-desk-desktop');
    await page.setViewportSize({ width: 320, height: 844 });
    await screenshot('book-desk-mobile');
    succeeded('book desk uses real RLS/current versions without manuscript or private prompt payloads');

    const { runNativePublishingBrowser } = await import('./native-author-files-publishing.mjs');
    await runNativePublishingBrowser({ page, bookId, passage, screenshot, origins, onStage: value => { stage = value; } });

    stage = 'book desk reload after saved publishing outputs';
    await page.goto(`${webOrigin}/books/${bookId}/overview`);
    await expect(page.getByRole('heading', { name: 'Native browser manuscript', exact: true })).toBeVisible();
    const afterResponse = await readDesk();
    assert.equal(afterResponse.status, 200);
    const afterPublishing = afterResponse.body;
    assert.ok(afterPublishing.editionsTotal > 0); assert.ok(afterPublishing.history.renders > 0);
    assert.ok(afterPublishing.history.packages > 0);
    await expect(page.getByText(/Stored job history does not verify current files/)).toBeVisible();
    succeeded('book desk refreshes real saved edition/render/package history without publication claims');

    stage = 'logout and private session removal';
    await page.goto(`${webOrigin}/dashboard`);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL(`${webOrigin}/login`);
    assert.equal(await page.evaluate(async () => (await fetch('/api/auth/session')).status), 401);
    succeeded('logout removes the private session');
    stage = 'returning author protected-route login in a fresh browser context';
    await page.context().close(); page = await context();
    await page.goto(`${webOrigin}/books/${bookId}/memory`);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(`${webOrigin}/books/${bookId}/memory`);
    await expect(page.getByRole('button', { name: /Browser Captain Mira/ })).toBeVisible();
    succeeded('returning author protected-route login and persistent memory');
    stage = 'returning author foreign-book refusal';
    assert.equal(await page.evaluate(async id => (await fetch(`/api/backend/v1/books/${id}`)).status, foreignBookId), 404);
    succeeded('returning author foreign-book refusal');
    stage = 'native retailer fixture and private service acceptance';
    const retailer = await prepareRetailer();
    stage = 'retailer owner login through actual Auth';
    await page.goto(`${webOrigin}/dashboard`);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL(`${webOrigin}/login`);
    await page.getByLabel('Email', { exact: true }).fill(retailer.email);
    await page.getByLabel('Password', { exact: true }).fill(retailer.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(`${webOrigin}/dashboard`);
    const { runNativeRetailerBrowser } = await import('./native-author-files-publishing.mjs');
    await runNativeRetailerBrowser({ page, retailer, service, screenshot, onStage: value => {
      stage = value; console.log(`STAGE native browser ${stage}`);
    } });
    stage = 'retailer owner logout';
    await page.goto(`${webOrigin}/dashboard`);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL(`${webOrigin}/login`);
    assert.equal(await page.evaluate(async () => (await fetch('/api/auth/session')).status), 401);
    stage = 'browser errors and outbound destination audit';
    assert.deepEqual(errors, []);
    succeeded('logout, protected-route login, persistent memory and foreign-book refusal');
  } catch (error) {
    console.error(`Native browser assertion failed at ${stage}.`);
    if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true, timeout: 5000,
      mask: [page.locator('input')] }).catch(() => {});
    const category = ['TimeoutError', 'AssertionError'].includes(error?.name) ? error.name : 'Error';
    // Only fixed categories and source-defined stage labels: no raw messages,
    // page contents, URLs, stack traces, cookies or credentials reach CI logs.
    if (errors.length) console.error(`Native browser error diagnostics: ${JSON.stringify({ total: errors.length, first: errors.slice(0, 10) })}`);
    throw new Error(`Native browser assertion failed at ${stage} (${category}). Review the synthetic screenshot artifact.`);
  } finally {
    try { if (browser) await browser.close(); }
    finally {
      if (web.exitCode === null && web.signalCode === null) web.kill('SIGTERM');
      const deadline = setTimeout(() => web.kill('SIGKILL'), 5000);
      await stopped; clearTimeout(deadline); origins.delete(webOrigin);
      console.log('PASS owned native browser and web process cleanup completed');
    }
  }
}
