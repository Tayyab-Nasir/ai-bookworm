import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('SQL checks out with LF even when Windows autocrlf is enabled', () => {
  const tempRoot = realpathSync(os.tmpdir());
  const dir = mkdtempSync(path.join(tempRoot, 'bookworm-sql-eol-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    git('init', '-q');
    git('config', 'core.autocrlf', 'true');
    writeFileSync(path.join(dir, '.gitattributes'), readFileSync(new URL('../.gitattributes', import.meta.url)));
    mkdirSync(path.join(dir, 'supabase', 'migrations'), { recursive: true });
    const migration = 'supabase/migrations/20261013110000_canonical_import_reading_text.sql';
    const original = readFileSync(new URL(`../${migration}`, import.meta.url));
    writeFileSync(path.join(dir, migration), original);
    git('add', '.gitattributes', migration);
    const output = path.join(dir, 'checkout');
    mkdirSync(output);
    git('checkout-index', '--prefix', `${output}${path.sep}`, '--', migration);
    const checkedOut = readFileSync(path.join(output, migration));
    assert.ok(!checkedOut.includes(Buffer.from('\r\n')), 'SQL checkout must not contain CRLF');
    assert.ok(checkedOut.includes(Buffer.from('\n')), 'test must exercise multiline SQL');
  } finally {
    assert.equal(path.dirname(realpathSync(dir)), tempRoot);
    rmSync(dir, { recursive: true, force: true });
  }
});
