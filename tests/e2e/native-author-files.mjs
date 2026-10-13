/** Real API/SDK calls against the runner-owned native services; no injected fakes. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { localFetch, localOrigin, requireNativeAuthorRunner } from './native-author-files-guard.mjs';

requireNativeAuthorRunner();
assert.equal(process.env.NODE_ENV, 'production', 'Never load the developer .env.local');
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  assert.ok(input.length < 2 * 1024 * 1024, 'Native fixture input exceeds its limit');
}
const setup = JSON.parse(input);
const origins = new Set([setup.url, setup.scannerUrl, setup.documentUrl].map(localOrigin));
assert.equal(setup.url, 'http://127.0.0.1:55321');
assert.equal(process.env.SUPABASE_URL, setup.url);
assert.ok(process.env.SUPABASE_ANON_KEY === setup.anonKey, 'Disposable anonymous key mismatch');
assert.ok(process.env.SUPABASE_SERVICE_ROLE_KEY === setup.serviceKey, 'Disposable service key mismatch');
globalThis.fetch = localFetch(origins);
const { createClient } = await import('@supabase/supabase-js');
const { buildApp } = await import('../../services/api/src/app.ts');
const { runOneDocumentJob } = await import('../../services/api/src/lib/document-worker.ts');
const { bookNodesPlainText, bookNodesWordCount } = await import('../../packages/book-model/src/plain-text.ts');
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } };
const service = createClient(setup.url, setup.serviceKey, options);
const app = await buildApp();
const address = await app.listen({ host: '127.0.0.1', port: 0 });
origins.add(localOrigin(address));
const clients = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function data(result, label) {
  assert.ok(!result.error, `${label}: ${result.error?.code ?? ''} ${result.error?.message ?? ''}`);
  assert.ok(result.data != null, `${label}: no data returned`);
  return result.data;
}
async function request(token, method, path, body, expected = 200) {
  const response = await fetch(address + '/v1' + path, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${result.error?.message ?? 'unexpected response'}`);
  return result;
}
async function author(label) {
  const client = createClient(setup.url, setup.anonKey, options);
  clients.push(client);
  const identity = data(await client.auth.signUp({ email: `${randomUUID()}@bookworm.local.test`,
    password: `Bwk-${randomUUID()}!`, options: { data: { full_name: label, role: 'admin' } } }), 'native signup');
  assert.ok(identity.session?.access_token, 'Local email signup did not return a session');
  const profile = data(await client.from('profiles').select('id').eq('id', identity.user.id).single(), 'Auth profile trigger');
  assert.equal(profile.id, identity.user.id);
  const token = identity.session.access_token;
  const workspace = await request(token, 'POST', '/workspaces', { name: label, slug: `native-${randomUUID()}` }, 201);
  assert.ok(workspace.id && workspace.organization_id);
  return { client, token, workspace, userId: identity.user.id };
}
async function upload(author, name, mimeType, bytes) {
  const declaration = { workspaceId: author.workspace.id, requestId: randomUUID(), filename: name,
    mimeType, sizeBytes: bytes.length, type: 'manuscript' };
  const ticket = await request(author.token, 'POST', '/assets/upload-url', declaration);
  const replay = await request(author.token, 'POST', '/assets/upload-url', declaration);
  assert.equal(replay.assetId, ticket.assetId);
  assert.equal(replay.path, ticket.path);
  const stored = await fetch(ticket.uploadUrl, { method: 'PUT', body: bytes });
  assert.ok(stored.ok, 'Native signed upload failed');
  await stored.body?.cancel();
  return { ...ticket, bytes, checksum: hash(bytes) };
}
async function confirm(author, asset, expected = 200, checksum = asset.checksum) {
  return request(author.token, 'POST', `/assets/${asset.assetId}/confirm`, { checksumSha256: checksum, sizeBytes: asset.bytes.length }, expected);
}
async function download(author, asset) {
  const result = await request(author.token, 'GET', `/assets/${asset.assetId}/download-url`);
  const response = await fetch(result.url);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), asset.bytes, 'Original stored bytes changed');
}
async function quarantined(author, asset) {
  await request(author.token, 'GET', `/assets/${asset.assetId}/download-url`, undefined, 409);
  assert.ok((await author.client.storage.from('book-assets').download(asset.path)).error,
    'Storage exposed a quarantined object to its owner');
  assert.ok((await author.client.storage.from('book-assets').createSignedUrl(asset.path, 60)).error,
    'Storage signed a quarantined object for its owner');
}

try {
  await request(null, 'GET', '/workspaces', undefined, 401);
  await request('not-a-valid-token', 'GET', '/workspaces', undefined, 401);
  const alice = await author('Native author Alice');
  const bob = await author('Native author Bob');
  const workspaces = await request(alice.token, 'GET', '/workspaces');
  assert.deepEqual(workspaces.workspaces.map(value => value.id), [alice.workspace.id]);
  assert.deepEqual(data(await bob.client.from('workspaces').select('id').eq('id', alice.workspace.id), 'foreign workspace read'), []);
  console.log('PASS native Auth signup, automatic profiles, API authentication and tenant isolation');

  const bookRequest = { workspaceId: alice.workspace.id, requestId: randomUUID(), title: 'Native author manuscript', authorName: 'Synthetic author' };
  const book = await request(alice.token, 'POST', '/books', bookRequest, 201);
  assert.equal((await request(alice.token, 'POST', '/books', bookRequest)).id, book.id);
  await request(alice.token, 'POST', '/books', { ...bookRequest, title: 'Changed replay' }, 409);
  await request(bob.token, 'GET', `/books/${book.id}`, undefined, 404);
  console.log('PASS real book creation, durable replay and foreign-book refusal');

  const text = await upload(alice, 'original.txt', 'text/plain', Buffer.from('Original manuscript. Captain Mira reaches the harbor.'));
  await quarantined(alice, text);
  await request(bob.token, 'POST', `/assets/${text.assetId}/confirm`, { checksumSha256: text.checksum, sizeBytes: text.bytes.length }, 404);
  await confirm(alice, text, 422, '0'.repeat(64));
  await quarantined(alice, text);
  assert.equal((await confirm(alice, text)).scanStatus, 'clean');
  await download(alice, text);
  await request(bob.token, 'GET', `/assets/${text.assetId}/download-url`, undefined, 404);
  assert.ok((await bob.client.storage.from('book-assets').download(text.path)).error, 'Foreign tenant read private bytes');
  console.log('PASS native signed upload, quarantine, checksum failure/retry, real clean scan and byte-exact download');

  // Exact harmless bytes in the test-only ClamAV signature database, not malware.
  const rejected = await upload(alice, 'harmless-rejection.txt', 'text/plain', Buffer.from('Bookworm harmless infected-verdict acceptance fixture.'));
  await confirm(alice, rejected, 422);
  await quarantined(alice, rejected);
  const rejectedVersion = data(await service.from('asset_versions').select('scan_status').eq('asset_id', rejected.assetId).single(), 'rejected scan row');
  assert.equal(rejectedVersion.scan_status, 'infected');
  console.log('PASS real infected verdict keeps harmless test object quarantined');

  const docx = await upload(alice, 'table-and-image.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from(setup.docx, 'base64'));
  await confirm(alice, docx);
  const queued = await request(alice.token, 'POST', `/books/${book.id}/import-jobs`, { assetId: docx.assetId }, 202);
  const replay = await request(alice.token, 'POST', `/books/${book.id}/import-jobs`, { assetId: docx.assetId }, 202);
  assert.equal(replay.job.id, queued.job.id);
  await request(bob.token, 'POST', `/books/${book.id}/import-jobs`, { assetId: docx.assetId }, 404);
  const outcome = await runOneDocumentJob(service);
  assert.equal(outcome.status, 'succeeded', `Real document worker returned ${outcome.status}`);
  assert.equal(outcome.jobId, queued.job.id);
  assert.equal((await runOneDocumentJob(service)).status, 'idle');
  const recovered = await request(alice.token, 'GET', `/books/${book.id}/imports/${docx.assetId}`);
  const receipt = recovered.import;
  assert.ok(receipt.chapters.length > 0);
  assert.equal(receipt.assetIds.length, 1, 'Embedded image did not become a scanned private asset');
  const chapter = receipt.chapters[0];
  const saved = await request(alice.token, 'GET', `/chapters/${chapter.id}/document`);
  assert.equal(saved.document.version, 1);
  assert.ok(saved.document.nodes.some(node => node.type === 'table'));
  assert.ok(saved.document.nodes.some(node => node.assetId === receipt.assetIds[0]));
  const versions = await request(alice.token, 'GET', `/chapters/${chapter.id}/versions`);
  assert.equal(versions.versions.length, 1);
  assert.equal(versions.versions[0].plain_text, bookNodesPlainText(saved.document.nodes));
  assert.equal(versions.versions[0].word_count, bookNodesWordCount(saved.document.nodes));
  assert.match(versions.versions[0].plain_text, /Captain\tMira/);
  const embedded = data(await service.from('assets').select('storage_path,checksum').eq('id', receipt.assetIds[0]).single(), 'embedded asset');
  const embeddedVersion = data(await service.from('asset_versions').select('scan_status').eq('asset_id', receipt.assetIds[0]).single(), 'embedded scan');
  assert.equal(embeddedVersion.scan_status, 'clean');
  const image = data(await alice.client.storage.from('book-assets').download(embedded.storage_path), 'embedded image download');
  assert.equal(hash(Buffer.from(await image.arrayBuffer())), embedded.checksum);
  assert.ok((await bob.client.storage.from('book-assets').download(embedded.storage_path)).error);
  await download(alice, docx);
  const recoveredAgain = await request(alice.token, 'POST', `/books/${book.id}/import`, { assetId: docx.assetId });
  assert.deepEqual(recoveredAgain, receipt, 'Import replay did not reuse the durable receipt');
  const jobs = await request(alice.token, 'GET', `/books/${book.id}/import-jobs`);
  assert.equal(jobs.jobs.length, 1);
  assert.equal(jobs.jobs[0].status, 'succeeded');
  console.log('PASS native queued DOCX import, real parser/scanner, canonical table text, embedded image, durable receipt and original preservation');

  const rows = [{ id: randomUUID(), type: 'table', rows: [['Direct', 'table'], ['one', 'two']] }];
  const created = await request(alice.token, 'POST', `/books/${book.id}/chapters`, { title: 'Manual table', nodes: rows, idempotencyKey: randomUUID() }, 201);
  const initial = await request(alice.token, 'GET', `/chapters/${created.chapter.id}/versions`);
  assert.equal(initial.versions[0].plain_text, bookNodesPlainText(rows));
  assert.equal(initial.versions[0].word_count, 4);
  const edit = { expectedVersion: 1, operationId: randomUUID(), nodes: [...saved.document.nodes,
    { id: randomUUID(), type: 'paragraph', text: 'Author reviewed and revised this manuscript.' }] };
  await request(alice.token, 'PUT', `/chapters/${chapter.id}/document`, edit);
  await request(alice.token, 'PUT', `/chapters/${chapter.id}/document`, { ...edit, operationId: randomUUID() }, 409);
  await request(bob.token, 'PUT', `/chapters/${chapter.id}/document`, { ...edit, expectedVersion: 2 }, 404);
  const reloaded = await request(alice.token, 'GET', `/chapters/${chapter.id}/document`);
  assert.equal(reloaded.document.version, 2);
  assert.deepEqual(reloaded.document.nodes, edit.nodes);
  assert.equal(data(await service.from('ai_jobs').select('id'), 'AI jobs').length, 0);
  assert.equal(data(await service.from('usage_events').select('id'), 'provider usage').length, 0);
  console.log('PASS native initial table creation, edit/reload, stale-write refusal and zero AI jobs/usage');
} finally {
  for (const client of clients) await client.auth.signOut().catch(() => {});
  await app.close();
}
