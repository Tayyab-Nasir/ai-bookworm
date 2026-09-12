import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkProject, isIncluded, parseStatus } from './track-project-changes.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bookworm-tracker-test-')));
  execFileSync('git', ['init', '--quiet', root]);
  t.after(() => {
    // This exact directory was created above solely for this test; never delete the repo.
    assert.ok(root.startsWith(join(realpathSync(tmpdir()), 'bookworm-tracker-test-')));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('default check is read-only, record is immutable, unchanged check writes nothing', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, 'example.ts'), 'export const n = 1;');
  const probe = checkProject(root);
  assert.equal(probe.baseline, true);
  assert.equal(probe.sourceFiles, 1);
  assert.equal(existsSync(join(root, '.git', 'bookworm-tracking')), false);
  const initial = checkProject(root, { record: true });
  assert.ok(initial.recordedPath);
  const second = checkProject(root, { record: true });
  assert.equal(second.changed, false);
  assert.equal(second.recordedPath, null);
  assert.equal(second.previousPath, initial.recordedPath);
});

test('detects repeated edits when Git still reports the same untracked status', (t) => {
  const root = fixture(t);
  const path = join(root, 'draft.tsx');
  writeFileSync(path, 'first');
  const baseline = checkProject(root, { record: true });
  writeFileSync(path, 'second');
  const next = checkProject(root, { record: true });
  assert.deepEqual(next.changes.modified, ['draft.tsx']);
  assert.equal(next.changes.gitStateChanged, false);
  assert.notEqual(next.recordedPath, baseline.recordedPath);
  assert.ok(existsSync(baseline.recordedPath));
  writeFileSync(path, 'third');
  assert.deepEqual(checkProject(root).changes.modified, ['draft.tsx']);
});

test('detects additions and deletions and excludes generated files', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, 'old.ts'), 'old');
  checkProject(root, { record: true });
  unlinkSync(join(root, 'old.ts'));
  writeFileSync(join(root, 'new.ts'), 'new');
  writeFileSync(join(root, 'tsconfig.tsbuildinfo'), 'cache');
  const result = checkProject(root);
  assert.deepEqual(result.changes.deleted, ['old.ts']);
  assert.deepEqual(result.changes.added, ['new.ts']);
});

test('excludes secret files even if Git tracks them and never copies source text', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, '.env.local'), 'PRIVATE_TEST_VALUE=do-not-copy');
  writeFileSync(join(root, 'app.ts'), 'const sourceText = "also-not-copied";');
  execFileSync('git', ['-C', root, 'add', '--force', '.env.local']);
  const result = checkProject(root, { record: true });
  const stored = readFileSync(result.recordedPath, 'utf8');
  assert.equal(result.sourceFiles, 1);
  assert.ok(!stored.includes('.env.local'));
  assert.ok(!stored.includes('do-not-copy'));
  assert.ok(!stored.includes('also-not-copied'));
  for (const path of ['.env.example', '.npmrc', 'x/credentials.json', 'x/key.pem', 'x/.next/a.js']) {
    assert.equal(isIncluded(path), false, path);
  }
});

test('parses NUL-delimited renames, spaces, and Unicode without losing paths', () => {
  const result = parseStatus('R  new name.ts\0old name.ts\0?? 日本語.ts\0 D removed.ts\0');
  assert.ok(result.some((entry) => entry.path === 'new name.ts' && entry.from === 'old name.ts'));
  assert.ok(result.some((entry) => entry.path === '日本語.ts'));
  assert.ok(result.some((entry) => entry.path === 'removed.ts' && entry.code === ' D'));
});

test('does not replace an invalid saved baseline', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, 'app.ts'), 'example');
  const initial = checkProject(root, { record: true });
  writeFileSync(initial.recordedPath, '{"schema":999}');
  assert.throws(() => checkProject(root, { record: true }), /invalid/);
  assert.equal(readFileSync(initial.recordedPath, 'utf8'), '{"schema":999}');
});
