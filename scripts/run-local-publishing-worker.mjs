import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readProcessingConfig } from './run-local-processing.mjs';
import { createPublishingWorkerPlan, runPublishingWorker } from './run-local-import-worker.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check') {
    await access(new URL('../workers/run.mjs', import.meta.url));
    await access(new URL('../workers/publishing/worker.ts', import.meta.url));
    console.log(JSON.stringify({ role: 'publishing', entrypoint: 'workers/publishing/worker.ts', status: 'present', workersStarted: false }));
    return;
  }
  if (args.length !== 2 || args[0] !== '--config' || !args[1] || args[1].startsWith('--')) {
    throw new Error('Invalid publishing worker arguments.');
  }
  await runPublishingWorker(createPublishingWorkerPlan(await readProcessingConfig(resolve(args[1]))));
}

main().catch(() => {
  console.error('Local publishing worker failed. Use --check or --config <private-env-file>.');
  process.exitCode = 1;
});
