/** Allowlisted worker entrypoint. Inspection modes never import worker code. */
import { access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const roles = Object.freeze({
  document: ['workers/document/worker.ts'],
  publishing: ['workers/publishing/worker.ts'],
  ai: ['workers/ai/worker.ts'],
  audiobook: ['workers/audiobook/worker.ts'],
  'audiobook-export': ['workers/audiobook/google-play-export-worker.ts'],
  'translation-quotes': ['workers/translation/worker.ts', '--prepare-quotes'],
  translation: ['workers/translation/worker.ts', '--quoted'],
  'blueprint-quotes': ['workers/story-blueprint/worker.ts', '--prepare-quotes'],
  blueprint: ['workers/story-blueprint/worker.ts', '--quoted'],
});

async function main() {
  const [role, ...args] = process.argv.slice(2);
  if (role === '--list' && args.length === 0) {
    console.log(JSON.stringify({ workers: roles }, null, 2)); return;
  }
  if (role === '--check' && args.length === 0) {
    for (const [name, [file]] of Object.entries(roles)) {
      await access(resolve(root, file));
      console.log(JSON.stringify({ worker: name, entrypoint: file, status: 'present' }));
    }
    return;
  }
  if (!Object.hasOwn(roles, role ?? '') || args.length > 1 || args.some((arg) => arg !== '--once')) {
    throw new Error('invalid_arguments');
  }
  const [file, ...mode] = roles[role];
  const entrypoint = resolve(root, file);
  process.argv = [process.execPath, entrypoint, ...mode, ...args];
  await import(pathToFileURL(entrypoint).href);
}

main().catch(() => {
  console.error('Worker launcher failed. Use --list, --check, or <worker> [--once]; run with node --import tsx.');
  process.exitCode = 1;
});
