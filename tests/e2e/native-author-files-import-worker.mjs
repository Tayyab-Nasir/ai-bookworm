/** Real persistent document consumer, restricted to the runner-owned native project. */
import assert from 'node:assert/strict';
import { createImportWorkerPlan, runImportWorker } from '../../scripts/run-local-import-worker.mjs';
import { requireNativeAuthorRunner } from './native-author-files-guard.mjs';

function bounded(promise, milliseconds = 30_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Native automatic import deadline exceeded.')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

export async function withAutomaticNativeImport(action) {
  requireNativeAuthorRunner();
  assert.equal(process.env.NODE_ENV, 'production');
  assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:55321');
  const plan = createImportWorkerPlan(process.env);
  assert(!Object.keys(plan.env).some(key => /OPENAI|STRIPE|AI_SERVICE|RENDERING_SERVICE|PUBLISHING_SERVICE|PRICING|PURCHASE_ENABLED|SERVICE_AUTH_TOKEN/u.test(key)));
  const stop = new AbortController(), outcomes = new Map(), waiting = new Map();
  let started, startupFailed;
  const startup = new Promise((resolve, reject) => { started = resolve; startupFailed = reject; });
  const consumer = runImportWorker(plan, { signal: stop.signal, shutdownGraceMs: 15_000,
    log: event => {
      if (event.event === 'document_worker_started') started();
      if (event.status && event.jobId) {
        outcomes.set(event.jobId, event); waiting.get(event.jobId)?.(event);
      }
    },
  });
  void consumer.catch(() => { startupFailed(new Error('Native document consumer did not remain available.')); });
  try {
    await bounded(startup);
    const result = await action(async jobId => {
      const outcome = outcomes.get(jobId) ?? await bounded(new Promise(resolve => waiting.set(jobId, resolve)));
      waiting.delete(jobId); assert.equal(outcome.status, 'succeeded', 'Persistent consumer did not complete the exact queued import');
      assert.equal(outcome.jobId, jobId); return outcome;
    });
    console.log('PASS native persistent document consumer completed the real queued DOCX import without manual job invocation');
    return result;
  } finally {
    stop.abort(); await bounded(consumer, 20_000);
  }
}
