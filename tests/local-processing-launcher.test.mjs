import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createProcessingPlan, readProcessingConfig } from '../scripts/run-local-processing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const token = index => `synthetic-${String(index).repeat(40)}`;
const config = () => Object.fromEntries(['DOCUMENT', 'RENDERING', 'PUBLISHING', 'SCANNING'].map((role, index) => [`${role}_SERVICE_TOKEN`, token(index)]));
const run = (...args) => spawnSync(process.execPath, ['scripts/run-local-processing.mjs', ...args], {
  cwd: root, encoding: 'utf8', timeout: 5000,
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OPENAI_API_KEY: 'never-echo-this-synthetic-secret' },
});

test('processing inventory is secret-free and does not import app or worker configuration', () => {
  const result = run('--list');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).services, [
    { role: 'document', port: 8001 }, { role: 'rendering', port: 8002 },
    { role: 'publishing', port: 8003 }, { role: 'scanning', port: 8004 },
  ]);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /never-echo|OPENAI|Supabase/);
});

test('only each role token and an allowlisted OS environment reach the local Python service', () => {
  const settings = { ...config(), OPENAI_API_KEY: 'forbidden', SUPABASE_SERVICE_ROLE_KEY: 'forbidden',
    SERVICE_AUTH_TOKEN: 'forbidden', DOCUMENT_IMPORT_ROOT: 'forbidden', CLAMD_HOST: 'external.invalid' };
  const plan = createProcessingPlan(settings, { PATH: 'system-path', SystemRoot: 'system-root',
    OPENAI_API_KEY: 'forbidden', SUPABASE_ANON_KEY: 'forbidden', SUPABASE_SERVICE_ROLE_KEY: 'forbidden',
    SERVICE_AUTH_TOKEN: 'forbidden', NODE_OPTIONS: '--import forbidden', PYTHONPATH: 'forbidden' });
  assert.equal(plan.length, 4);
  for (const service of plan) {
    const key = `${service.role.toUpperCase()}_SERVICE_TOKEN`;
    assert.equal(service.env[key], settings[key]);
    assert.deepEqual(Object.keys(service.env).filter(name => name.endsWith('_SERVICE_TOKEN')), [key]);
    assert.equal(service.env.PATH, 'system-path');
    assert.equal(service.env.SystemRoot, 'system-root');
    assert.equal(service.env.TZ, 'UTC');
    assert.equal(service.env.PYTHONDONTWRITEBYTECODE, '1');
    assert.ok(!Object.values(service.env).includes('forbidden'));
    assert.ok(!Object.values(service.env).includes('--import forbidden'));
    assert.equal(service.args[service.args.indexOf('--host') + 1], '127.0.0.1');
    assert.equal(service.args[service.args.indexOf('--port') + 1], String(service.port));
    assert.ok(service.args.includes('--no-access-log'));
    assert.equal(service.cwd, join(root, 'services', service.role));
  }
  assert.equal(plan[3].env.CLAMD_HOST, '127.0.0.1');
  assert.equal(plan[3].env.CLAMD_PORT, '3310');
  assert.equal(plan[3].healthPath, '/ready');
  assert.equal(plan[3].args[2], 'scanning_service.main:app');
  assert.ok(plan.slice(0, 3).every(service => service.env.CLAMD_HOST === undefined));
});

test('custom ports and an absolute Python executable remain loopback-only', () => {
  const python = join(root, 'synthetic-python');
  const plan = createProcessingPlan({ ...config(), BOOKWORM_PYTHON: python,
    DOCUMENT_SERVICE_URL: 'http://127.0.0.1:18001/', CLAMD_PORT: '13310' }, {});
  assert.equal(plan[0].url, 'http://127.0.0.1:18001');
  assert.equal(plan[0].port, 18001);
  assert.ok(plan.every(service => service.command === python));
  assert.equal(plan[3].env.CLAMD_PORT, '13310');
});

test('a token cannot be missing, shared, whitespace-bearing, truncated or unbounded', () => {
  for (const value of [undefined, '', 'short', 'x'.repeat(31), 'x'.repeat(513),
    ` ${token(0)}`, `${token(0)}\n`, `${token(0)}\r\n`, `${token(0)}\0`, `${token(0)} secret`]) {
    assert.throws(() => createProcessingPlan({ ...config(), DOCUMENT_SERVICE_TOKEN: value }, {}), /Invalid document service token/);
  }
  assert.throws(() => createProcessingPlan({ ...config(), SCANNING_SERVICE_TOKEN: token(0) }, {}), /separate token/);
  for (const length of [32, 512]) assert.equal(createProcessingPlan({ ...config(), DOCUMENT_SERVICE_TOKEN: 'x'.repeat(length) }, {})[0].env.DOCUMENT_SERVICE_TOKEN.length, length);
});

test('service origins reject remote, ambiguous, credential-bearing and conflicting endpoints', () => {
  for (const value of ['http://localhost:8001', 'http://0.0.0.0:8001', 'http://[::1]:8001',
    'https://127.0.0.1:8001', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
    'http://127.0.0.1:08001', 'http://127.1:8001', 'http://user:secret@127.0.0.1:8001',
    'http://127.0.0.1:8001/path', 'http://127.0.0.1:8001/../', 'http://127.0.0.1:8001?secret=1',
    'http://127.0.0.1:8001#fragment', ' http://127.0.0.1:8001', 'http://127.0.0.1:8001\n',
    'http://127.0.0.1:8002', 'http://127.0.0.1:3310', null, 8001]) {
    assert.throws(() => createProcessingPlan({ ...config(), DOCUMENT_SERVICE_URL: value }, {}), /Invalid \w+ service origin/, String(value));
  }
});

test('local scanner port and Python executable cannot use ambiguous configuration', () => {
  for (const value of ['0', '03310', '65536', '3310\n', '-1', 'invalid']) {
    assert.throws(() => createProcessingPlan({ ...config(), CLAMD_PORT: value }, {}), /ClamAV port/);
  }
  assert.throws(() => createProcessingPlan({ ...config(), BOOKWORM_PYTHON: 'python' }, {}), /absolute executable/);
});

test('private configuration loader refuses directories and CLI diagnostics never echo arguments or app secrets', async () => {
  await assert.rejects(readProcessingConfig(root), /Invalid processing configuration/);
  for (const args of [[], ['document'], ['--config'], ['--config', '--check'],
    ['--config', 'not-present-private.env'], ['--config', 'private.env', '--worker'],
    ['--list', '--config', 'private.env'], ['--config', 'never-echo-this-path-secret', '--check', '--check']]) {
    const result = run(...args);
    assert.equal(result.status, 1, String(args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Local processing launcher failed/);
    assert.doesNotMatch(result.stderr, /never-echo|not-present|Supabase|OPENAI|Error:|ENOENT/);
  }
});

async function unusedPorts() {
  const servers = [createServer(), createServer()];
  await Promise.all(servers.map(server => new Promise((yes, no) => {
    server.once('error', no); server.listen(0, '127.0.0.1', yes);
  })));
  const ports = servers.map(server => server.address().port);
  await Promise.all(servers.map(server => new Promise(yes => server.close(yes))));
  return ports;
}

function harness(ports, failAfterReady = false, nativePython = false) {
  const plan = createProcessingPlan(config(), { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, root)
    .filter(service => nativePython ? service.role === 'document' : ['document', 'scanning'].includes(service.role));
  for (let index = 0; index < plan.length; index++) {
    const service = plan[index];
    service.port = ports[index]; service.url = `http://127.0.0.1:${service.port}`;
    if (nativePython) {
      service.args[service.args.indexOf('--port') + 1] = String(service.port); continue;
    }
    service.command = process.execPath;
    const body = service.role === 'scanning'
      ? { status: 'ready', engine: { name: 'ClamAV', databaseVersion: 'synthetic-test-only' } }
      : { status: 'ok' };
    const fixture = `const http=require('node:http');console.error('never-echo-private-parser-error');
      http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(${JSON.stringify(JSON.stringify(body))});}).listen(${service.port},'127.0.0.1');
      ${failAfterReady && index === 0 ? 'setTimeout(()=>process.exit(7),4000);' : ''}`;
    service.args = ['-e', fixture];
  }
  const source = `import {runProcessing} from ${JSON.stringify(new URL('../scripts/run-local-processing.mjs', import.meta.url).href)};
    await runProcessing(${JSON.stringify(plan)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  const exited = new Promise((yes, no) => { child.once('error', no); child.once('exit', code => yes(code)); });
  const ready = new Promise((yes, no) => {
    child.stdout.on('data', value => {
      stdout += value;
      if (stdout.includes('\n')) {
        try { yes(JSON.parse(stdout.split('\n')[0])); } catch (error) { no(error); }
      }
    });
    exited.then(code => { if (!stdout.includes('\n')) no(new Error(`Harness exited ${code}.`)); }, no);
  });
  return { child, exited, ready, diagnostics: () => stdout + stderr };
}

async function closed(ports) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const open = await Promise.all(ports.map(async port => {
      try { const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(200) }); await response.body?.cancel(); return true; }
      catch { return false; }
    }));
    if (!open.some(Boolean)) return true;
    await delay(50);
  }
  return false;
}

test('owned HTTP children stop together on explicit local shutdown', { timeout: 12_000 }, async t => {
  const ports = await unusedPorts();
  const runtime = harness(ports);
  t.after(() => { runtime.child.stdin.end('stop\n'); });
  const ready = await runtime.ready;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.loopbackOnly, true);
  assert.equal(ready.providerKeysPassed, false);
  assert.equal(ready.supabaseKeysPassed, false);
  assert.equal(ready.workersStarted, false);
  runtime.child.stdin.write('stop\n');
  assert.equal(await runtime.exited, 0);
  assert.equal(await closed(ports), true, 'Owned processing children remained listening.');
  assert.doesNotMatch(runtime.diagnostics(), /never-echo-private|synthetic-000/);
});

test('unexpected child exit fails closed and stops its owned siblings without exposing stderr', { timeout: 15_000 }, async t => {
  const ports = await unusedPorts();
  const runtime = harness(ports, true);
  t.after(() => { runtime.child.stdin.end('stop\n'); });
  assert.equal((await runtime.ready).status, 'ready');
  assert.equal(await runtime.exited, 1);
  assert.equal(await closed(ports), true, 'Failed local fleet left an owned sibling running.');
  assert.match(runtime.diagnostics(), /document exited unexpectedly \(7\)/);
  assert.doesNotMatch(runtime.diagnostics(), /never-echo-private|synthetic-000/);
});

test('native Windows venv shutdown removes both the redirector and actual HTTP process', {
  timeout: 15_000,
  skip: process.platform !== 'win32' || !existsSync(join(root, '.venv/Scripts/python.exe')),
}, async t => {
  const ports = (await unusedPorts()).slice(0, 1);
  const runtime = harness(ports, false, true);
  t.after(() => { runtime.child.stdin.end('stop\n'); });
  assert.equal((await runtime.ready).status, 'ready');
  assert.equal((await fetch(`http://127.0.0.1:${ports[0]}/health`)).status, 200);
  runtime.child.stdin.write('stop\n');
  assert.equal(await runtime.exited, 0);
  assert.equal(await closed(ports), true, 'Windows virtualenv left its real Python child running.');
});
