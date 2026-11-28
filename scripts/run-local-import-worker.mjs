/** Dedicated non-provider import consumer. No shell command, arbitrary role, or inherited app secrets. */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readProcessingConfig, healthy, READINESS_FAILURE_LIMIT } from './run-local-processing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const osKeys = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP',
  'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT', 'COMSPEC', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMDATA', 'HOME', 'LANG', 'LANGUAGE', 'LC_ALL', 'TMPDIR']);

function createLocalWorkerPlan(role, processorRoles, config, systemEnv, projectRoot) {
  const env = Object.fromEntries(Object.entries(systemEnv).filter(([key, value]) => osKeys.has(key.toUpperCase()) && typeof value === 'string'));
  const value = (key, minimum = 1, maximum = 8192) => {
    const input = config[key];
    if (typeof input !== 'string' || input !== input.trim() || input.length < minimum || input.length > maximum || /[\r\n\0]/u.test(input)) throw new Error('Invalid local worker configuration.');
    return input;
  };
  let supabase;
  try { supabase = new URL(value('SUPABASE_URL')); } catch { throw new Error('Invalid Supabase origin.'); }
  if (supabase.username || supabase.password || supabase.search || supabase.hash || supabase.pathname !== '/'
    || !(supabase.protocol === 'https:' || supabase.protocol === 'http:' && supabase.hostname === '127.0.0.1')) throw new Error('Invalid Supabase origin.');
  Object.assign(env, { NODE_ENV: 'production', LOG_LEVEL: 'error', SUPABASE_URL: supabase.origin,
    SUPABASE_ANON_KEY: value('SUPABASE_ANON_KEY', 16), SUPABASE_SERVICE_ROLE_KEY: value('SUPABASE_SERVICE_ROLE_KEY', 32),
    // These satisfy the common configuration contract without forwarding credentials for either store.
    REDIS_URL: 'redis://127.0.0.1:6379', QDRANT_URL: 'http://127.0.0.1:6333' });
  const dependencies = processorRoles.map(processor => {
    const prefix = processor.toUpperCase(), input = value(`${prefix}_SERVICE_URL`);
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/?$/u.test(input)) throw new Error('Local processing services must be loopback-only.');
    const origin = new URL(input);
    if (Number(origin.port) > 65535 || !origin.port) throw new Error('Invalid local service port.');
    env[`${prefix}_SERVICE_URL`] = origin.origin;
    env[`${prefix}_SERVICE_TOKEN`] = value(`${prefix}_SERVICE_TOKEN`, 32, 512);
    return { role: processor, url: origin.origin, healthPath: processor === 'scanning' ? '/ready' : '/health' };
  });
  if (new Set(dependencies.map(item => item.url)).size !== dependencies.length || dependencies.some(item => item.url === supabase.origin)) throw new Error('Local service origins must be distinct.');
  return { role, command: process.execPath, args: ['--import', 'tsx', join(projectRoot, 'workers/run.mjs'), role],
    cwd: projectRoot, env, dependencies };
}

export function createImportWorkerPlan(config, systemEnv = process.env, projectRoot = root) {
  return createLocalWorkerPlan('document', ['document', 'scanning'], config, systemEnv, projectRoot);
}

export function createPublishingWorkerPlan(config, systemEnv = process.env, projectRoot = root) {
  return createLocalWorkerPlan('publishing', ['rendering', 'publishing'], config, systemEnv, projectRoot);
}

export function runImportWorker(plan, options = {}) {
  if (plan.role !== undefined && plan.role !== 'document') throw new Error('Expected local document worker.');
  return superviseWorker({ ...plan, role: 'document' }, options);
}

export function runPublishingWorker(plan, options = {}) {
  if (plan.role !== 'publishing') throw new Error('Expected local publishing worker.');
  return superviseWorker(plan, options);
}

async function superviseWorker(plan, options) {
  const log = options.log ?? (event => console.log(JSON.stringify(event)));
  const role = plan.role;
  const ready = options.healthy ?? healthy;
  const start = options.spawnWorker ?? (() => spawn(plan.command, plan.args, {
    cwd: plan.cwd, env: plan.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  }));
  const wake = new AbortController(); let stopped = false, failed = false, child, forceTimer, checkTimer;
  const stop = () => {
    if (stopped) return;
    stopped = true; wake.abort();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try { child.send({ command: 'stop' }, () => {}); } catch { /* Bounded forced shutdown below handles a lost channel. */ }
    forceTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      failed = true; log({ event: `${role}_worker_forced_stop`, pid: child.pid });
      child.kill('SIGKILL');
    }, options.shutdownGraceMs ?? 360_000); forceTimer.unref();
  };
  const input = data => { if (data.trim() === 'stop') stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  options.signal?.addEventListener('abort', stop, { once: true });
  process.stdin.setEncoding('utf8'); process.stdin.on('data', input);
  const starts = [];
  try {
    if (options.signal?.aborted) stop();
    if (stopped) return;
    if (!(await Promise.all(plan.dependencies.map(ready))).every(Boolean)) throw new Error(`Private ${role === 'document' ? 'import' : role} services are not ready.`);
    let checking = false;
    let readinessFailures = 0;
    checkTimer = setInterval(async () => {
      if (stopped || checking) return;
      checking = true;
      let allReady = false;
      try { allReady = (await Promise.all(plan.dependencies.map(ready))).every(Boolean); }
      catch { /* An unsuccessful probe counts toward the same readiness limit. */ }
      finally { checking = false; }
      readinessFailures = allReady ? 0 : readinessFailures + 1;
      if (!stopped && readinessFailures >= READINESS_FAILURE_LIMIT) {
        failed = true; log({ event: `${role}_dependencies_unavailable` }); stop();
      }
    }, options.healthIntervalMs ?? 10_000); checkTimer.unref();
    while (!stopped) {
      const now = Date.now(); while (starts[0] < now - 60_000) starts.shift();
      if (starts.length >= 5) { failed = true; log({ event: `${role}_worker_restart_limit` }); break; }
      starts.push(now); child = start();
      child.on('message', message => {
        if (message?.event === `${role}_worker_control_ready`) {
          try { child.send({ command: stopped ? 'stop' : 'start' }, () => {}); } catch { stop(); }
        }
      });
      for (const stream of [child.stdout, child.stderr]) {
        let pending = '';
        stream?.on('data', chunk => {
        if (pending.length + chunk.length > 8192) { pending = ''; return; }
        pending += chunk.toString('utf8');
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          try {
            const result = JSON.parse(line);
            if (result.status === `${role}_worker_unavailable` || (role === 'publishing' && result.status === 'worker_unavailable')) {
              log({ event: `${role}_worker_unavailable` });
            }
            if (['succeeded', 'queued', 'failed', 'lease_lost', 'completion_unknown'].includes(result.status)
              && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(result.jobId)) {
              log({ status: result.status, jobId: result.jobId });
            }
          } catch { /* Never echo raw child diagnostics or document/credential content. */ }
        }
        });
      }
      const closed = new Promise(resolveExit => {
        child.once('error', () => resolveExit(1)); child.once('close', code => resolveExit(code));
      });
      log({ event: `${role}_worker_started`, pid: child.pid, attempt: starts.length, providerKeysPassed: false });
      const code = await closed;
      clearTimeout(forceTimer); forceTimer = undefined;
      if (stopped) { if (code !== 0) failed = true; break; }
      log({ event: `${role}_worker_restarting`, attempt: starts.length });
      try { await delay(options.restartDelayMs ?? 5000, undefined, { signal: wake.signal }); }
      catch { if (!stopped) throw new Error('Local worker restart interrupted.'); }
    }
    if (failed) throw new Error(`Local ${role === 'document' ? 'import' : role} worker stopped; inspect sanitized status and queue leases.`);
  } finally {
    stop(); clearInterval(checkTimer); clearTimeout(forceTimer);
    options.signal?.removeEventListener('abort', stop);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    process.stdin.removeListener('data', input); process.stdin.pause();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check') {
    await access(join(root, 'workers/run.mjs')); await access(join(root, 'workers/document/worker.ts'));
    console.log(JSON.stringify({ role: 'document', entrypoint: 'workers/document/worker.ts', status: 'present', workersStarted: false })); return;
  }
  if (args.length !== 2 || args[0] !== '--config' || !args[1] || args[1].startsWith('--')) throw new Error('Invalid import worker arguments.');
  const plan = createImportWorkerPlan(await readProcessingConfig(resolve(args[1])));
  await runImportWorker(plan);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Local import worker failed. Use --check or --config <private-env-file>. No provider credentials are forwarded.');
  process.exitCode = 1;
});
