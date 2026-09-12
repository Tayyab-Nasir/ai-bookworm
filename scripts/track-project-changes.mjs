import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const generatedDirectories = new Set([
  '.git', '.vercel', 'node_modules', 'dist', 'build', 'coverage',
  '.turbo', '__pycache__', '.pytest_cache', '.mypy_cache', '.venv', 'venv',
]);

// Fingerprints only: never copy file contents, environment values, or Git remotes.
export function isIncluded(path) {
  const parts = path.replaceAll('\\', '/').split('/');
  const name = parts.at(-1).toLowerCase();
  return !parts.some((part) => generatedDirectories.has(part) || part.startsWith('.next'))
    && !name.startsWith('.env')
    && !['.npmrc', '.pypirc', '.netrc', 'id_rsa', 'id_ed25519'].includes(name)
    && !/(?:secret|credential|token)s?(?:[._-]|$)/i.test(name)
    && !/\.(?:log|pyc|tsbuildinfo|pem|key|p12|pfx)$/i.test(name);
}

function git(root, args, optional = false) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch (error) {
    if (optional && error.status !== undefined) return null;
    // Git stderr may contain configuration details: do not echo it.
    throw new Error(`Git metadata check failed (${args[0]}).`);
  }
}

export function parseStatus(raw) {
  const records = raw.split('\0');
  const result = [];
  for (let i = 0; i < records.length; i++) {
    if (!records[i]) continue;
    const code = records[i].slice(0, 2);
    const path = records[i].slice(3);
    const from = /[RC]/.test(code) ? records[++i] : undefined;
    if (!isIncluded(path)) continue;
    result.push({ path, code, ...(from && isIncluded(from) ? { from } : {}) });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function capture(root) {
  root = realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim());
  const paths = [...new Set(git(root, [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ]).split('\0').filter((path) => path && isIncluded(path)))].sort();
  const files = [];
  const skipped = [];
  for (const path of paths) {
    const fullPath = resolve(root, path);
    if (!isWithin(root, fullPath)) throw new Error('Out-of-repository file in Git listing.');
    let stat;
    try { stat = lstatSync(fullPath); } catch (error) {
      if (error.code === 'ENOENT') continue; // A tracked deletion is still in ls-files.
      throw error;
    }
    if (!stat.isFile() || !isWithin(root, realpathSync(fullPath))) {
      skipped.push({ path, reason: 'not a regular in-repository file' });
      continue;
    }
    if (stat.size > 20 * 1024 * 1024) {
      skipped.push({ path, reason: 'larger than 20 MiB' });
      continue;
    }
    const bytes = readFileSync(fullPath);
    const after = lstatSync(fullPath);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
      throw new Error('A file changed during capture; retry the check.');
    }
    files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return {
    schema: 1,
    capturedAt: new Date().toISOString(),
    root,
    head: git(root, ['rev-parse', '--verify', 'HEAD'], true)?.trim() ?? null,
    branch: git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)?.trim() ?? null,
    workingTree: parseStatus(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])),
    files,
    skipped,
  };
}

export function compare(previous, current) {
  const oldFiles = new Map((previous?.files ?? []).map((file) => [file.path, file]));
  const newFiles = new Map(current.files.map((file) => [file.path, file]));
  return {
    added: current.files.filter((file) => !oldFiles.has(file.path)).map((file) => file.path),
    modified: current.files.filter((file) => oldFiles.has(file.path)
      && oldFiles.get(file.path).sha256 !== file.sha256).map((file) => file.path),
    deleted: (previous?.files ?? []).filter((file) => !newFiles.has(file.path)).map((file) => file.path),
    gitStateChanged: !previous || previous.head !== current.head || previous.branch !== current.branch
      || JSON.stringify(previous.workingTree) !== JSON.stringify(current.workingTree),
    skippedStateChanged: !previous || JSON.stringify(previous.skipped) !== JSON.stringify(current.skipped),
  };
}

export function checkProject(root, { record = false } = {}) {
  const current = capture(root);
  const gitDirectory = realpathSync(git(current.root, ['rev-parse', '--absolute-git-dir']).trim());
  const stateDirectory = resolve(gitDirectory, 'bookworm-tracking');
  if (existsSync(stateDirectory)
    && (lstatSync(stateDirectory).isSymbolicLink() || !isWithin(gitDirectory, realpathSync(stateDirectory)))) {
    throw new Error('Refusing a redirected tracking directory.');
  }
  const snapshots = existsSync(stateDirectory)
    ? readdirSync(stateDirectory).filter((name) => /^snapshot-[\dT-]+Z-[a-f\d-]+\.json$/.test(name)).sort()
    : [];
  const previousPath = snapshots.length ? resolve(stateDirectory, snapshots.at(-1)) : null;
  if (previousPath && lstatSync(previousPath).isSymbolicLink()) throw new Error('Refusing a linked snapshot.');
  const previous = previousPath ? JSON.parse(readFileSync(previousPath, 'utf8')) : null;
  if (previous && (previous.schema !== 1 || previous.root !== current.root || !Array.isArray(previous.files))) {
    throw new Error('Tracking baseline is invalid or belongs to another repository.');
  }
  const changes = compare(previous, current);
  const changed = changes.gitStateChanged || changes.skippedStateChanged
    || changes.added.length + changes.modified.length + changes.deleted.length > 0;
  let recordedPath = null;
  if (record && changed) {
    mkdirSync(stateDirectory, { recursive: true });
    const timestamp = current.capturedAt.replaceAll(':', '-').replace('.', '-');
    recordedPath = resolve(stateDirectory, `snapshot-${timestamp}-${randomUUID()}.json`);
    // Immutable, exclusive snapshots keep concurrent observations without overwriting history.
    writeFileSync(recordedPath, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx' });
  }
  return {
    capturedAt: current.capturedAt,
    previousCapturedAt: previous?.capturedAt ?? null,
    baseline: previous === null,
    changed,
    head: current.head,
    branch: current.branch,
    sourceFiles: current.files.length,
    dirtyPaths: current.workingTree,
    changes: previous ? changes : null,
    skipped: current.skipped,
    previousPath,
    recordedPath,
    notice: 'Point-in-time fingerprints, not source backups or edit-author attribution. Excludes secrets and generated files.',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => !['--record', '--help'].includes(arg))) {
      throw new Error('Supported options: --record, --help.');
    }
    if (process.argv.includes('--help')) {
      console.log('Run from the repository: node scripts/track-project-changes.mjs [--record]\nDefault: inspect only. --record: save metadata snapshots under .git/bookworm-tracking on meaningful changes.');
    } else {
      console.log(JSON.stringify(checkProject(process.cwd(), { record: process.argv.includes('--record') }), null, 2));
    }
  } catch (error) {
    console.error(`Tracking failed: ${error.message}`);
    process.exitCode = 1;
  }
}
