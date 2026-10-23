/** Dedicated non-provider import consumer. No shell command, arbitrary role, or inherited app secrets. */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readProcessingConfig, healthy } from './run-local-processing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const osKeys = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP',
  'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT', 'COMSPEC', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMDATA', 'HOME', 'LANG', 'LANGUAGE', 'LC_ALL', 'TMPDIR']);

export function createImportWorkerPlan(config, systemEnv = process.env, projectRoot = root) {
  const env = Object.fromEntries(Object.entries(systemEnv).filter(([key, value]) => osKeys.has(key.toUpperCase()) && typeof value === 'string'));
  const value = (key, minimum = 1, maximum = 8192) => {
    const input = config[key];
    if (typeof input !== 'string' || input !== input.trim() || input.length < minimum || input.length > maximum || /[\r\n\0]/u.test(input)) throw new Error('Invalid import worker configuration.');
    return input;
  };
  let supabase;
  try { supabase = new URL(value('SUPABASE_URL')); } catch { throw new Error('Invalid Supabase origin.'); }
  if (supabase.username || supabase.password || supabase.search || supabase.hash || supabase.pathname !== '/'
    || !(supabase.protocol === 'https:' || supabase.protocol === 'http:' && supabase.hostname === '127.0.0.1')) throw new Error('Invalid Supabase origin.');
  Object.assign(env, { NODE_ENV: 'production', LOG_LEVEL: 'error', SUPABASE_URL: supabase.origin,
    SUPABASE_ANON_KEY: value('SUPABASE_ANON_KEY', 16), SUPABASE_SERVICE_ROLE_KEY: value('SUPABASE_SERVICE_ROLE_KEY', 32),
    // These satisfy the common configuration contract; document imports do not use either store.
    REDIS_URL: 'redis://127.0.0.1:6379', QDRANT_URL: 'http://127.0.0.1:6333' });
  const dependencies = ['document', 'scanning'].map(role => {
    const prefix = role.toUpperCase(), input = value(`${prefix}_SERVICE_URL`);
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/?$/u.test(input)) throw new Error('Import processing services must be loopback-only.');
    const origin = new URL(input);
    if (Number(origin.port) > 65535 || !origin.port) throw new Error('Invalid import service port.');
    env[`${prefix}_SERVICE_URL`] = origin.origin;
    env[`${prefix}_SERVICE_TOKEN`] = value(`${prefix}_SERVICE_TOKEN`, 32, 512);
    return { role, url: origin.origin, healthPath: role === 'scanning' ? '/ready' : '/health' };
  });
  if (new Set(dependencies.map(item => item.url)).size !== 2 || dependencies.some(item => item.url === supabase.origin)) throw new Error('Import service origins must be distinct.');
  return { command: process.execPath, args: ['--import', 'tsx', join(projectRoot, 'workers/run.mjs'), 'document'],
    cwd: projectRoot, env, dependencies };
}

/** ponytail: one local non-provider consumer; Linux production continues to use systemd. */
export async function runImportWorker(plan, options = {}) {
  const log = options.log ?? (event => console.log(JSON.stringify(event)));
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
      failed = true; log({ event: 'document_worker_forced_stop', pid: child.pid });
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
    if (!(await Promise.all(plan.dependencies.map(ready))).every(Boolean)) throw new Error('Private import services are not ready.');
    let checking = false;
    checkTimer = setInterval(async () => {
      if (stopped || checking) return;
      checking = true;
      try { if (!(await Promise.all(plan.dependencies.map(ready))).every(Boolean) && !stopped) {
        failed = true; log({ event: 'document_dependencies_unavailable' }); stop();
      } } catch { if (!stopped) { failed = true; log({ event: 'document_dependencies_unavailable' }); stop(); } }
      finally { checking = false; }
    }, options.healthIntervalMs ?? 10_000); checkTimer.unref();
    while (!stopped) {
      const now = Date.now(); while (starts[0] < now - 60_000) starts.shift();
      if (starts.length >= 5) { failed = true; log({ event: 'document_worker_restart_limit' }); break; }
      starts.push(now); child = start();
      child.on('message', message => {
        if (message?.event === 'document_worker_control_ready') {
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
            if (result.status === 'document_worker_unavailable') log({ event: 'document_worker_unavailable' });
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
      log({ event: 'document_worker_started', pid: child.pid, attempt: starts.length, providerKeysPassed: false });
      const code = await closed;
      clearTimeout(forceTimer); forceTimer = undefined;
      if (stopped) { if (code !== 0) failed = true; break; }
      log({ event: 'document_worker_restarting', attempt: starts.length });
      try { await delay(options.restartDelayMs ?? 5000, undefined, { signal: wake.signal }); }
      catch { if (!stopped) throw new Error('Import worker restart interrupted.'); }
    }
    if (failed) throw new Error('Local import worker stopped; inspect sanitized status and queue leases.');
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
