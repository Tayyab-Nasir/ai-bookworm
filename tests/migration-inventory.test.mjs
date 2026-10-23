import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrationInventory } from '../scripts/migration-inventory.mjs';
const hash = 'a'.repeat(64);
const local = ['0001_extensions.sql', '20260831022214_tenant_hardening.sql', '20260912170000_audiobook_hardening.sql', '20261013110000_canonical_text.sql'].map(file => ({ file, sha256: hash }));
const applied = [
  { version: '20260912035021', name: '0001_extensions' },
  { version: '20260912035024', name: '20260831022214_tenant_hardening' },
  { version: '20260912044427', name: 'audiobook_hardening' },
];
test('maps full and historical short names without replaying application-time timestamps', () => {
  const result = migrationInventory(local, applied);
  assert.deepEqual([result.localCount, result.appliedCount, result.pendingCount], [4, 3, 1]);
  assert.equal(result.applied[2].file, '20260912170000_audiobook_hardening.sql');
  assert.equal(result.applied[2].hostedVersion, '20260912044427');
  assert.deepEqual(result.pending, [local[3]]); assert.equal(result.schemaParityVerified, false);
  assert.equal(applied.length, 3); assert.equal(local.length, 4);
});
test('rejects ambiguous names, unknown history, holes, duplicates and reordered history', () => {
  for (const [source, history] of [
    [[...local, { file: '20261014110000_audiobook_hardening.sql', sha256: hash }], applied],
    [local, [{ ...applied[0], name: 'unknown' }]], [local, [applied[0], applied[2]]],
    [local, [applied[1], applied[0]]], [local, [...applied, applied[2]]],
    [[...local, { ...local[3] }], applied], [local, [{ ...applied[0], version: 'bad' }]],
    [[{ file: '../escape.sql', sha256: hash }], []], [[{ ...local[0], sha256: 'bad' }], []],
  ]) assert.throws(() => migrationInventory(source, history));
});
test('empty and fully applied histories produce deterministic non-mutating inventories', () => {
  assert.equal(migrationInventory(local, []).pendingCount, 4);
  assert.equal(migrationInventory(local.slice(0, 3), applied).pendingCount, 0);
  assert.deepEqual(migrationInventory([...local].reverse(), applied).pending, [local[3]]);
});
