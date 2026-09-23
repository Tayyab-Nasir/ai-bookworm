import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (...args) => spawnSync(process.execPath, ['workers/run.mjs', ...args], {
  cwd: root, encoding: 'utf8', timeout: 5000,
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production' },
});

test('worker inventory is inspectable without app secrets or a TypeScript loader', () => {
  const list = run('--list'); assert.equal(list.status, 0, list.stderr);
  const { workers } = JSON.parse(list.stdout);
  assert.equal(Object.keys(workers).length, 9);
  assert.deepEqual(workers.translation.slice(1), ['--quoted']);
  assert.deepEqual(workers['translation-quotes'].slice(1), ['--prepare-quotes']);
  assert.deepEqual(workers.blueprint.slice(1), ['--quoted']);
  assert.deepEqual(workers['blueprint-quotes'].slice(1), ['--prepare-quotes']);
  const check = run('--check'); assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout.trim().split('\n').length, 9);
  const target = readFileSync(new URL('../ops/systemd/bookworm-workers.target', import.meta.url), 'utf8');
  for (const name of Object.keys(workers)) assert(target.includes(`bookworm-worker@${name}.service`));
});

test('launcher rejects paths and mode overrides before loading any worker', () => {
  for (const args of [[], ['../services/api/src/index.ts'], ['constructor'], ['translation', '--legacy'],
    ['translation', '--prepare-quotes'], ['--check', '--once'], ['document', '--once', '--once']]) {
    const result = run(...args); assert.equal(result.status, 1, String(args));
    assert.match(result.stderr, /Worker launcher failed/);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /Supabase|Invalid environment configuration/);
  }
});

test('each allowlisted worker loads through tsx and refuses to start without configuration', () => {
  const { workers } = JSON.parse(run('--list').stdout);
  for (const name of Object.keys(workers)) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'workers/run.mjs', name, '--once'], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production' },
    });
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /worker startup failed/i, name);
    assert.doesNotMatch(result.stderr, /Worker launcher failed|ERR_MODULE_NOT_FOUND|SyntaxError/, name);
    assert.equal(result.stdout, '', name);
  }
});
