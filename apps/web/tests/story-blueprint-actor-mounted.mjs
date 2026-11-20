import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ApiClientError} from '@bookworm/api-client'; window.TestApiClientError=ApiClientError; import App from './apps/web/components/StoryBlueprintClient'; const root=createRoot(document.getElementById('root')); window.mount=()=>root.render(React.createElement(App,{bookId:'88888888-8888-4888-8888-888888888888'})); window.unmount=()=>root.render(null); window.mount();`, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /^(\.\/api|next\/link)$/ }, a => ({ path: a.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ resolveDir: process.cwd(), contents: a.path === './api'
      ? `const clients = new Map(); export const apiClient = actor => {if(!clients.has(actor)) clients.set(actor,{getStoryBlueprint:(...args)=>window.getBlueprint(actor,...args), saveStoryBlueprint:(...args)=>window.saveBlueprint(actor,...args), listStoryBlueprintModels:async()=>({models:[{id:'fixture',label:'Fixture',model:'fixture'}]}), requestStoryBlueprintQuote:(...args)=>window.createQuote(actor,...args), recoverStoryBlueprintQuoteRequest:(...args)=>window.recoverQuote(actor,...args), closeStoryBlueprintQuoteRequest:(...args)=>window.closeQuote(actor,...args), getStoryBlueprintQuoteRequest:(...args)=>window.quoteStatus(actor,...args), getStoryBlueprintProposal:(...args)=>window.proposalStatus(actor,...args), listStoryBlueprintProposals:(...args)=>window.listProposals(actor,...args), acceptStoryBlueprintQuote:(...args)=>window.acceptQuote(actor,...args), resolveStoryBlueprintQuote:(...args)=>window.resolveQuote(actor,...args)}); return clients.get(actor);};`
      : `import React from 'react'; export default function Link({children,...props}) {return React.createElement('a',props,children)}` }));
  } }],
});
const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<div id="root"></div>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || 'chrome' });
after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
const ids = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222' };

async function fixture() {
  const page = await browser.newPage();
  page.setDefaultTimeout(2500);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(ids => {
    window.ids = ids; window.actor = ids.a; window.role = 'owner'; window.calls = []; window.allowed = true;
    window.fetch = async url => {
      if (String(url) !== '/api/auth/session') throw Error('Unexpected session request');
      return Response.json({ user: { id: window.actor, email: 'author@example.test' } });
    };
    window.blueprint = { revision: 1, story: { workingTitle: 'Private title', premise: '', readerPromise: '', genre: '', tone: '', pointOfView: '', tense: '', targetWordCount: null, synopsis: '', theme: '', notes: '' }, chapterPlan: [], materializations: [] };
    window.quoteCalls = []; window.acceptCalls = 0; window.quotes = {}; window.closedKeys = new Set(); window.closeCalls = 0; window.quoteMode = 'saved-lost'; window.acceptMode = 'lost-accepted'; window.resolveState = 'open';
    window.requestId = '33333333-3333-4333-8333-333333333333'; window.proposalId = '44444444-4444-4444-8444-444444444444';
    window.jobId = '55555555-5555-4555-8555-555555555555'; window.accepted = false;
    window.getBlueprint = async actor => {
      window.calls.push({ action: 'read', actor, current: window.actor });
      if (actor && actor !== window.actor) throw Error('Account changed');
      if (!window.allowed) throw Error('Access revoked');
      if (window.holdRead) { window.holdRead = false; await new Promise(resolve => { window.releaseRead = resolve; }); }
      return { blueprint: structuredClone(window.blueprint), role: window.role };
    };
    window.saveBlueprint = async (actor, _book, data) => {
      window.calls.push({ action: 'save', actor, current: window.actor });
      if (actor && actor !== window.actor) throw Error('Account changed');
      if (window.holdSave) await new Promise(resolve => { window.releaseSave = resolve; });
      window.blueprint = { ...window.blueprint, revision: 2, story: data.story, chapterPlan: data.chapterPlan };
      return { blueprint: structuredClone(window.blueprint), role: window.role };
    };
    window.createQuote = async (actor, _book, body) => {
      window.quoteCalls.push({ actor, current: window.actor, ...body });
      if (actor !== window.actor) throw Error('Account changed');
      const request = { id: window.requestId, status: 'queued' };
      if (window.quoteMode !== 'absent-lost') window.quotes[body.idempotencyKey] = request;
      if (window.quoteMode === 'queued') return { request, proposal: null };
      if (window.quoteMode !== 'ready') throw Error('Lost quote response');
      return { request, proposal: window.proposal() };
    };
    window.recoverQuote = async (actor, _book, key) => {
      if (actor !== window.actor) throw Error('Account changed');
      return { request: window.quotes[key] ?? null, proposal: null };
    };
    window.closeQuote = async (actor, _book, key) => {
      if (actor !== window.actor) throw Error('Account changed');
      window.closeCalls++;
      if (window.quotes[key]) return { state: 'exists', request: window.quotes[key], proposal: null };
      window.closedKeys.add(key);
      if (window.loseCloseReply) { window.loseCloseReply = false; throw Error('Lost closure response'); }
      return { state: 'closed', request: null, proposal: null };
    };
    window.quoteStatus = async actor => {
      if (actor !== window.actor) throw Error('Account changed');
      return { request: { id: window.requestId, status: 'queued' }, proposal: null };
    };
    window.proposal = () => ({ id: window.proposalId, requestId: window.requestId, sourceRevision: 1, model: 'fixture', reservedCredits: 42, expiresAt: '2099-01-01T00:00:00.000Z', acceptedJobId: window.accepted ? window.jobId : null, status: window.accepted ? 'accepted' : 'ready' });
    window.proposalStatus = async actor => {
      if (window.proposalMissing || actor !== window.actor || actor !== window.ids.a) throw new window.TestApiClientError(404, 'not_found', 'Quote not found', 'fixture');
      const candidate = window.reviewReady ? { story: structuredClone(window.blueprint.story), chapterPlan: [], confidence: 0.8, rationale: 'A saved review.' } : null;
      return { proposal: window.proposal(), candidate, reviewStatus: window.reviewStatusOverride ?? (candidate ? 'ready' : 'pending') };
    };
    window.listProposals = async actor => {
      if (actor !== window.actor) throw Error('Account changed');
      return { proposals: [{ ...window.proposal(), createdAt: '2026-11-20T00:00:00.000Z' }], nextCursor: null };
    };
    window.acceptQuote = async actor => {
      if (actor !== window.actor) throw Error('Account changed');
      window.acceptCalls++;
      if (window.acceptMode === 'lost-accepted') window.accepted = true;
      throw Error('Lost acceptance response');
    };
    window.resolveQuote = async actor => {
      if (actor !== window.actor) throw Error('Account changed');
      return { state: window.resolveState };
    };
  }, ids);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByLabel('Working title').waitFor();
  return page;
}

test('account switch hides the plan and restores the original unsaved draft', async () => {
  const p = await fixture();
  try {
    await p.getByLabel('Working title').fill('Unsaved private draft');
    await p.evaluate(() => { window.actor = window.ids.b; window.dispatchEvent(new Event('focus')); });
    await p.getByLabel('Working title').waitFor({ state: 'hidden' });
    assert.equal(await p.locator('button:visible', { hasText: 'Save blueprint' }).count(), 0);
    await p.evaluate(() => { window.actor = window.ids.a; window.dispatchEvent(new Event('focus')); });
    await p.getByLabel('Working title').waitFor({ state: 'visible' });
    assert.equal(await p.getByLabel('Working title').inputValue(), 'Unsaved private draft');
    assert.equal(await p.evaluate(() => window.calls.filter(call => call.action === 'save').length), 0);
  } finally { await p.close(); }
});

test('a silent account switch cannot save an old draft under the new account', async () => {
  const p = await fixture();
  try {
    await p.getByLabel('Working title').fill('Unsaved private draft');
    await p.evaluate(() => { window.actor = window.ids.b; });
    await p.getByRole('button', { name: 'Save blueprint' }).click();
    await p.getByLabel('Working title').waitFor({ state: 'hidden' });
    assert.equal(await p.evaluate(() => window.calls.filter(call => call.action === 'save').length), 0);
  } finally { await p.close(); }
});

test('revocation hides the draft and a restored viewer cannot edit it', async () => {
  const p = await fixture();
  try {
    await p.getByLabel('Working title').fill('Unsaved private draft');
    await p.evaluate(() => { window.allowed = false; window.dispatchEvent(new Event('focus')); });
    await p.getByLabel('Working title').waitFor({ state: 'hidden' });
    await p.evaluate(() => { window.allowed = true; window.role = 'viewer'; window.dispatchEvent(new Event('focus')); });
    await p.getByLabel('Working title').waitFor({ state: 'visible' });
    assert.equal(await p.getByLabel('Working title').inputValue(), 'Unsaved private draft');
    assert.equal(await p.getByLabel('Working title').isDisabled(), true);
  } finally { await p.close(); }
});

test('a late save cannot replace a hidden draft after an account switch', async () => {
  const p = await fixture();
  try {
    await p.getByLabel('Working title').fill('Unsaved private draft');
    await p.evaluate(() => { window.holdSave = true; });
    await p.getByRole('button', { name: 'Save blueprint' }).click();
    await p.waitForFunction(() => typeof window.releaseSave === 'function');
    await p.evaluate(() => { window.actor = window.ids.b; window.dispatchEvent(new Event('focus')); window.releaseSave(); });
    await p.getByLabel('Working title').waitFor({ state: 'hidden' });
    await p.waitForFunction(() => window.blueprint.revision === 2);
    await p.evaluate(() => { window.actor = window.ids.a; window.dispatchEvent(new Event('focus')); });
    await p.getByLabel('Working title').waitFor({ state: 'visible' });
    assert.equal(await p.getByLabel('Working title').inputValue(), 'Unsaved private draft');
    await p.getByText('A newer saved version is available').waitFor();
    assert.deepEqual(await p.evaluate(() => window.calls.filter(call => call.action === 'save').map(call => call.actor)), [ids.a]);
  } finally { await p.close(); }
});

test('stale counting consent cannot queue a quote under another account', async () => {
  const p = await fixture();
  try {
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.evaluate(() => { window.actor = window.ids.b; });
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByLabel('Working title').waitFor({ state: 'hidden' });
    assert.equal(await p.evaluate(() => window.quoteCalls.length), 0);
    assert.equal(await p.evaluate(() => sessionStorage.length), 0);
  } finally { await p.close(); }
});

test('a silent account switch cannot open a previous account credit confirmation', async () => {
  const p = await fixture();
  let dialogs = 0;
  p.on('dialog', dialog => { dialogs++; void dialog.accept(); });
  try {
    await p.evaluate(() => { window.quoteMode = 'ready'; });
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByLabel('Review Story Blueprint quote').waitFor();
    await p.evaluate(() => { window.actor = window.ids.b; });
    await p.getByRole('button', { name: 'Confirm 42-credit hold & generate proposal' }).click();
    await p.getByLabel('Working title').waitFor({ state: 'hidden' });
    assert.equal(dialogs, 0);
    assert.equal(await p.evaluate(() => window.acceptCalls), 0);
  } finally { await p.close(); }
});

test('a lost quote response recovers the original request after remount without another count', async () => {
  const p = await fixture();
  try {
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByLabel('Recovering saved Story Blueprint quote').waitFor();
    const saved = await p.evaluate(() => ({ calls: window.quoteCalls, values: Object.values(sessionStorage) }));
    assert.equal(saved.calls.length, 1);
    assert.equal(saved.calls[0].actor, ids.a);
    assert.match(saved.values.join(' '), new RegExp(saved.calls[0].idempotencyKey));
    assert.doesNotMatch(saved.values.join(' '), /Private title|premise|notes/);
    await p.evaluate(() => window.unmount());
    await p.getByLabel('Working title').waitFor({ state: 'detached' });
    await p.evaluate(() => window.mount());
    await p.getByLabel('Preparing Story Blueprint quote').waitFor();
    assert.equal(await p.evaluate(() => window.quoteCalls.length), 1);
    assert.equal(await p.getByRole('button', { name: 'Prepare fixed quote' }).isDisabled(), true);
  } finally { await p.close(); }
});

test('a missing original quote remains blocked until its original identity appears', async () => {
  const p = await fixture();
  try {
    await p.evaluate(() => { window.quoteMode = 'absent-lost'; });
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByLabel('Recovering saved Story Blueprint quote').waitFor();
    await p.getByRole('button', { name: 'Refresh status' }).click();
    await p.getByText(/original quote request is not visible yet/i).waitFor();
    assert.equal(await p.getByRole('button', { name: 'Prepare fixed quote' }).isDisabled(), true);
    await p.evaluate(() => { window.quotes[window.quoteCalls[0].idempotencyKey] = { id: window.requestId, status: 'queued' }; });
    await p.getByRole('button', { name: 'Refresh status' }).click();
    await p.getByLabel('Preparing Story Blueprint quote').waitFor();
    assert.equal(await p.evaluate(() => window.quoteCalls.length), 1);
  } finally { await p.close(); }
});

test('blocked recovery storage prevents a paid-adjacent quote request', async () => {
  const p = await fixture();
  try {
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.evaluate(() => { Storage.prototype.setItem = () => { throw Error('Synthetic storage unavailable'); }; });
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByText('Synthetic storage unavailable').waitFor();
    assert.equal(await p.evaluate(() => window.quoteCalls.length), 0);
  } finally { await p.close(); }
});

test('a lost closure reply keeps the original identity until the same closure is confirmed', async () => {
  const p = await fixture();
  p.on('dialog', dialog => dialog.accept());
  try {
    await p.evaluate(() => { window.quoteMode = 'absent-lost'; window.loseCloseReply = true; });
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByLabel('Recovering saved Story Blueprint quote').waitFor();
    await p.getByRole('button', { name: 'Close if not queued' }).click();
    await p.getByText('Lost closure response').waitFor();
    assert.equal(await p.evaluate(() => sessionStorage.length), 1);
    assert.equal(await p.getByRole('button', { name: 'Prepare fixed quote' }).isDisabled(), true);
    await p.getByRole('button', { name: 'Close if not queued' }).click();
    await p.getByText(/unqueued original request was closed/i).waitFor();
    assert.equal(await p.evaluate(() => window.closeCalls), 2);
    assert.equal(await p.evaluate(() => window.closedKeys.has(window.quoteCalls[0].idempotencyKey)), true);
    assert.equal(await p.evaluate(() => sessionStorage.length), 0);
    assert.equal(await p.getByLabel(/I agree to send this saved Story Blueprint/i).isChecked(), false);
    assert.equal(await p.evaluate(() => window.quoteCalls.length), 1);
  } finally { await p.close(); }
});

test('closing an identity that has since arrived recovers the existing count', async () => {
  const p = await fixture();
  p.on('dialog', dialog => dialog.accept());
  try {
    await p.evaluate(() => { window.quoteMode = 'absent-lost'; });
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByLabel('Recovering saved Story Blueprint quote').waitFor();
    await p.evaluate(() => { window.quotes[window.quoteCalls[0].idempotencyKey] = { id: window.requestId, status: 'queued' }; });
    await p.getByRole('button', { name: 'Close if not queued' }).click();
    await p.getByLabel('Preparing Story Blueprint quote').waitFor();
    assert.equal(await p.evaluate(() => window.quoteCalls.length), 1);
    assert.equal(await p.evaluate(() => window.closedKeys.size), 0);
  } finally { await p.close(); }
});

test('lost acceptance stays locked and recovers the accepted job without a second hold', async () => {
  const p = await fixture();
  p.on('dialog', dialog => dialog.accept());
  try {
    await p.evaluate(() => { window.quoteMode = 'ready'; });
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByRole('button', { name: 'Confirm 42-credit hold & generate proposal' }).click();
    await p.getByText(/Acceptance is unconfirmed/i).waitFor();
    assert.equal(await p.getByRole('button', { name: 'Confirm 42-credit hold & generate proposal' }).isDisabled(), true);
    await p.getByRole('button', { name: 'Refresh status' }).click();
    await p.getByText('Queued for review', { exact: true }).waitFor();
    assert.equal(await p.evaluate(() => window.acceptCalls), 1);
  } finally { await p.close(); }
});

test('an unconfirmed acceptance remains locked when a status read still says ready', async () => {
  const p = await fixture();
  p.on('dialog', dialog => dialog.accept());
  try {
    await p.evaluate(() => { window.quoteMode = 'ready'; window.acceptMode = 'lost-unknown'; });
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByRole('button', { name: 'Confirm 42-credit hold & generate proposal' }).click();
    await p.getByText(/Acceptance is unconfirmed/i).waitFor();
    await p.getByRole('button', { name: 'Refresh status' }).click();
    await p.getByText(/Acceptance is unconfirmed/i).waitFor();
    await p.getByRole('button', { name: 'Resolve previous quote' }).click();
    await p.getByText(/earlier quote can still be accepted/i).waitFor();
    assert.equal(await p.getByRole('button', { name: 'Confirm 42-credit hold & generate proposal' }).isDisabled(), true);
    await p.evaluate(() => window.unmount());
    await p.getByLabel('Working title').waitFor({ state: 'detached' });
    await p.evaluate(() => window.mount());
    await p.getByText(/Acceptance is unconfirmed/i).waitFor();
    assert.equal(await p.evaluate(() => window.acceptCalls), 1);
  } finally { await p.close(); }
});

test('an unusable quote is cleared only after its original acceptance is resolved', async () => {
  const p = await fixture();
  p.on('dialog', dialog => dialog.accept());
  try {
    await p.evaluate(() => { window.quoteMode = 'ready'; window.acceptMode = 'lost-unknown'; window.resolveState = 'unusable'; });
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByRole('button', { name: 'Confirm 42-credit hold & generate proposal' }).click();
    await p.getByText(/Acceptance is unconfirmed/i).waitFor();
    await p.getByRole('button', { name: 'Resolve previous quote' }).click();
    await p.getByText(/earlier quote cannot be accepted/i).waitFor();
    assert.equal(await p.evaluate(() => sessionStorage.length), 0);
    assert.equal(await p.getByLabel(/I agree to send this saved Story Blueprint/i).isChecked(), false);
    assert.equal(await p.evaluate(() => window.acceptCalls), 1);
    assert.equal(await p.evaluate(() => window.quoteCalls.length), 1);
  } finally { await p.close(); }
});

test('resolution of an accepted quote recovers the original job', async () => {
  const p = await fixture();
  p.on('dialog', dialog => dialog.accept());
  try {
    await p.evaluate(() => { window.quoteMode = 'ready'; window.resolveState = 'accepted'; });
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByRole('button', { name: 'Confirm 42-credit hold & generate proposal' }).click();
    await p.getByText(/Acceptance is unconfirmed/i).waitFor();
    await p.getByRole('button', { name: 'Resolve previous quote' }).click();
    await p.getByText(/earlier quote was accepted/i).waitFor();
    await p.getByText('Queued for review', { exact: true }).waitFor();
    assert.equal(await p.evaluate(() => window.acceptCalls), 1);
  } finally { await p.close(); }
});

test('a finished paid review can be reopened from history without another count or hold', async () => {
  const p = await fixture();
  p.on('dialog', dialog => dialog.accept());
  try {
    await p.evaluate(() => { window.quoteMode = 'ready'; });
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByRole('button', { name: 'Confirm 42-credit hold & generate proposal' }).click();
    await p.getByText(/Acceptance is unconfirmed/i).waitFor();
    await p.evaluate(() => { window.reviewReady = true; });
    await p.getByRole('button', { name: 'Refresh status' }).click();
    await p.getByText('A saved review.').waitFor();
    await p.getByRole('button', { name: 'Finish review' }).click();
    await p.getByText(/Review finished/).waitFor();
    assert.equal(await p.evaluate(() => sessionStorage.length), 0);
    await p.getByRole('button', { name: 'View saved proposals' }).click();
    await p.getByRole('button', { name: 'Open proposal' }).click();
    await p.getByText('A saved review.').waitFor();
    assert.equal(await p.evaluate(() => window.quoteCalls.length), 1);
    assert.equal(await p.evaluate(() => window.acceptCalls), 1);
  } finally { await p.close(); }
});

test('a proposal with an unresolved hold cannot be finished or replaced from history', async () => {
  const p = await fixture();
  p.on('dialog', dialog => dialog.accept());
  try {
    await p.evaluate(() => { window.quoteMode = 'ready'; window.reviewStatusOverride = 'requires_review'; });
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByRole('button', { name: 'Confirm 42-credit hold & generate proposal' }).click();
    await p.getByText(/Acceptance is unconfirmed/i).waitFor();
    await p.getByRole('button', { name: 'Refresh status' }).click();
    await p.getByText(/credit settlement needs review/i).waitFor();
    await p.getByRole('button', { name: 'View saved proposals' }).click();
    assert.equal(await p.getByRole('button', { name: 'Finish review' }).count(), 0);
    assert.equal(await p.getByRole('button', { name: 'Currently open' }).isDisabled(), true);
    assert.equal(await p.getByRole('button', { name: 'Prepare fixed quote' }).isDisabled(), true);
    assert.equal(await p.evaluate(() => window.acceptCalls), 1);
  } finally { await p.close(); }
});

test('a storage failure after queuing retains the original identity for recovery', async () => {
  const p = await fixture();
  try {
    await p.evaluate(() => {
      window.quoteMode = 'queued'; window.originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (value.includes('requestId')) throw Error('Synthetic checkpoint update failure');
        return window.originalSetItem.call(this, key, value);
      };
    });
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByText('Synthetic checkpoint update failure').waitFor();
    assert.equal(await p.evaluate(() => window.quoteCalls.length), 1);
    assert.match(await p.evaluate(() => Object.values(sessionStorage).join(' ')), /idempotencyKey/);
    await p.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; window.unmount(); });
    await p.getByLabel('Working title').waitFor({ state: 'detached' });
    await p.evaluate(() => window.mount());
    await p.getByLabel('Preparing Story Blueprint quote').waitFor();
    assert.equal(await p.evaluate(() => window.quoteCalls.length), 1);
  } finally { await p.close(); }
});

test('legacy book-only pointers migrate only after the original owner can read them', async () => {
  const p = await fixture();
  try {
    await p.evaluate(() => window.unmount());
    await p.getByLabel('Working title').waitFor({ state: 'detached' });
    await p.evaluate(() => {
      sessionStorage.setItem('story-blueprint-proposal:88888888-8888-4888-8888-888888888888', JSON.stringify({ proposalId: window.proposalId }));
      window.actor = window.ids.b; window.mount();
    });
    await p.getByLabel('Recovering saved Story Blueprint quote').waitFor();
    assert.equal(await p.getByRole('button', { name: 'Prepare fixed quote' }).isDisabled(), true);
    assert.equal(await p.evaluate(() => sessionStorage.length), 1);
    await p.evaluate(() => window.unmount());
    await p.getByLabel('Working title').waitFor({ state: 'detached' });
    await p.evaluate(() => { window.actor = window.ids.a; window.mount(); });
    await p.getByLabel('Review Story Blueprint quote').waitFor();
    assert.equal(await p.evaluate(() => sessionStorage.getItem('story-blueprint-proposal:88888888-8888-4888-8888-888888888888')), null);
    assert.ok(await p.evaluate(() => sessionStorage.getItem(`story-blueprint-proposal:v2:${window.ids.a}:88888888-8888-4888-8888-888888888888`)));
    assert.equal(await p.evaluate(() => window.quoteCalls.length), 0);
  } finally { await p.close(); }
});

test('a missing quote triggers a book-access recheck before keeping the draft visible', async () => {
  const p = await fixture();
  try {
    await p.evaluate(() => { window.quoteMode = 'ready'; });
    await p.getByLabel(/I agree to send this saved Story Blueprint/i).check();
    await p.getByRole('button', { name: 'Prepare fixed quote' }).click();
    await p.getByLabel('Review Story Blueprint quote').waitFor();
    await p.evaluate(() => { window.allowed = false; window.proposalMissing = true; });
    await p.getByRole('button', { name: 'Refresh status' }).click();
    await p.getByLabel('Working title').waitFor({ state: 'hidden' });
  } finally { await p.close(); }
});

test('a malformed saved checkpoint blocks new counting and offers a recovery retry', async () => {
  const p = await fixture();
  try {
    await p.evaluate(() => window.unmount());
    await p.getByLabel('Working title').waitFor({ state: 'detached' });
    await p.evaluate(() => {
      sessionStorage.setItem(`story-blueprint-proposal:v2:${window.ids.a}:88888888-8888-4888-8888-888888888888`, '{"idempotencyKey":"not-a-uuid"}');
      window.mount();
    });
    await p.getByLabel('Checking Story Blueprint recovery').waitFor();
    assert.equal(await p.getByRole('button', { name: 'Prepare fixed quote' }).isDisabled(), true);
    await p.getByRole('button', { name: 'Refresh status' }).click();
    await p.getByText('Invalid Story Blueprint recovery checkpoint.').waitFor();
    assert.equal(await p.evaluate(() => window.quoteCalls.length), 0);
  } finally { await p.close(); }
});
