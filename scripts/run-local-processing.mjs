/** Loopback-only Python processing services. Never starts workers or loads app credentials. */
import { spawn } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const roles = Object.freeze({ document: 8001, rendering: 8002, publishing: 8003, scanning: 8004 });
const osKeys = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP',
  'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT', 'COMSPEC', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMDATA']);

export async function readProcessingConfig(path) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 65_536) throw new Error('Invalid processing configuration file.');
  return parseEnv(await readFile(path, 'utf8'));
}

/** Explicit allowlists keep Supabase, OpenAI, payment and shared fallback secrets out of parsers. */
export function createProcessingPlan(config, systemEnv = process.env, projectRoot = root) {
  const base = Object.fromEntries(Object.entries(systemEnv).filter(([key, value]) => osKeys.has(key.toUpperCase()) && typeof value === 'string'));
  Object.assign(base, { TZ: 'UTC', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' });
  const python = config.BOOKWORM_PYTHON || join(projectRoot, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  if (!isAbsolute(python)) throw new Error('BOOKWORM_PYTHON must be an absolute executable path.');
  const ports = new Set();
  const tokens = new Set();
  const clamdPort = Object.hasOwn(config, 'CLAMD_PORT') ? config.CLAMD_PORT : '3310';
  if (!/^[1-9]\d{0,4}$/.test(clamdPort) || Number(clamdPort) > 65_535) throw new Error('Invalid local ClamAV port.');
  for (const [role, defaultPort] of Object.entries(roles)) {
    const prefix = role.toUpperCase();
    const token = config[`${prefix}_SERVICE_TOKEN`];
    if (typeof token !== 'string' || token !== token.trim() || !/^[A-Za-z0-9._~-]{32,512}$/.test(token)) throw new Error(`Invalid ${role} service token.`);
    if (tokens.has(token)) throw new Error('Use a separate token for each processing service.');
    tokens.add(token);
    const rawUrl = Object.hasOwn(config, `${prefix}_SERVICE_URL`) ? config[`${prefix}_SERVICE_URL`] : `http://127.0.0.1:${defaultPort}`;
    let url;
    try { url = new URL(rawUrl); } catch { throw new Error(`Invalid ${role} service origin.`); }
    if (typeof rawUrl !== 'string' || rawUrl !== rawUrl.trim() || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/?$/.test(rawUrl)
      || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
      || !url.port || url.pathname !== '/' || url.search || url.hash || ports.has(Number(url.port))
      || Number(url.port) === Number(clamdPort)) throw new Error(`Invalid ${role} service origin.`);
    ports.add(Number(url.port));
  }
  return Object.entries(roles).map(([role, defaultPort]) => {
    const prefix = role.toUpperCase();
    const url = new URL(config[`${prefix}_SERVICE_URL`] ?? `http://127.0.0.1:${defaultPort}`);
    const env = { ...base, [`${prefix}_SERVICE_TOKEN`]: config[`${prefix}_SERVICE_TOKEN`] };
    if (role === 'scanning') Object.assign(env, { CLAMD_HOST: '127.0.0.1', CLAMD_PORT: clamdPort });
    return { role, url: url.origin, port: Number(url.port), command: python, env,
      cwd: join(projectRoot, 'services', role),
      healthPath: role === 'scanning' ? '/ready' : '/health',
      args: ['-m', 'uvicorn', role === 'scanning' ? 'scanning_service.main:app' : 'main:app',
        '--host', '127.0.0.1', '--port', url.port, '--no-access-log', '--log-level', 'warning'] };
  });
}

async function prerequisites(plan) {
  await access(plan[0].command);
  for (const service of plan) await access(join(service.cwd, service.role === 'scanning' ? 'scanning_service/main.py' : 'main.py'));
}

async function portAvailable(port) {
  await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolvePort));
  });
}

export async function healthy(service) {
  try {
    const response = await fetch(service.url + service.healthPath, { redirect: 'error', signal: AbortSignal.timeout(1500) });
    if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel(); return false;
    }
    const reader = response.body?.getReader();
    if (!reader) return false;
    let body = '';
    let size = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) { await reader.cancel(); return false; }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const result = JSON.parse(body);
    return result.status === (service.role === 'scanning' ? 'ready' : 'ok')
      && (service.role !== 'scanning' || (result.engine?.name === 'ClamAV' && typeof result.engine?.databaseVersion === 'string'));
  } catch { return false; }
}

export async function runProcessing(plan) {
  await prerequisites(plan);
  for (const service of plan) await portAvailable(service.port);
  const children = [];
  let stopping = false;
  let ready = false;
  let finish;
  const done = new Promise(resolveDone => { finish = resolveDone; });
  function stop(failed = false) {
    if (stopping) return;
    stopping = true;
    if (failed) process.exitCode = 1;
    for (const child of children) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      if (process.platform === 'win32') {
        // Windows venv python.exe is a redirector: killing only that PID can
        // orphan the actual Python HTTP server. Target only this live child's
        // owned process tree, never an executable name or arbitrary input PID.
        const terminator = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        terminator.once('error', () => { console.error('Owned processing shutdown failed. Check the local process tree.'); process.exitCode = 1; });
        terminator.once('exit', code => { if (code !== 0 && child.exitCode === null) process.exitCode = 1; });
      } else child.kill();
    }
    finish();
  }
  const signalStop = () => stop();
  const input = data => { if (data.trim() === 'stop') stop(); };
  process.once('SIGINT', signalStop); process.once('SIGTERM', signalStop);
  process.stdin.setEncoding('utf8'); process.stdin.on('data', input);
  try {
    for (const service of plan) {
      const child = spawn(service.command, service.args, { cwd: service.cwd, env: service.env,
        windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      children.push(child);
      // Do not echo parser tracebacks, document bytes, service headers or configuration.
      child.stderr.resume();
      child.once('error', () => { console.error(`${service.role} could not start.`); stop(true); });
      child.once('exit', code => {
        if (!stopping) { console.error(`${service.role} exited unexpectedly (${Number.isInteger(code) ? code : 'signal'}).`); stop(true); }
      });
    }
    const deadline = performance.now() + 30_000;
    while (!stopping && performance.now() < deadline) {
      if ((await Promise.all(plan.map(healthy))).every(Boolean)) { ready = true; break; }
      await delay(500);
    }
    if (!stopping && !ready) {
      console.error('Processing startup failed: check Python dependencies, ports and the fresh loopback ClamAV engine.');
      stop(true);
    }
    if (ready && !stopping) console.log(JSON.stringify({ status: 'ready', loopbackOnly: true,
      services: plan.map(({ role, port }) => ({ role, port })),
      providerKeysPassed: false, supabaseKeysPassed: false, workersStarted: false }));
    // Observe real process/HTTP health. A failure stops the owned fleet; no hidden respawn.
    while (!stopping) {
      await Promise.race([done, delay(10_000, undefined, { ref: false })]);
      if (!stopping && !(await Promise.all(plan.map(healthy))).every(Boolean)) {
        console.error('A private processing service is no longer ready. The local fleet has stopped.'); stop(true);
      }
    }
  } finally {
    stop();
    process.removeListener('SIGINT', signalStop); process.removeListener('SIGTERM', signalStop);
    process.stdin.removeListener('data', input); process.stdin.pause();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--list') {
    console.log(JSON.stringify({ services: Object.entries(roles).map(([role, port]) => ({ role, port })) })); return;
  }
  if (args[0] !== '--config' || !args[1] || args[1].startsWith('--') || args.length > 3
    || (args[2] !== undefined && args[2] !== '--check')) throw new Error('invalid_arguments');
  const plan = createProcessingPlan(await readProcessingConfig(resolve(args[1])));
  if (args[2] === '--check') {
    await prerequisites(plan);
    console.log(JSON.stringify({ status: 'configuration-valid', services: plan.map(({ role, port }) => ({ role, port })),
      providerKeysPassed: false, supabaseKeysPassed: false, workersStarted: false })); return;
  }
  await runProcessing(plan);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Local processing launcher failed. Use --list or --config <private-env-file> [--check]. No workers were started.');
  process.exitCode = 1;
});
