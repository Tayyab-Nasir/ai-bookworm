import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { finished } from 'node:stream/promises';
import { createImportWorkerPlan, runImportWorker } from '../scripts/run-local-import-worker.mjs';

const root = resolve('.');
const config = () => ({ SUPABASE_URL: 'https://project.example.test', SUPABASE_ANON_KEY: 'synthetic-anonymous-key',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-private-database-key-no-network',
  DOCUMENT_SERVICE_URL: 'http://127.0.0.1:8001', DOCUMENT_SERVICE_TOKEN: 'd'.repeat(40),
  SCANNING_SERVICE_URL: 'http://127.0.0.1:8004', SCANNING_SERVICE_TOKEN: 's'.repeat(40) });
const wait = (promise, milliseconds = 8000) => { let timer; return Promise.race([promise, new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error('Local import test deadline exceeded')), milliseconds);
})]).finally(() => clearTimeout(timer)); };

test('import launcher inspection needs no secrets and cannot select paid roles or arbitrary paths', () => {
  for (const args of [['--check'], [], ['--config'], ['ai'], ['--config', '--check'], ['--check', '--once']]) {
    const child = spawnSync(process.execPath, ['scripts/run-local-import-worker.mjs', ...args], {
      cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OPENAI_API_KEY: 'private-canary-never-echo' },
      encoding: 'utf8', timeout: 3000,
    });
    assert.equal(child.status, args.length === 1 && args[0] === '--check' ? 0 : 1);
    assert(!child.stdout.includes('private-canary') && !child.stderr.includes('private-canary'));
    if (child.status === 0) assert.deepEqual(JSON.parse(child.stdout), { role: 'document', entrypoint: 'workers/document/worker.ts', status: 'present', workersStarted: false });
  }
});

test('document-only environment excludes provider, payment, proxies, Node injection and unrelated service credentials', () => {
  const input = { ...config(), OPENAI_API_KEY: 'secret-provider', STRIPE_SECRET_KEY: 'secret-payment',
    SERVICE_AUTH_TOKEN: 'shared-token', RENDERING_SERVICE_TOKEN: 'secret-renderer', AI_SERVICE_TOKEN: 'secret-ai' };
  const plan = createImportWorkerPlan(input, { PATH: 'allowed-path', NODE_OPTIONS: '--import=private-loader', HTTPS_PROXY: 'private-proxy',
    OPENAI_API_KEY: 'inherited-provider', SUPABASE_SERVICE_ROLE_KEY: 'wrong-project', TMP: 'allowed-temp' });
  assert.equal(plan.env.NODE_ENV, 'production'); assert.equal(plan.env.PATH, 'allowed-path'); assert.equal(plan.env.TMP, 'allowed-temp');
  assert.equal(plan.env.SUPABASE_SERVICE_ROLE_KEY, input.SUPABASE_SERVICE_ROLE_KEY);
  assert.deepEqual(plan.args, ['--import', 'tsx', join(root, 'workers/run.mjs'), 'document']);
  for (const key of ['OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'SERVICE_AUTH_TOKEN', 'RENDERING_SERVICE_TOKEN', 'AI_SERVICE_TOKEN', 'NODE_OPTIONS', 'HTTPS_PROXY']) assert(!(key in plan.env), key);
  assert.equal(plan.env.REDIS_URL, 'redis://127.0.0.1:6379', 'Unused common configuration must not leak an authenticated Redis URL');
});

test('configuration rejects ambiguous, remote or credential-bearing processing destinations and unbounded tokens', () => {
  for (const patch of [
    { SUPABASE_URL: 'http://external.example.test' }, { SUPABASE_URL: 'https://user:password@project.example.test' },
    { SUPABASE_URL: 'https://project.example.test/?token=private' }, { SUPABASE_URL: 'https://project.example.test/path' },
    { DOCUMENT_SERVICE_URL: 'http://localhost:8001' }, { DOCUMENT_SERVICE_URL: 'http://127.0.0.1:8001/?x=1' },
    { DOCUMENT_SERVICE_URL: 'http://127.0.0.1:65536' }, { SCANNING_SERVICE_URL: 'http://127.0.0.1:8001' },
    { DOCUMENT_SERVICE_TOKEN: 'short' }, { DOCUMENT_SERVICE_TOKEN: 'd'.repeat(513) }, { SCANNING_SERVICE_TOKEN: 's'.repeat(40) + '\n' },
    { SUPABASE_ANON_KEY: '' }, { SUPABASE_SERVICE_ROLE_KEY: '' },
  ]) assert.throws(() => createImportWorkerPlan({ ...config(), ...patch }, {}));
});

const scratch = await mkdtemp(join(tmpdir(), 'bookworm-import-consumer-test-'));
const fixture = join(scratch, 'consumer.mjs');
await writeFile(fixture, `
import { setTimeout as delay } from 'node:timers/promises';
import { consumeDocumentJobs } from ${JSON.stringify(pathToFileURL(join(root, 'workers/document/worker.ts')).href)};
const mode=process.argv[2];
if(mode==='crash'){console.error('private-canary-from-child');console.log(JSON.stringify({status:'secret',key:'private-canary-from-child'}));process.exit(2);}
if(mode==='stubborn'){process.on('message',()=>{});await new Promise(()=>{});}
let calls=0;
await consumeDocumentJobs({}, {runOne:async()=>{
 calls++;process.send?.({phase:'claimed',calls});await delay(mode==='busy'?180:5);
 if(mode==='unavailable')throw new Error('private-canary-operation-detail');
 return mode==='idle'?{status:'idle'}:{status:'succeeded',jobId:'11111111-1111-4111-8111-111111111111'};
}});
console.log(JSON.stringify({fixture:'finished',calls}));
`);

function spawnFixture(plan, mode, onChild = () => {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, mode], { cwd: root, env: plan.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  child.stderr.resume(); onChild(child); return child;
}

for (const mode of ['idle', 'busy']) test(`owner stop interrupts ${mode} waits but finishes a claimed import exactly once`, async () => {
  const plan = createImportWorkerPlan(config()), controller = new AbortController(), events = [];
  let child, calls = 0, raw = '';
  const started = performance.now();
  await wait(runImportWorker(plan, { signal: controller.signal, healthy: async () => true,
    shutdownGraceMs: 2000, log: event => events.push(event),
    spawnWorker: () => spawnFixture(plan, mode, value => {
      child = value; child.stdout.on('data', chunk => { raw += chunk; });
      child.on('message', message => { if (message.phase === 'claimed') { calls = message.calls; setTimeout(() => controller.abort(), 30); } });
    }),
  }));
  assert.equal(calls, 1); assert.match(raw, /"fixture":"finished","calls":1/);
  assert.equal(child.exitCode, 0); assert(performance.now() - started < 1900, 'An idle shutdown must not sleep through the polling delay');
  assert.equal(events.filter(event => event.event === 'document_worker_started').length, 1);
  assert(!events.some(event => event.event === 'document_worker_forced_stop'));
  assert.equal(events.filter(event => event.status === 'succeeded').length, mode === 'busy' ? 1 : 0);
});

test('unexpected child exits have a bounded restart budget and cannot leak raw diagnostics', async () => {
  const plan = createImportWorkerPlan(config()), events = [], children = [];
  await assert.rejects(wait(runImportWorker(plan, { healthy: async () => true, restartDelayMs: 5,
    log: event => events.push(event), spawnWorker: () => spawnFixture(plan, 'crash', child => children.push(child)),
  }), 15_000), /Local import worker stopped/);
  assert.equal(children.length, 5); assert(children.every(child => child.exitCode === 2));
  assert(events.some(event => event.event === 'document_worker_restart_limit'));
  assert(!JSON.stringify(events).includes('private-canary-from-child'));
});

test('unready services and an already stopped owner never start a queue consumer', async () => {
  const plan = createImportWorkerPlan(config()); let calls = 0;
  const spawnWorker = () => { calls++; throw new Error('Unexpected worker start'); };
  await assert.rejects(runImportWorker(plan, { healthy: async () => false, spawnWorker }), /not ready/);
  const controller = new AbortController(); controller.abort();
  await runImportWorker(plan, { signal: controller.signal, spawnWorker, healthy: async () => { throw new Error('No probe after stop'); } });
  assert.equal(calls, 0);
});

test('loss of the owner IPC channel stops the real document loop after its current transaction', async () => {
  const plan = createImportWorkerPlan(config()); let output = '', calls = 0; const phases = [];
  const child = spawnFixture(plan, 'busy', value => {
    value.stdout.on('data', chunk => { output += chunk; });
    for (const event of ['spawn', 'disconnect', 'exit', 'close', 'error']) value.on(event, () => phases.push(event));
    value.on('message', message => {
      if (message.event === 'document_worker_control_ready') value.send({ command: 'start' });
      if (message.phase === 'claimed') { calls = message.calls; value.disconnect(); }
    });
  });
  try {
    // Windows may omit ChildProcess close after the parent explicitly disconnects IPC.
    // Actual exit plus both drained streams prove termination without that event.
    const [code] = await wait(Promise.all([new Promise(resolveExit => child.once('exit', resolveExit)),
      finished(child.stdout, { cleanup: true }), finished(child.stderr, { cleanup: true })]));
    assert.equal(code, 0); assert.equal(calls, 1); assert.match(output, /"fixture":"finished","calls":1/);
  } catch (error) { throw new Error(`${error.message}; lifecycle=${phases.join(',')}; exit=${child.exitCode}; calls=${calls}; finished=${output.includes('"fixture":"finished"')}`); }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

test('a stop during TypeScript startup never activates the first claim', async () => {
  const plan = createImportWorkerPlan(config()), controller = new AbortController(); let output = '', child;
  await wait(runImportWorker(plan, { signal: controller.signal, healthy: async () => true, shutdownGraceMs: 2000,
    log: event => { if (event.event === 'document_worker_started') controller.abort(); },
    spawnWorker: () => spawnFixture(plan, 'busy', value => { child = value; value.stdout.on('data', chunk => { output += chunk; }); }),
  }));
  assert.equal(child.exitCode, 0); assert.match(output, /"fixture":"finished","calls":0/);
});

test('lost dependency readiness stops the owned consumer without an automatic replacement', async () => {
  const plan = createImportWorkerPlan(config()), events = [], children = []; let probes = 0;
  await assert.rejects(wait(runImportWorker(plan, { healthy: async () => ++probes <= 2,
    healthIntervalMs: 20, shutdownGraceMs: 2000, log: event => events.push(event),
    spawnWorker: () => spawnFixture(plan, 'idle', child => children.push(child)),
  })), /Local import worker stopped/);
  assert.equal(children.length, 1); assert.equal(children[0].exitCode, 0);
  assert(events.some(event => event.event === 'document_dependencies_unavailable'));
  assert(!events.some(event => event.event === 'document_worker_forced_stop'));
});

test('an unresponsive owned child is force-stopped only after the shutdown deadline', async () => {
  const plan = createImportWorkerPlan(config()), controller = new AbortController(), events = []; let child;
  await assert.rejects(wait(runImportWorker(plan, { signal: controller.signal, healthy: async () => true,
    shutdownGraceMs: 100, log: event => { events.push(event); if (event.event === 'document_worker_started') controller.abort(); },
    spawnWorker: () => spawnFixture(plan, 'stubborn', value => { child = value; }),
  })), /Local import worker stopped/);
  assert.equal(child.signalCode, 'SIGKILL'); assert.equal(events.filter(event => event.event === 'document_worker_forced_stop').length, 1);
});

test('owner stop cancels a pending restart without starting another child', async () => {
  const plan = createImportWorkerPlan(config()), controller = new AbortController(); let starts = 0;
  await wait(runImportWorker(plan, { signal: controller.signal, healthy: async () => true,
    log: event => { if (event.event === 'document_worker_restarting') controller.abort(); },
    spawnWorker: () => { starts++; return spawnFixture(plan, 'crash'); },
  }));
  assert.equal(starts, 1);
});

test('document dependency failures remain observable without exposing the underlying diagnostic', async () => {
  const plan = createImportWorkerPlan(config()), controller = new AbortController(), events = [];
  await wait(runImportWorker(plan, { signal: controller.signal, healthy: async () => true,
    log: event => events.push(event), spawnWorker: () => spawnFixture(plan, 'unavailable', child => {
      child.on('message', message => { if (message.phase === 'claimed') setTimeout(() => controller.abort(), 50); });
    }),
  }));
  assert(events.some(event => event.event === 'document_worker_unavailable'));
  assert(!JSON.stringify(events).includes('private-canary-operation-detail'));
});
