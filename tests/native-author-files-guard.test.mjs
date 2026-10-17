import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { loopbackRelay } from './e2e/native-author-files-relay.mjs';
import { blockNativeServiceWorkers, browserErrorSummary } from './e2e/native-author-files-browser.mjs';
import { inspectNativePackage } from './e2e/native-author-files-packages.mjs';
import { childEnvironment, localFetch, localOrigin, localStatus, migrationFiles, nativeAuthorEnvironment, nativeProjectId, nativeWebEnvironment, ownedInternalAddress, requireNativeAuthorRunner } from './e2e/native-author-files-guard.mjs';

test('native ZIP inspection reads exact member checksums and rejects invalid archives', () => {
  const fixture = spawnSync(process.execPath, ['scripts/run-python.mjs', '-I', '-c', `
import io, sys, zipfile
out = io.BytesIO()
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
 for name, value in {'book.epub': b'synthetic bytes', 'README.txt': b'manual submission',
                     'metadata.json': b'{}', 'preflight.json': b'{}', 'manifest.json': b'{}'}.items():
  archive.writestr(name, value)
sys.stdout.buffer.write(out.getvalue())
`], { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 30_000 });
  assert.equal(fixture.status, 0);
  const inspected = inspectNativePackage(fixture.stdout);
  assert.equal(inspected.files['book.epub'].size, Buffer.byteLength('synthetic bytes'));
  assert.equal(inspected.files['book.epub'].sha256, createHash('sha256').update('synthetic bytes').digest('hex'));
  assert.equal(inspected.readme, 'manual submission');
  assert.deepEqual(inspected.metadata, {});
  assert.throws(() => inspectNativePackage(Buffer.from('not a ZIP')), /could not be inspected/);
});

test('native service-worker blocker preserves sandbox denial without injecting page errors', async () => {
  const install = navigator => runInNewContext(`(${blockNativeServiceWorkers.toString()})()`, { navigator });
  let calls = 0;
  const worker = { register: async () => { calls++; } };
  install({ serviceWorker: worker });
  await assert.rejects(worker.register('/must-not-load.js'), /Native browser test blocks service-worker registration/);
  assert.equal(calls, 0);
  assert.doesNotThrow(() => install({}));
  assert.doesNotThrow(() => install({ get serviceWorker() { throw new DOMException('Sandboxed origin', 'SecurityError'); } }));
  assert.throws(() => install({ get serviceWorker() { throw new Error('Unexpected getter failure'); } }), /Unexpected getter failure/);
});

test('native browser diagnostics keep error categories without secrets or page content', () => {
  for (const message of ['ResizeObserver loop limit exceeded', 'ResizeObserver loop completed with undelivered notifications.']) {
    assert.equal(browserErrorSummary(new Error(message)), 'ResizeObserver loop');
  }
  assert.equal(browserErrorSummary(new TypeError('https://private.example/?token=never-log')), 'TypeError');
  assert.equal(browserErrorSummary(new Error('private manuscript text')), 'Error');
  assert.equal(browserErrorSummary({ name: 'private-token', message: 'ResizeObserver loop private-secret' }), 'Unknown browser error');
  assert.equal(browserErrorSummary(null), 'Unknown browser error');
});

test('native web settings exclude service credentials and reject self-proxy or external origins', () => {
  const setup = { url: 'http://127.0.0.1:55321', anonKey: 'synthetic-public', serviceKey: 'never-web' };
  const env = nativeWebEnvironment(setup, 'http://127.0.0.1:55330', 'http://127.0.0.1:55331',
    { PATH: 'native-path', SUPABASE_SERVICE_ROLE_KEY: 'operator-secret', OPENAI_API_KEY: 'operator-secret' });
  assert.equal(env.NODE_ENV, 'production'); assert.equal(env.NEXT_TELEMETRY_DISABLED, '1');
  assert.equal(env.SUPABASE_ANON_KEY, setup.anonKey);
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined); assert.equal(env.OPENAI_API_KEY, undefined);
  for (const origin of ['http://127.0.0.1:55330', setup.url, setup.url + '/', 'https://external.example', 'http://localhost:55331']) {
    assert.throws(() => nativeWebEnvironment(setup, 'http://127.0.0.1:55330', origin));
  }
  assert.throws(() => nativeWebEnvironment(setup, setup.url, 'http://127.0.0.1:55331'));
  assert.throws(() => nativeWebEnvironment(setup, setup.url + '/', 'http://127.0.0.1:55331'));
});

test('native child settings boot the real production API without operator credentials or network calls', () => {
  const env = nativeAuthorEnvironment({ url: 'http://127.0.0.1:55321', anonKey: 'synthetic-anonymous',
    serviceKey: 'synthetic-service', scannerUrl: 'http://127.0.0.1:55323',
    documentUrl: 'http://127.0.0.1:55324', renderingUrl: 'http://127.0.0.1:55325',
    publishingUrl: 'http://127.0.0.1:55326', serviceToken: 'synthetic-private-service' },
  { PATH: process.env.PATH ?? '', OPENAI_API_KEY: 'operator-key-must-not-leak', NODE_OPTIONS: '--import dotenv/config' });
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.OPENAI_API_KEY, ''); assert.equal(env.STRIPE_SECRET_KEY, '');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.RENDERING_SERVICE_URL, 'http://127.0.0.1:55325');
  assert.equal(env.RENDERING_SERVICE_TOKEN, 'synthetic-private-service');
  assert.equal(env.PUBLISHING_SERVICE_URL, 'http://127.0.0.1:55326');
  assert.equal(env.PUBLISHING_SERVICE_TOKEN, 'synthetic-private-service');
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('Production boot must not contact a service'); };
    const { buildApp } = await import('./services/api/src/app.ts');
    const app = await buildApp();
    try {
      await app.ready();
      assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
      assert.equal(calls, 0);
    }
    finally { await app.close(); }
  `], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('native renderer must be a distinct owned loopback service', () => {
  const setup = { url: 'http://127.0.0.1:55321', scannerUrl: 'http://127.0.0.1:55323', documentUrl: 'http://127.0.0.1:55324', publishingUrl: 'http://127.0.0.1:55326' };
  for (const renderingUrl of [undefined, 'https://renderer.example', 'http://127.0.0.1:55321/', setup.scannerUrl, setup.documentUrl]) {
    assert.throws(() => nativeAuthorEnvironment({ ...setup, renderingUrl }, {}));
  }
});

test('native publisher must be a distinct owned loopback service', () => {
  const setup = { url: 'http://127.0.0.1:55321', scannerUrl: 'http://127.0.0.1:55323',
    documentUrl: 'http://127.0.0.1:55324', renderingUrl: 'http://127.0.0.1:55325' };
  for (const publishingUrl of [undefined, 'https://publisher.example', ...Object.values(setup)]) {
    assert.throws(() => nativeAuthorEnvironment({ ...setup, publishingUrl }, {}));
  }
});

test('generated project identity fits the CLI without truncating cleanup labels', () => {
  const id = randomUUID(), project = nativeProjectId(id);
  assert.equal(project, `bwk-${id.replaceAll('-', '')}`);
  assert.ok(project.length <= 40);
  for (const value of ['', 'operator-project', '../project', id + '-extra', undefined]) assert.throws(() => nativeProjectId(value));
});

test('relay targets require one running, unexposed, owned private-network container', () => {
  const network = 'a'.repeat(64);
  const container = { State: { Running: true }, NetworkSettings: { Networks: { owned: { NetworkID: network, IPAddress: '172.20.0.2' } }, Ports: { '8004/tcp': null } } };
  assert.equal(ownedInternalAddress(container, network), '172.20.0.2');
  for (const host of ['127.0.0.1', '8.8.8.8', 'localhost', '172.32.0.2', '172.20.0.999', '::1']) {
    const changed = structuredClone(container); changed.NetworkSettings.Networks.owned.IPAddress = host;
    assert.throws(() => ownedInternalAddress(changed, network));
  }
  assert.throws(() => ownedInternalAddress(container, 'b'.repeat(64)));
  const published = structuredClone(container); published.NetworkSettings.Ports['8004/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '8004' }];
  assert.throws(() => ownedInternalAddress(published, network));
  const stopped = structuredClone(container); stopped.State.Running = false;
  assert.throws(() => ownedInternalAddress(stopped, network));
  const connected = structuredClone(container); connected.NetworkSettings.Networks.second = { NetworkID: network, IPAddress: '10.0.0.2' };
  assert.throws(() => ownedInternalAddress(connected, network));
});

test('loopback relay preserves real HTTP bytes and closes its listening socket', async () => {
  const target = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers['x-fixture'], 'native-bytes');
    res.writeHead(201, { 'content-type': 'application/octet-stream', 'x-fixture': 'native-response' });
    res.end(Buffer.concat(chunks));
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  let relay;
  try {
    relay = await loopbackRelay('127.0.0.1', target.address().port);
    assert.equal(new URL(relay.origin).hostname, '127.0.0.1');
    const bytes = Buffer.from([0, 1, 2, 10, 127, 128, 255]);
    const response = await fetch(relay.origin + '/real-http', { method: 'POST', headers: { 'x-fixture': 'native-bytes' }, body: bytes });
    assert.equal(response.status, 201); assert.equal(response.headers.get('x-fixture'), 'native-response');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    await relay.close(); const origin = relay.origin; relay = null;
    await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(2000) }));
    await assert.rejects(loopbackRelay('8.8.8.8', 80));
  } finally {
    if (relay) await relay.close(); target.closeAllConnections();
    await new Promise(resolve => target.close(resolve));
  }
});

test('native manifest preserves every original numbered and timestamped migration', () => {
  const names = readdirSync(new URL('../supabase/migrations/', import.meta.url));
  const files = migrationFiles(names);
  assert.ok(files.length >= 109);
  assert.equal(files.length, names.filter(name => name.endsWith('.sql')).length);
  assert.equal(files[0], '0001_extensions.sql');
  assert.ok(files.includes('0013_admin_ops.sql'));
  assert.equal(files[45], '20260912175000_pgcrypto_digest_compatibility.sql');
  assert.deepEqual(migrationFiles([...names].reverse()), files);
  assert.throws(() => migrationFiles(names.filter(name => name !== '0001_extensions.sql')));
  assert.throws(() => migrationFiles(names.filter(name => name !== '20260912175000_pgcrypto_digest_compatibility.sql')));
  assert.throws(() => migrationFiles([...names, '0001_duplicate.sql']));
  assert.throws(() => migrationFiles([...names, 'bad-name.sql']));
});

test('native author runner requires explicit disposable hosted Linux CI', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', BOOKWORM_NATIVE_AUTHOR_TEST: '1' };
  assert.doesNotThrow(() => requireNativeAuthorRunner(env, 'linux'));
  for (const key of Object.keys(env)) assert.throws(() => requireNativeAuthorRunner({ ...env, [key]: '' }, 'linux'));
  assert.throws(() => requireNativeAuthorRunner(env, 'win32'));
  assert.throws(() => requireNativeAuthorRunner({ ...env, RUNNER_ENVIRONMENT: 'self-hosted' }, 'linux'));
});

test('runner refuses a normal checkout before creating files or launching services', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./e2e/run-native-author-files.mjs', import.meta.url))],
    { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires an explicitly enabled GitHub-hosted Linux runner/);
  assert.equal(result.stdout, '');
});

test('child environment drops operator credentials, dotenv hooks, proxies and Docker overrides', () => {
  assert.deepEqual(childEnvironment({ PATH: 'test-path', HOME: 'test-home', OPENAI_API_KEY: 'secret',
    SUPABASE_URL: 'https://hosted.example', SUPABASE_ACCESS_TOKEN: 'secret', NODE_OPTIONS: '--import dotenv/config',
    DOCKER_HOST: 'tcp://remote.example', DOCKER_CONTEXT: 'production', HTTPS_PROXY: 'https://proxy.example' }),
  { PATH: 'test-path', HOME: 'test-home' });
});

test('origins and Supabase status reject hosted, ambiguous and unowned endpoints', () => {
  for (const value of ['https://project.supabase.co', 'http://localhost:55321', 'http://127.0.0.2:55321',
    'http://127.0.0.1', 'http://user:password@127.0.0.1:55321', 'http://127.0.0.1:55321/path',
    'http://127.0.0.1:55321/?secret=value']) assert.throws(() => localOrigin(value));
  const status = { API_URL: 'http://127.0.0.1:55321', ANON_KEY: 'a'.repeat(30), SERVICE_ROLE_KEY: 'b'.repeat(30) };
  assert.equal(localStatus(JSON.stringify(status)).url, status.API_URL);
  assert.throws(() => localStatus(JSON.stringify({ ...status, API_URL: 'http://127.0.0.1:55322' })));
  assert.throws(() => localStatus(JSON.stringify({ ...status, SERVICE_ROLE_KEY: '' })));
});

test('network guard blocks external calls before credentials can leave and refuses redirects', async () => {
  let calls = 0;
  const guarded = localFetch(new Set(['http://127.0.0.1:55321']), async (_input, init) => {
    calls++;
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    return new Response('local only');
  });
  for (const url of ['https://api.openai.com/v1/responses', 'https://project.supabase.co/auth/v1/user',
    'http://127.0.0.1:3001/v1/books', 'http://u:p@127.0.0.1:55321/auth/v1/user']) {
    await assert.rejects(guarded(url, { headers: { authorization: 'Bearer disposable-test' } }));
  }
  assert.equal(calls, 0);
  await guarded('http://127.0.0.1:55321/storage/v1/object/sign/test?token=disposable');
  assert.equal(calls, 1);
});
