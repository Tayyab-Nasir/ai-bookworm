import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrationAudit, migrationInventory } from '../scripts/migration-inventory.mjs';
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

test('audit identifies gaps and later applied migrations without claiming rollout readiness', () => {
  const history = [applied[0], applied[2], { version: '20260912044428', name: 'canonical_text' }];
  const result = migrationAudit(local, history);
  assert.equal(result.mappedCount, 3);
  assert.deepEqual(result.missingFromHistory, [local[1]]);
  assert.equal(result.strictPrefix, false);
  assert.equal(result.sourceOrderMismatch, false);
  assert.equal(result.schemaParityVerified, false);
  assert.equal(result.rolloutReady, false);
  assert.throws(() => migrationInventory(local, history));
});

test('audit reports unknown and reordered history without treating it as safe', () => {
  const result = migrationAudit(local, [applied[2], { version: '20260912035026', name: 'other_migration' }, applied[0]]);
  assert.deepEqual(result.unrecognized, [{ version: '20260912035026', name: 'other_migration' }]);
  assert.equal(result.hostedVersionOrderMismatch, true);
  assert.equal(result.sourceOrderMismatch, true);
  assert.equal(result.strictPrefix, false);
  assert.equal(result.rolloutReady, false);
  assert.throws(() => migrationInventory(local, [applied[2], applied[0]]));
});

test('audit retains duplicate and identity validation and recognizes a clean prefix', () => {
  assert.equal(migrationAudit(local, applied).strictPrefix, true);
  assert.throws(() => migrationAudit(local, [...applied, { version: '20260912044428', name: '20260912170000_audiobook_hardening' }]));
  assert.throws(() => migrationAudit(local, [applied[0], applied[0]]));
  assert.throws(() => migrationAudit([...local, { file: '20261014110000_audiobook_hardening.sql', sha256: hash }], applied));
  assert.throws(() => migrationAudit(local, [{ version: 'bad', name: 'other' }]));
  assert.throws(() => migrationAudit([{ file: '../escape.sql', sha256: hash }], []));
});

test('audit separately reports a source-name prefix with reversed hosted versions', () => {
  const reversedVersions = [{ ...applied[0], version: '20260912044428' }, applied[1]];
  const result = migrationAudit(local, reversedVersions);
  assert.equal(result.sourceNamePrefix, true);
  assert.equal(result.hostedVersionOrderMismatch, true);
  assert.equal(result.strictPrefix, false);
  assert.equal(result.rolloutReady, false);
  // Preserve the existing helper's name-order-only behavior for callers.
  assert.equal(migrationInventory(local, reversedVersions).appliedCount, 2);
});
