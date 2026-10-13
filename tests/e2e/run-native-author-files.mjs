/** Owns only disposable CI resources. Never links, pushes, seeds plans or reads .env. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment, localStatus, migrationFiles, nativeAuthorEnvironment, nativeProjectId, ownedInternalAddress, requireNativeAuthorRunner } from './native-author-files-guard.mjs';
import { loopbackRelay } from './native-author-files-relay.mjs';

requireNativeAuthorRunner();
const root = fileURLToPath(new URL('../../', import.meta.url));
const env = childEnvironment();
const project = nativeProjectId(randomUUID());
const directory = await mkdtemp(join(tmpdir(), `${project}-`));
const serviceToken = randomUUID() + randomUUID();
const containers = [];
const relays = [];
let network;
let supabaseNetwork;
let startingStack = false;
let failure;

function diagnostic(text) {
  return text.replaceAll(serviceToken, '[private]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]')
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[key]')
    .replace(/(?:token|password|secret|key)\s*[:=]\s*\S+/gi, '[private setting]')
    .split(/\r?\n/).filter(line => /error|failed|SQLSTATE|migration|PASS|AssertionError/i.test(line)).slice(-12).join('\n');
}

async function command(label, executable, args, { input, timeout = 120_000, childEnv = env, progress = false } = {}) {
  const child = spawn(executable, args, { cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-4 * 1024 * 1024); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4 * 1024 * 1024); });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const ticker = progress ? setInterval(() => console.log(`WAIT ${label}`), 30_000) : null;
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`${label} failed (${code}).\n${diagnostic(stderr + '\n' + stdout)}`)));
    });
  } finally { clearTimeout(timer); if (ticker) clearInterval(ticker); }
  return stdout.trim();
}

async function migrationDigest() {
  const files = migrationFiles(await readdir(join(root, 'supabase/migrations')));
  assert.ok(files.length >= 109, 'Missing manuscript import migrations');
  const hash = createHash('sha256');
  for (const name of files) {
    const bytes = await readFile(join(root, 'supabase/migrations', name));
    hash.update(name + '\0').update(bytes).update('\0');
  }
  return { files, digest: hash.digest('hex') };
}

async function runContainer(image, options = []) {
  const id = await command(`start ${image}`, 'docker', ['run', '-d', '--network', network,
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '128', ...options, image]);
  assert.match(id, /^[a-f0-9]{64}$/);
  containers.push(id);
  return id;
}

async function containerOrigin(id, port) {
  const [container] = JSON.parse(await command('inspect owned internal service', 'docker', ['inspect', id]));
  const relay = await loopbackRelay(ownedInternalAddress(container, network), port);
  relays.push(relay);
  return relay.origin;
}

async function waitReady(url, headers = {}) {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch { /* The owned service may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Owned private service did not become ready.');
}

try {
  const before = await migrationDigest();
  await mkdir(join(directory, 'supabase/migrations'), { recursive: true });
  const config = (await readFile(join(root, 'ops/native-author-files/config.toml'), 'utf8'))
    .replace('__BOOKWORM_DISPOSABLE_PROJECT__', project);
  await writeFile(join(directory, 'supabase/config.toml'), config, { flag: 'wx', mode: 0o600 });
  for (const name of before.files) await copyFile(join(root, 'supabase/migrations', name), join(directory, 'supabase/migrations', name));
  console.log(`START disposable Supabase with ${before.files.length} migrations; source ${before.digest}`);
  supabaseNetwork = await command('create loopback-bound Supabase network', 'docker', ['network', 'create',
    '--driver', 'bridge', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', `${project}-supabase`]);
  assert.match(supabaseNetwork, /^[a-f0-9]{64}$/);
  startingStack = true;
  await command('disposable Supabase startup', 'supabase', ['start', '--workdir', directory,
    '--network-id', supabaseNetwork,
    '--exclude', 'realtime,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor,mailpit'], { timeout: 600_000, progress: true });
  const stackIds = await command('inspect owned stack membership', 'docker', ['network', 'inspect', supabaseNetwork]);
  const members = Object.keys(JSON.parse(stackIds)[0].Containers ?? {});
  assert.ok(members.length >= 4, 'Native Supabase services missing');
  for (const id of members) {
    assert.match(id, /^[a-f0-9]{64}$/);
    const [container] = JSON.parse(await command('verify local port exposure', 'docker', ['inspect', id]));
    assert.equal(container.Config.Labels['com.supabase.cli.project'], project, 'Native project cleanup identity mismatch');
    for (const bindings of Object.values(container.NetworkSettings.Ports ?? {})) {
      for (const binding of bindings ?? []) assert.equal(binding.HostIp, '127.0.0.1', 'Native stack must not expose ports off loopback');
    }
  }
  const status = localStatus(await command('local Supabase status', 'supabase', ['status', '--workdir', directory, '-o', 'json']));
  console.log('PASS real local Supabase stack ready; credentials retained in memory only');

  network = await command('create private processing network', 'docker', ['network', 'create', '--internal', project]);
  assert.match(network, /^[a-f0-9]{64}$/);
  const [privateNetwork] = JSON.parse(await command('verify private network', 'docker', ['network', 'inspect', network]));
  assert.equal(privateNetwork.Internal, true);
  await runContainer('bookworm-ci-clamd', ['--network-alias', 'clamd', '--memory', '4g']);
  const scanner = await runContainer('bookworm-ci-scanner', ['--memory', '256m',
    '-e', `SCANNING_SERVICE_TOKEN=${serviceToken}`, '-e', 'CLAMD_HOST=clamd']);
  const document = await runContainer('bookworm-ci-document', ['--memory', '512m',
    '-e', `SERVICE_AUTH_TOKEN=${serviceToken}`]);
  const scannerUrl = await containerOrigin(scanner, 8004);
  const documentUrl = await containerOrigin(document, 8000);
  await waitReady(`${scannerUrl}/ready`, { authorization: `Bearer ${serviceToken}` });
  await waitReady(`${documentUrl}/health`);
  console.log('PASS real ClamAV and document parser ready');

  // Generate synthetic DOCX bytes with the parser image's installed libraries.
  // No customer fixture, download, alternate scanner or parser stub is involved.
  const docx = await command('create disposable DOCX fixture', 'docker', ['exec', '-i', document, 'python', '-c',
    `from io import BytesIO
import base64
from docx import Document
from PIL import Image
image=BytesIO(); Image.new('RGB',(80,80),(40,100,160)).save(image,format='PNG'); image.seek(0)
doc=Document(); table=doc.add_table(rows=2,cols=2)
for row,values in zip(table.rows,[['Captain','Mira'],['Harbor','Dawn']]):
 for cell,value in zip(row.cells,values): cell.text=value
doc.add_picture(image)
out=BytesIO(); doc.save(out); print(base64.b64encode(out.getvalue()).decode())`]);

  const output = await command('native author HTTP journey', process.execPath,
    ['--import', 'tsx', 'tests/e2e/native-author-files.mjs'], {
      timeout: 600_000, progress: true,
      input: JSON.stringify({ ...status, scannerUrl, documentUrl, serviceToken, docx }),
      childEnv: nativeAuthorEnvironment({ ...status, scannerUrl, documentUrl, serviceToken }, env),
    });
  console.log(diagnostic(output));
  assert.equal((await migrationDigest()).digest, before.digest, 'Migration source changed during native acceptance');
  console.log('PASS migration source integrity preserved');
} catch (error) {
  failure = error;
  throw error;
} finally {
  const cleanupErrors = [];
  for (const relay of relays) {
    try { await relay.close(); } catch (error) { cleanupErrors.push(error); }
  }
  for (const id of containers.reverse()) {
    try { await command('remove owned private container', 'docker', ['rm', '-f', '-v', id]); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (network) {
    try { await command('remove owned network', 'docker', ['network', 'rm', network]); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (startingStack) {
    // Exact generated project only, never --all or the repository's linked project.
    assert.match(project, /^bwk-[a-f0-9]{32}$/);
    try { await command('remove owned Supabase stack and volumes', 'supabase',
      ['stop', '--workdir', directory, '--project-id', project, '--no-backup'], { timeout: 120_000 }); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (supabaseNetwork) {
    try { await command('remove owned Supabase network', 'docker', ['network', 'rm', supabaseNetwork]); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Disposable native cleanup failed');
  console.log('PASS owned runtime cleanup completed');
}
