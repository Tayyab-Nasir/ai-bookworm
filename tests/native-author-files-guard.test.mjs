import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { childEnvironment, localFetch, localOrigin, localStatus, migrationFiles, requireNativeAuthorRunner } from './e2e/native-author-files-guard.mjs';

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
