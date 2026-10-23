// Offline/read-only metadata review. Never connects to, repairs or migrates a database.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function migrationInventory(local, applied) {
  if (!Array.isArray(local) || !local.length || !Array.isArray(applied)) throw new Error('Local migrations and applied metadata are required.');
  const ordered = [...local].sort((a, b) => a.file.localeCompare(b.file, 'en'));
  const aliases = new Map(), sourceVersions = new Set();
  for (const [index, row] of ordered.entries()) {
    if (!/^\d{4}(?:\d{10})?_[a-z0-9_]+\.sql$/.test(row.file) || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Invalid local migration identity or SHA-256.');
    const stem = row.file.slice(0, -4), sourceVersion = stem.split('_')[0];
    if (sourceVersions.has(sourceVersion)) throw new Error('Duplicate local migration version.');
    sourceVersions.add(sourceVersion);
    for (const alias of new Set([stem, stem.replace(/^\d{14}_/, '')])) {
      if (aliases.has(alias)) throw new Error('Ambiguous local migration name.');
      aliases.set(alias, index);
    }
  }
  const hostedVersions = new Set(), mapped = [];
  for (const [position, row] of applied.entries()) {
    if (!row || !/^\d{14}$/.test(row.version) || typeof row.name !== 'string' || !/^[a-z0-9_]+$/.test(row.name)) throw new Error('Invalid applied migration metadata.');
    if (hostedVersions.has(row.version)) throw new Error('Duplicate hosted migration version.');
    hostedVersions.add(row.version);
    const index = aliases.get(row.name);
    if (index === undefined) throw new Error(`Unrecognized applied migration name: ${row.name}`);
    if (index !== position) throw new Error('Applied history is not a contiguous ordered source prefix. Review drift before any upgrade.');
    mapped.push({ ...ordered[index], hostedVersion: row.version, hostedName: row.name });
  }
  return { localCount: ordered.length, appliedCount: mapped.length, pendingCount: ordered.length - mapped.length,
    mappingBasis: 'Migration names only; hosted application timestamps are not source versions.',
    schemaParityVerified: false, applied: mapped, pending: ordered.slice(mapped.length) };
}

export async function readLocalMigrations(directory) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  return Promise.all(names.map(async file => {
    const bytes = await readFile(join(directory, file));
    return { file, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
}

async function main(args) {
  if (args.length !== 2 || args[0] !== '--applied') throw new Error('Usage: node scripts/migration-inventory.mjs --applied <metadata.json>');
  const input = resolve(args[1]);
  if ((await stat(input)).size > 1024 * 1024) throw new Error('Migration metadata must be smaller than 1 MiB.');
  const metadata = JSON.parse(await readFile(input, 'utf8'));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const inventory = migrationInventory(await readLocalMigrations(join(root, 'supabase/migrations')), metadata.migrations);
  console.log(JSON.stringify({ reviewedAt: new Date().toISOString(), ...inventory }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
