/**
 * Synthetic paid quotes only; never calls a provider or reads app credentials.
 * The 28 primitive native schedules cover billing, not worker completion.
 * Completion schedules use real lease/completion RPCs and durable
 * receipts, but their results/measurements are synthetic, not provider/Storage proof.
 * The runner supplies a trusted service-role claim; this is not GoTrue/PostgREST
 * authentication, provider receipt delivery, or operational worker-loop coverage.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const service = "set request.jwt.claim.role='service_role';";
const kinds = ['metadata', 'ai_review', 'book_bible', 'image'];
const json = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

export async function paidQuoteFixture(sql, kind) {
  assert.ok(kinds.includes(kind));
  const user = randomUUID(), org = randomUUID();
  const offers = Array.from({ length: 2 }, () => ({ workspace: randomUUID(), book: randomUUID(),
    chapter: randomUUID(), version: randomUUID(), job: randomUUID() }));
  const image = kind === 'image', reserve = image ? 31 : 1200;
  const text = 'Native paid quote.';
  const hash = createHash('sha256').update(text).digest('hex');
  const model = image ? 'fixture-image' : 'fixture-text';
  const price = { provider: 'openai', model, version: 'fixture-price', rates:
    (image ? ['text_input', 'image_input', 'text_output', 'image_output'] : ['text_input', 'text_cached_input', 'text_output'])
      .map(dimension => ({ dimension, microUsdPerMillionTokens: '1000000' })) };
  const policy = { approved: true, version: 'fixture-policy', microUsdPerCredit: image ? '10' : '1',
    markupBasisPoints: 10000, platformMicroUsd: '0', minimumCredits: '1' };
  const maximum = image ? { text_input: 100, image_input: 100, text_output: 10, image_output: 100 }
    : { text_input: 100, text_cached_input: 100, text_output: 1000 };
  const now = Date.parse(JSON.parse(await sql('select to_json(clock_timestamp());')));
  const createdAt = new Date(now - 1000).toISOString(), expiresAt = new Date(now + 15 * 60_000).toISOString();
  const catalog = { approved: true, version: 'fixture-catalog', effectiveAt: createdAt, expiresAt,
    entries: [{ id: 'fixture-option', price, policy, maxOutputTokens: 1000,
      ...(image ? { size: '1024x1024', quality: 'low', maxPromptBytes: 1000, maxReferenceImages: 0, maximumTokens: maximum } : {}) }] };
  await sql(`${service} insert into auth.users(id,email) values('${user}','paid-${user}@local.test');
    insert into public.organizations(id,name,slug,owner_user_id) values('${org}','Native paid quotes','${org}','${user}');
    insert into public.credit_ledger(user_id,source,amount,balance_after) values('${user}','purchase',${reserve},0);`);
  for (const offer of offers) {
    const { workspace, book, chapter, version, job } = offer;
    await sql(`${service}
      insert into public.workspaces(id,organization_id,name,slug,created_by) values('${workspace}','${org}','Quote','${workspace}','${user}');
      insert into public.workspace_members(workspace_id,user_id,role) values('${workspace}','${user}','editor');
      insert into public.books(id,workspace_id,title,author_name,language,created_by) values('${book}','${workspace}','Quote','Author','en','${user}');
      insert into public.chapters(id,book_id,order_index,title) values('${chapter}','${book}',0,'Chapter');
      insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
        values('${version}','${chapter}',1,${json({ nodes: [{ id: 'n1', type: 'paragraph', text }] })},'${text}',3,'${user}');
      update public.chapters set current_document_version_id='${version}' where id='${chapter}';`);
    const quote = { scope: { jobId: job, workspaceId: workspace, userId: user, inputSha256: 'a'.repeat(64) }, price, policy,
      maximumTokens: Object.entries(maximum).map(([dimension, tokens]) => ({ dimension, tokens: String(tokens) })),
      maximumProviderMicroUsd: image ? '310' : '1200', reservedCredits: String(reserve), fingerprint: 'b'.repeat(64), createdAt, expiresAt };
    const sources = [{ chapterId: chapter, documentVersionId: version, version: 1 }];
    const body = image ? { jobId: job, workspaceId: workspace, userId: user, bookId: null, model,
      kind: 'cover', prompt: 'Synthetic native fixture', size: '1024x1024', quality: 'low', references: [] }
      : { jobId: job, workspaceId: workspace, bookId: book, model, agentType: kind === 'ai_review' ? 'writer' : kind === 'book_bible' ? 'bookbible' : 'metadata',
        maxOutputTokens: 1000, contextPolicy: { maxTokens: 4096, includeBookBible: false, includeStyleGuide: false, includeRelatedContext: false, semanticTopK: 5 },
        input: { chapterIds: [chapter], userInstruction: 'Review only.', chapters: { [chapter]: {
          id: chapter, title: 'Chapter', order: 0, documentVersionId: version, version: 1,
          nodes: [{ id: 'n1', text, textHash: hash, truncated: false, excerptStart: 0, excerptEnd: text.length, fullTextLength: text.length }],
        } } } };
    if (image) {
      const saved = JSON.parse(await sql(`${service} select to_jsonb(r) from public.save_image_quote_snapshot('${user}','${workspace}',null,'${job}',
        '${job}','${'a'.repeat(64)}',${json(body)},'fixture-catalog','fixture-option',${json(quote)}) r;`));
      offer.quote = saved.id;
    } else {
      const sourceArg = kind === 'metadata' ? '' : `,${json(kind === 'book_bible' ? { versions: sources, reading: { fingerprint: 'f'.repeat(64), pageIndex: 0 } } : sources)}`;
      const saved = JSON.parse(await sql(`${service} select to_jsonb(r) from public.request_${kind}_token_quote('${user}','${book}','${workspace}','${job}',
        ${json(body)},${json(catalog)}${sourceArg},'${job}',true) r;`));
      // JSON-returning request functions appear as a scalar field in to_jsonb(r).
      const request = kind === 'metadata' ? saved : (saved.request ?? Object.values(saved)[0].request);
      offer.quote = request.id;
      await sql(`${service} select public.complete_${kind}_token_quote_count('${request.id}','${user}','${request.lease_token}',
        '${'a'.repeat(64)}'${kind === 'metadata' ? '' : ',100'},${json(quote)});`);
    }
    offer.accept = `${service} select (public.accept_${image ? 'image_quote' : `${kind}_token_quote`}('${offer.quote}','${user}',${reserve}${image ? `,${json(catalog)}` : ''})).id;`;
  }
  return { kind, user, offers, reserve, model };
}

async function financialState(sql, fixture, accepted, settled = false) {
  const actual = JSON.parse(await sql(`select json_build_object(
    'jobs',(select count(*) from public.ai_jobs where created_by='${fixture.user}'),
    'holds',(select count(*) from public.funded_usage_quotes where user_id='${fixture.user}'),
    'balance',(select sum(amount) from public.credit_ledger where user_id='${fixture.user}'),
    'reservations',(select count(*) from public.credit_ledger where user_id='${fixture.user}' and source='generation_reservation'),
    'releases',(select count(*) from public.credit_ledger where user_id='${fixture.user}' and source='generation_release'),
    'usage',(select count(*) from public.usage_events where user_id='${fixture.user}'));`));
  assert.deepEqual(actual, { jobs: Number(accepted), holds: Number(accepted),
    balance: settled ? fixture.reserve - 1 : accepted ? 0 : fixture.reserve,
    reservations: Number(accepted), releases: Number(settled), usage: 0 });
}

const dispatchCall = (fixture, job, lease) => `${service} select public.claim_funded_dispatch('${job}','${lease}','${'a'.repeat(64)}','${fixture.model}');`;
const settlementCall = (fixture, job) => `${service} select (public.settle_funded_usage_quote('${job}',${json({
  status: 'settle', fingerprint: 'b'.repeat(64), requestId: `fixture-${job}`, debitCredits: '1',
  releaseCredits: String(fixture.reserve - 1), priceVersion: 'fixture-price', policyVersion: 'fixture-policy',
})})).status;`;

const imageReceiptCall = (f, lease = f.lease) => `${service} select (public.save_quoted_image_receipt(
  '${f.job}','${lease}','${'a'.repeat(64)}',${json(f.receipt)})).job_id;`;
const imageCompletionCall = (f, lease = f.lease, settlement = f.settlement) => `${service} select (public.complete_quoted_image_job(
  '${f.job}','${lease}',${json(settlement)})).id;`;

async function paidImageCompletionFixture(sql) {
  const f = await paidQuoteFixture(sql, 'image'), offer = f.offers[0];
  f.job = offer.job; f.workspace = offer.workspace; f.asset = randomUUID();
  assert.equal(await sql(offer.accept), f.job);
  const claimed = JSON.parse(await sql(`${service} select to_jsonb(j) from public.claim_quoted_image_job(600) j;`));
  assert.equal(claimed.id, f.job, 'Fixture must claim its own queued image job');
  assert.equal(claimed.status, 'running'); assert.equal(claimed.attempts, 1);
  f.lease = claimed.lease_token; assert.ok(f.lease);
  assert.equal(await sql(dispatchCall(f, f.job, f.lease)), 't');
  assert.equal(await sql(dispatchCall(f, f.job, f.lease)), 'f');
  f.receipt = { assetId: f.asset, name: 'Synthetic native image', provider: 'openai', model: f.model,
    requestId: `fixture-image-${f.job}`, mimeType: 'image/png', checksum: 'd'.repeat(64), sizeBytes: 8,
    storagePath: `workspaces/${f.workspace}/assets/${f.asset}/v1/generated.png`, usage: {
      inputTokens: 30, outputTokens: 20, latencyMs: 1, reconciliationStatus: 'supported', providerTokenUsage: {
        input_tokens: 30, output_tokens: 20, total_tokens: 50,
        input_tokens_details: { text_tokens: 10, image_tokens: 20 },
        output_tokens_details: { text_tokens: 0, image_tokens: 20 },
      },
    } };
  f.settlement = { status: 'settle', fingerprint: 'b'.repeat(64), requestId: f.receipt.requestId,
    tokens: [{ dimension: 'text_input', tokens: '10' }, { dimension: 'image_input', tokens: '20' },
      { dimension: 'text_output', tokens: '0' }, { dimension: 'image_output', tokens: '20' }],
    providerMicroUsd: '50', debitCredits: '5', releaseCredits: '26',
    priceVersion: 'fixture-price', policyVersion: 'fixture-policy' };
  return f;
}

async function imageCompletionState(sql, f, { completed = false, receipt = true, attempts = 1, lease = f.lease } = {}) {
  const state = JSON.parse(await sql(`select json_build_object(
    'job',(select json_build_object('status',status,'lease',lease_token,'attempts',attempts,
      'output',output_ref,'usage',usage_json,'completedAt',completed_at) from public.ai_jobs where id='${f.job}'),
    'quote',(select json_build_object('status',status,'dispatchedAt',dispatched_at,'settlement',settlement_json,
      'settledAt',settled_at) from public.funded_usage_quotes where job_id='${f.job}'),
    'receipt',(select json_build_object('sha256',request_sha256,'value',receipt_json,'createdAt',created_at)
      from public.quoted_image_receipts where job_id='${f.job}'),
    'jobs',(select count(*) from public.ai_jobs where created_by='${f.user}'),
    'holds',(select count(*) from public.funded_usage_quotes where user_id='${f.user}'),
    'balance',(select sum(amount) from public.credit_ledger where user_id='${f.user}'),
    'reservations',(select count(*) from public.credit_ledger where user_id='${f.user}' and source='generation_reservation'),
    'releases',(select count(*) from public.credit_ledger where user_id='${f.user}' and source='generation_release'),
    'released',(select coalesce(sum(amount),0) from public.credit_ledger where user_id='${f.user}' and source='generation_release'),
    'assets',(select count(*) from public.assets where workspace_id='${f.workspace}'),
    'versions',(select count(*) from public.asset_versions v join public.assets a on a.id=v.asset_id where a.workspace_id='${f.workspace}'),
    'links',(select count(*) from public.asset_links where asset_id='${f.asset}'),
    'runs',(select count(*) from public.ai_runs where ai_job_id='${f.job}'),
    'usage',(select count(*) from public.usage_events where user_id='${f.user}'),
    'charged',(select coalesce(sum(quantity),0) from public.usage_events where user_id='${f.user}' and meter='token_credits'),
    'activity',(select count(*) from public.activity_events where workspace_id='${f.workspace}'),
    'assetMatches',exists(select 1 from public.assets where id='${f.asset}' and type='cover' and status='draft'
      and storage_path='${f.receipt.storagePath}' and checksum='${f.receipt.checksum}' and mime_type='image/png' and size_bytes=8),
    'versionMatches',exists(select 1 from public.asset_versions where asset_id='${f.asset}' and version_number=1
      and storage_path='${f.receipt.storagePath}' and checksum='${f.receipt.checksum}' and mime_type='image/png' and size_bytes=8),
    'runMatches',exists(select 1 from public.ai_runs where ai_job_id='${f.job}' and status='succeeded'
      and provider='openai' and model='${f.model}' and tokens_in=30 and tokens_out=20 and estimated_cost=0.00005 and latency_ms=1),
    'activityMatches',exists(select 1 from public.activity_events where workspace_id='${f.workspace}'
      and event_type='asset_generated' and entity_type='asset' and entity_id='${f.asset}'
      and payload_json->>'aiJobId'='${f.job}'));`));
  assert.deepEqual({ ...state, job: undefined, quote: undefined, receipt: undefined }, {
    job: undefined, quote: undefined, receipt: undefined, jobs: 1, holds: 1,
    balance: completed ? 26 : 0, reservations: 1, releases: Number(completed), released: completed ? 26 : 0,
    assets: Number(completed), versions: Number(completed), links: 0, runs: Number(completed),
    usage: Number(completed), charged: completed ? 5 : 0, activity: Number(completed),
    assetMatches: completed, versionMatches: completed, runMatches: completed, activityMatches: completed,
  });
  assert.equal(state.job.status, completed ? 'succeeded' : 'running');
  assert.equal(state.job.lease, completed ? null : lease); assert.equal(state.job.attempts, attempts);
  assert.equal(state.quote.status, completed ? 'settled' : 'held'); assert.ok(state.quote.dispatchedAt);
  if (completed) {
    assert.deepEqual(state.job.output, { assetId: f.asset, provider: 'openai' });
    assert.deepEqual(state.job.usage, f.receipt.usage); assert.ok(state.job.completedAt); assert.ok(state.quote.settledAt);
    assert.deepEqual(state.quote.settlement, f.settlement);
  } else {
    assert.equal(state.job.output, null); assert.equal(state.job.completedAt, null);
    assert.equal(state.quote.settlement, null); assert.equal(state.quote.settledAt, null);
  }
  if (receipt) {
    assert.equal(state.receipt.sha256, 'a'.repeat(64)); assert.deepEqual(state.receipt.value, f.receipt);
    assert.ok(state.receipt.createdAt);
  } else assert.equal(state.receipt, null);
  return state;
}

// Advance only the fixture's running lease, then use the real recovery RPC.
// If completion commits first there is no running job and no reclaim is attempted.
const completionReclaimCall = (f) => `${service} do $$ declare recovered public.ai_jobs; begin
  update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id='${f.job}' and status='running';
  if found then
    select * into strict recovered from public.claim_quoted_${f.kind}_job(600);
    assert recovered.id='${f.job}'::uuid, 'Recovery claimed an unrelated fixture';
  end if;
end $$; select json_build_object('status',status,'lease',lease_token,'attempts',attempts) from public.ai_jobs where id='${f.job}';`;

async function replayImageCompletion(sql, f, options = {}) {
  const before = await imageCompletionState(sql, f, { ...options, completed: true });
  assert.equal(await sql(imageCompletionCall(f)), f.job);
  assert.deepEqual(await imageCompletionState(sql, f, { ...options, completed: true }), before,
    'Exact image completion replay must not rewrite receipt, result, or settlement');
  const conflicting = { ...f.settlement, requestId: `changed-${f.job}` };
  await sql(`${service} do $$ begin
    begin
      perform public.complete_quoted_image_job('${f.job}','${f.lease}',${json(conflicting)});
      raise exception 'Conflicting image replay unexpectedly succeeded';
    exception when unique_violation then
      assert sqlerrm='image completion replay conflict', 'Wrong image replay rejection'; end;
  end $$;`);
  assert.deepEqual(await imageCompletionState(sql, f, { ...options, completed: true }), before,
    'Rejected image completion replay must leave every durable result unchanged');
}

async function verifyPaidImageCompletionFixture(sql) {
  await sql('begin;');
  try {
    const f = await paidImageCompletionFixture(sql);
    await imageCompletionState(sql, f, { receipt: false });
    await sql(`${service} do $$ begin
      begin
        perform public.complete_quoted_image_job('${f.job}','${f.lease}',${json(f.settlement)});
        raise exception 'Missing receipt image completion unexpectedly succeeded';
      exception when check_violation then
        assert sqlerrm='image completion receipt mismatch', 'Wrong missing-receipt rejection'; end;
    end $$;`);
    await imageCompletionState(sql, f, { receipt: false });
    await sql('savepoint receipt_write;');
    assert.equal(await sql(imageReceiptCall(f)), f.job);
    await sql('rollback to savepoint receipt_write; release savepoint receipt_write;');
    await imageCompletionState(sql, f, { receipt: false });
    assert.equal(await sql(imageReceiptCall(f)), f.job);
    const saved = await imageCompletionState(sql, f);
    assert.equal(await sql(imageReceiptCall(f)), f.job);
    assert.deepEqual(await imageCompletionState(sql, f), saved);
    await sql('savepoint image_completion;');
    assert.equal(await sql(imageCompletionCall(f)), f.job);
    await imageCompletionState(sql, f, { completed: true });
    await sql('rollback to savepoint image_completion; release savepoint image_completion;');
    assert.deepEqual(await imageCompletionState(sql, f), saved, 'Completion rollback must preserve only the durable receipt');
    const reclaimed = JSON.parse(await sql(completionReclaimCall(f)));
    assert.notEqual(reclaimed.lease, f.lease); assert.equal(reclaimed.attempts, 2);
    await imageCompletionState(sql, f, { attempts: 2, lease: reclaimed.lease });
    await sql(`${service} do $$ begin
      begin
        perform public.complete_quoted_image_job('${f.job}','${f.lease}',${json(f.settlement)});
        raise exception 'Stale image completion unexpectedly succeeded';
      exception when serialization_failure then
        assert sqlerrm='image completion lease lost', 'Wrong stale image lease rejection'; end;
    end $$;`);
    assert.equal(await sql(dispatchCall(f, f.job, reclaimed.lease)), 'f');
    assert.equal(await sql(imageCompletionCall(f, reclaimed.lease)), f.job);
    await replayImageCompletion(sql, f, { attempts: 2 });
    const completed = await imageCompletionState(sql, f, { completed: true, attempts: 2 });
    await sql(`${service} do $$ begin
      begin
        perform public.save_quoted_image_receipt('${f.job}','${f.lease}','${'a'.repeat(64)}',${json(f.receipt)});
        raise exception 'Completed image accepted a new receipt write';
      exception when serialization_failure then
        assert sqlerrm='image receipt lease lost', 'Wrong completed receipt-write rejection'; end;
    end $$;`);
    assert.deepEqual(JSON.parse(await sql(completionReclaimCall(f))), { status: 'succeeded', lease: null, attempts: 2 });
    assert.deepEqual(await imageCompletionState(sql, f, { completed: true, attempts: 2 }), completed);
    console.log('PASS serial paid image receipt/lease/completion fixture');
  } finally { await sql('rollback;'); }
}

const metadataCompletionCall = (f, lease = f.lease, settlement = f.settlement) => `${service} select (public.complete_quoted_metadata_job(
  '${f.job}','${lease}','openai','${f.model}',${json(f.usage)},'[]'::jsonb,${json(f.candidate)},${json(settlement)})).id;`;

async function paidMetadataCompletionFixture(sql) {
  const f = await paidQuoteFixture(sql, 'metadata'), offer = f.offers[0];
  f.job = offer.job; f.workspace = offer.workspace; f.book = offer.book;
  assert.equal(await sql(offer.accept), f.job);
  const claimed = JSON.parse(await sql(`${service} select to_jsonb(j) from public.claim_quoted_metadata_job(600) j;`));
  assert.equal(claimed.id, f.job, 'Fixture must claim its own queued metadata job');
  assert.equal(claimed.status, 'running'); assert.equal(claimed.attempts, 1);
  f.lease = claimed.lease_token; assert.ok(f.lease);
  assert.equal(await sql(dispatchCall(f, f.job, f.lease)), 't');
  assert.equal(await sql(dispatchCall(f, f.job, f.lease)), 'f');
  const sources = JSON.parse(await sql(`select input_ref->'contextSources' from public.ai_jobs where id='${f.job}';`));
  assert.equal(sources.length, 1);
  f.candidate = { suggestionKind: 'metadata_candidate', status: 'pending',
    description: 'A synthetic book invites readers to follow its quiet narrator through a remembered winter town.',
    keywords: ['winter town'], categories: ['Fiction / Mystery'], audience: 'Adults',
    rationale: 'The cited opening supplies the review-only context.', confidence: 0.9, sourceRefs: sources };
  f.usage = { inputTokens: 15, outputTokens: 20, estimatedCostUsd: 0.000035, latencyMs: 1,
    measuredTokens: [{ dimension: 'text_input', tokens: '10' }, { dimension: 'text_cached_input', tokens: '5' },
      { dimension: 'text_output', tokens: '20' }] };
  // Each rate is 1 microUSD/token; policy is 1 microUSD/credit with no uplift.
  // These independently computed amounts are checked again by the SQL contract.
  f.settlement = { status: 'settle', fingerprint: 'b'.repeat(64), requestId: `fixture-metadata-${f.job}`,
    tokens: f.usage.measuredTokens, providerMicroUsd: '35', debitCredits: '35', releaseCredits: '1165',
    priceVersion: 'fixture-price', policyVersion: 'fixture-policy' };
  f.receipt = { jobId: f.job, workspaceId: f.workspace, bookId: f.book, agentType: 'metadata', status: 'succeeded',
    provider: 'openai', model: f.model, requestId: f.settlement.requestId,
    usage: f.usage, diagnostics: [], suggestions: [f.candidate] };
  // Trusted AI-service row fixture: this hash identifies the FULL HTTP request,
  // not the separately accepted provider-input hash used by claim_funded_dispatch.
  await sql(`${service} insert into public.metadata_service_receipts(job_id,request_sha256,result_json)
    values('${f.job}','${'e'.repeat(64)}',${json(f.receipt)});`);
  return f;
}

async function metadataCompletionState(sql, f, { completed = false, attempts = 1, lease = f.lease } = {}) {
  const state = JSON.parse(await sql(`select json_build_object(
    'job',(select json_build_object('status',status,'lease',lease_token,'attempts',attempts,'output',output_ref,
      'usage',usage_json,'completedAt',completed_at) from public.ai_jobs where id='${f.job}'),
    'quote',(select json_build_object('status',status,'dispatchedAt',dispatched_at,'settlement',settlement_json,
      'settledAt',settled_at) from public.funded_usage_quotes where job_id='${f.job}'),
    'receipt',(select json_build_object('sha256',request_sha256,'value',result_json,'createdAt',created_at)
      from public.metadata_service_receipts where job_id='${f.job}'),
    'jobs',(select count(*) from public.ai_jobs where created_by='${f.user}'),
    'holds',(select count(*) from public.funded_usage_quotes where user_id='${f.user}'),
    'balance',(select sum(amount) from public.credit_ledger where user_id='${f.user}'),
    'reservations',(select count(*) from public.credit_ledger where user_id='${f.user}' and source='generation_reservation'),
    'releases',(select count(*) from public.credit_ledger where user_id='${f.user}' and source='generation_release'),
    'released',(select coalesce(sum(amount),0) from public.credit_ledger where user_id='${f.user}' and source='generation_release'),
    'runs',(select count(*) from public.ai_runs where ai_job_id='${f.job}'),
    'usage',(select count(*) from public.usage_events where user_id='${f.user}'),
    'operationalCharge',(select coalesce(sum(quantity),0) from public.usage_events where user_id='${f.user}'),
    'savedMetadata',(select count(*) from public.book_metadata where book_id='${f.book}'),
    'runMatches',exists(select 1 from public.ai_runs where ai_job_id='${f.job}' and status='succeeded'
      and provider='openai' and model='${f.model}' and tokens_in=15 and tokens_out=20 and estimated_cost=0.000035 and latency_ms=1));`));
  assert.deepEqual({ ...state, job: undefined, quote: undefined, receipt: undefined }, {
    job: undefined, quote: undefined, receipt: undefined, jobs: 1, holds: 1, balance: completed ? 1165 : 0,
    reservations: 1, releases: Number(completed), released: completed ? 1165 : 0, runs: Number(completed),
    usage: Number(completed), operationalCharge: 0, savedMetadata: 0, runMatches: completed,
  });
  assert.equal(state.job.status, completed ? 'succeeded' : 'running');
  assert.equal(state.job.lease, completed ? null : lease); assert.equal(state.job.attempts, attempts);
  assert.equal(state.quote.status, completed ? 'settled' : 'held'); assert.ok(state.quote.dispatchedAt);
  assert.equal(state.receipt.sha256, 'e'.repeat(64)); assert.deepEqual(state.receipt.value, f.receipt); assert.ok(state.receipt.createdAt);
  if (completed) {
    assert.deepEqual(state.job.output, { candidate: f.candidate, diagnostics: [], reviewRequired: true, savedMetadataUpdated: false });
    assert.deepEqual(state.job.usage, f.usage); assert.ok(state.job.completedAt); assert.ok(state.quote.settledAt);
    assert.deepEqual(state.quote.settlement, f.settlement);
  } else {
    assert.equal(state.job.output, null); assert.equal(state.job.completedAt, null);
    assert.equal(state.quote.settlement, null); assert.equal(state.quote.settledAt, null);
  }
  return state;
}

async function replayMetadataCompletion(sql, f, options = {}) {
  const before = await metadataCompletionState(sql, f, { ...options, completed: true });
  assert.equal(await sql(metadataCompletionCall(f)), f.job);
  assert.deepEqual(await metadataCompletionState(sql, f, { ...options, completed: true }), before);
  const conflicting = { ...f.settlement, debitCredits: '36', releaseCredits: '1164' };
  await sql(`${service} do $$ begin
    begin
      perform public.complete_quoted_metadata_job('${f.job}','${f.lease}','openai','${f.model}',
        ${json(f.usage)},'[]'::jsonb,${json(f.candidate)},${json(conflicting)});
      raise exception 'Conflicting metadata replay unexpectedly succeeded';
    exception when unique_violation then
      assert sqlerrm='metadata completion replay conflict', 'Wrong metadata replay rejection'; end;
  end $$;`);
  assert.deepEqual(await metadataCompletionState(sql, f, { ...options, completed: true }), before);
}

async function verifyPaidMetadataCompletionFixture(sql) {
  await sql('begin;');
  try {
    const f = await paidMetadataCompletionFixture(sql);
    const saved = await metadataCompletionState(sql, f);
    await sql('savepoint metadata_completion;');
    assert.equal(await sql(metadataCompletionCall(f)), f.job);
    await metadataCompletionState(sql, f, { completed: true });
    await sql('rollback to savepoint metadata_completion; release savepoint metadata_completion;');
    assert.deepEqual(await metadataCompletionState(sql, f), saved, 'Metadata completion rollback must preserve only its durable receipt');
    const reclaimed = JSON.parse(await sql(completionReclaimCall(f)));
    assert.notEqual(reclaimed.lease, f.lease); assert.equal(reclaimed.attempts, 2);
    await metadataCompletionState(sql, f, { attempts: 2, lease: reclaimed.lease });
    await sql(`${service} do $$ begin
      begin
        perform public.complete_quoted_metadata_job('${f.job}','${f.lease}','openai','${f.model}',
          ${json(f.usage)},'[]'::jsonb,${json(f.candidate)},${json(f.settlement)});
        raise exception 'Stale metadata completion unexpectedly succeeded';
      exception when serialization_failure then
        assert sqlerrm='metadata quote lease lost', 'Wrong stale metadata lease rejection'; end;
    end $$;`);
    assert.equal(await sql(dispatchCall(f, f.job, reclaimed.lease)), 'f');
    assert.equal(await sql(metadataCompletionCall(f, reclaimed.lease)), f.job);
    await replayMetadataCompletion(sql, f, { attempts: 2 });
    const completed = await metadataCompletionState(sql, f, { completed: true, attempts: 2 });
    assert.deepEqual(JSON.parse(await sql(completionReclaimCall(f))), { status: 'succeeded', lease: null, attempts: 2 });
    assert.deepEqual(await metadataCompletionState(sql, f, { completed: true, attempts: 2 }), completed);
    console.log('PASS serial paid metadata receipt/lease/completion fixture');
  } finally { await sql('rollback;'); }
}

const textReceiptTable = (f) => f.kind === 'ai_review' ? 'ai_review_service_receipts' : 'book_bible_service_receipts';
// Match the existing Python result-store PATCH, including its write-once NULL
// predicate. The trusted full-wire request hash is not the provider-input hash.
const textReceiptCall = (f) => `${service} update public.${textReceiptTable(f)} set result_json=${json(f.receipt)}
  where job_id='${f.job}' and request_sha256='${'e'.repeat(64)}' and result_json is null returning job_id;`;
const textCompletionCall = (f, lease = f.lease, settlement = f.settlement, candidates = f.candidates) => `${service}
  select (public.complete_quoted_${f.kind}_job('${f.job}','${lease}','openai','${f.model}'
    ${f.kind === 'book_bible' ? `,'${f.settlement.requestId}'` : ''},${json(f.usage)},${json(f.diagnostics)},
    ${json(candidates)},${json(settlement)})).id;`;
const sortedTokens = (tokens) => [...tokens].sort((a, b) => a.dimension.localeCompare(b.dimension));

async function paidTextCompletionFixture(sql, kind) {
  assert.ok(['ai_review', 'book_bible'].includes(kind));
  const f = await paidQuoteFixture(sql, kind), offer = f.offers[0];
  Object.assign(f, { job: offer.job, workspace: offer.workspace, book: offer.book, chapter: offer.chapter,
    version: offer.version, suggestion: randomUUID() });
  assert.equal(await sql(offer.accept), f.job);
  const claimed = JSON.parse(await sql(`${service} select to_jsonb(j) from public.claim_quoted_${kind}_job(600) j;`));
  assert.equal(claimed.id, f.job, `Fixture must claim its own queued ${kind} job`);
  assert.equal(claimed.status, 'running'); assert.equal(claimed.attempts, 1);
  f.lease = claimed.lease_token; assert.ok(f.lease);
  assert.equal(await sql(dispatchCall(f, f.job, f.lease)), 't');
  assert.equal(await sql(dispatchCall(f, f.job, f.lease)), 'f');
  f.diagnostics = [{ severity: 'info', code: 'synthetic_native_result', message: 'Review before applying.', location: {} }];
  f.usage = { inputTokens: 15, outputTokens: 20, estimatedCostUsd: 0.000035, latencyMs: 1,
    measuredTokens: [{ dimension: 'text_input', tokens: '10' }, { dimension: 'text_cached_input', tokens: '5' },
      { dimension: 'text_output', tokens: '20' }] };
  // Independently computed: 10 + 5 + 20 = 35 microUSD at 1 microUSD/token;
  // 1 microUSD/credit, no markup/platform charge, leaves 1200 - 35 = 1165.
  f.settlement = { status: 'settle', fingerprint: 'b'.repeat(64), requestId: `fixture-${kind}-${f.job}`,
    tokens: f.usage.measuredTokens, providerMicroUsd: '35', debitCredits: '35', releaseCredits: '1165',
    priceVersion: 'fixture-price', policyVersion: 'fixture-policy' };
  let rawCandidates;
  if (kind === 'ai_review') {
    const operation = { operationId: `fixture-proposal-${f.job}`, source: 'ai', sourceRef: null, expectedVersion: 1,
      type: 'replace_text', target: { chapterId: f.chapter, nodeId: 'n1' },
      payload: { nodeId: 'n1', from: 0, to: 18, text: 'A synthetic paid review.' } };
    rawCandidates = [{ chapterId: f.chapter, nodeId: 'n1', operation, rationale: 'A clearer synthetic opening.', confidence: 0.9 }];
    f.candidates = [{ id: f.suggestion, entityType: 'chapter', entityId: f.chapter, rationale: rawCandidates[0].rationale,
      confidence: 0.9, operation: { ...operation, operationId: `ai:${f.suggestion}`, source: 'ai', sourceRef: f.suggestion, expectedVersion: 1 } }];
  } else {
    const sources = JSON.parse(await sql(`select input_ref->'contextSources' from public.ai_jobs where id='${f.job}';`));
    assert.equal(sources.length, 1);
    rawCandidates = [{ suggestionKind: 'book_bible_candidate', status: 'pending', type: 'character', name: 'Synthetic narrator',
      description: 'A review-only synthetic narrator.', attributes: { role: 'narrator' }, sourceRefs: sources, confidence: 0.9 }];
    f.candidates = rawCandidates;
  }
  f.receipt = { jobId: f.job, workspaceId: f.workspace, bookId: f.book, agentType: kind === 'ai_review' ? 'writer' : 'bookbible',
    status: 'succeeded', provider: 'openai', model: f.model, requestId: f.settlement.requestId,
    usage: f.usage, diagnostics: f.diagnostics, suggestions: rawCandidates };
  await sql(`${service} insert into public.${textReceiptTable(f)}(job_id,request_sha256)
    values('${f.job}','${'e'.repeat(64)}');`);
  f.source = JSON.parse(await sql(`select json_build_object('versionId',current_document_version_id,'version',d.version_number,
    'content',d.content_json,'plainText',d.plain_text) from public.chapters c join public.document_versions d
    on d.id=c.current_document_version_id where c.id='${f.chapter}';`));
  return f;
}

async function textCompletionState(sql, f, { completed = false, receipt = true, attempts = 1, lease = f.lease } = {}) {
  const review = f.kind === 'ai_review';
  const state = JSON.parse(await sql(`select json_build_object(
    'job',(select json_build_object('status',status,'lease',lease_token,'attempts',attempts,'output',output_ref,
      'usage',usage_json,'completedAt',completed_at) from public.ai_jobs where id='${f.job}'),
    'quote',(select json_build_object('status',status,'dispatchedAt',dispatched_at,'settlement',settlement_json,
      'settledAt',settled_at) from public.funded_usage_quotes where job_id='${f.job}'),
    'receipt',(select json_build_object('sha256',request_sha256,'value',result_json,'createdAt',created_at)
      from public.${textReceiptTable(f)} where job_id='${f.job}'),
    'completionReceipt',${review ? 'null' : `(select json_build_object('sha256',request_sha256,'requestId',request_id,'provider',provider,
      'model',model,'value',result_json,'createdAt',created_at) from public.book_bible_quote_service_receipts where job_id='${f.job}')`},
    'source',(select json_build_object('versionId',current_document_version_id,'version',d.version_number,'content',d.content_json,
      'plainText',d.plain_text) from public.chapters c join public.document_versions d on d.id=c.current_document_version_id where c.id='${f.chapter}'),
    'jobs',(select count(*) from public.ai_jobs where created_by='${f.user}'),
    'holds',(select count(*) from public.funded_usage_quotes where user_id='${f.user}'),
    'balance',(select sum(amount) from public.credit_ledger where user_id='${f.user}'),
    'reservations',(select count(*) from public.credit_ledger where user_id='${f.user}' and source='generation_reservation'),
    'reserved',(select coalesce(sum(amount),0) from public.credit_ledger where user_id='${f.user}' and source='generation_reservation'),
    'releases',(select count(*) from public.credit_ledger where user_id='${f.user}' and source='generation_release'),
    'released',(select coalesce(sum(amount),0) from public.credit_ledger where user_id='${f.user}' and source='generation_release'),
    'legacyDebits',(select count(*) from public.credit_ledger where user_id='${f.user}' and source='consumption'),
    'runs',(select count(*) from public.ai_runs where ai_job_id='${f.job}'),
    'usage',(select count(*) from public.usage_events where user_id='${f.user}'),
    'usageMatches',(select count(*) from public.usage_events where ai_job_id='${f.job}' and user_id='${f.user}'
      and workspace_id='${f.workspace}' and meter='ai_credits' and quantity=0),
    'operationalCharge',(select coalesce(sum(quantity),0) from public.usage_events where user_id='${f.user}'),
    'savedBible',(select count(*) from public.book_bible_items where book_id='${f.book}'),
    'suggestions',(select count(*) from public.ai_suggestions where ai_job_id='${f.job}'),
    'suggestion',(select json_build_object('id',id,'entityType',entity_type,'entityId',entity_id,'operation',operation_json,
      'rationale',rationale,'confidence',confidence,'status',status,'reviewedAt',reviewed_at,'reviewedBy',reviewed_by)
      from public.ai_suggestions where id='${f.suggestion}'),
    'runMatches',exists(select 1 from public.ai_runs where ai_job_id='${f.job}' and workspace_id='${f.workspace}' and status='succeeded'
      and provider='openai' and model='${f.model}' and tokens_in=15 and tokens_out=20 and estimated_cost=0.000035 and latency_ms=1));`));
  assert.deepEqual({ ...state, job: undefined, quote: undefined, receipt: undefined, completionReceipt: undefined, source: undefined, suggestion: undefined }, {
    job: undefined, quote: undefined, receipt: undefined, completionReceipt: undefined, source: undefined, suggestion: undefined,
    jobs: 1, holds: 1, balance: completed ? 1165 : 0, reservations: 1, reserved: -1200,
    releases: Number(completed), released: completed ? 1165 : 0, legacyDebits: 0, runs: Number(completed),
    usage: Number(completed), usageMatches: Number(completed), operationalCharge: 0, savedBible: 0,
    suggestions: Number(completed && review), runMatches: completed,
  });
  assert.deepEqual(state.source, f.source, 'Review completion must not change the canonical manuscript');
  assert.equal(state.job.status, completed ? 'succeeded' : 'running');
  assert.equal(state.job.lease, completed ? null : lease); assert.equal(state.job.attempts, attempts);
  assert.equal(state.quote.status, completed ? 'settled' : 'held'); assert.ok(state.quote.dispatchedAt);
  assert.equal(state.receipt.sha256, 'e'.repeat(64)); assert.deepEqual(state.receipt.value, receipt ? f.receipt : null); assert.ok(state.receipt.createdAt);
  if (completed) {
    assert.deepEqual(state.job.output, review ? { diagnostics: f.diagnostics, suggestionCount: 1 }
      : { candidates: f.candidates, diagnostics: f.diagnostics, reviewRequired: true, savedBibleUpdated: false });
    assert.deepEqual(state.job.usage, review ? { ...f.usage, measuredTokens: sortedTokens(f.usage.measuredTokens) } : f.usage);
    assert.deepEqual(state.quote.settlement, review ? { ...f.settlement, tokens: sortedTokens(f.settlement.tokens) } : f.settlement);
    assert.ok(state.job.completedAt); assert.ok(state.quote.settledAt);
    if (review) assert.deepEqual(state.suggestion, { ...f.candidates[0], status: 'pending', reviewedAt: null, reviewedBy: null });
    else {
      assert.equal(state.completionReceipt.sha256, 'a'.repeat(64)); assert.equal(state.completionReceipt.requestId, f.settlement.requestId);
      assert.equal(state.completionReceipt.provider, 'openai'); assert.equal(state.completionReceipt.model, f.model); assert.ok(state.completionReceipt.createdAt);
      assert.deepEqual(state.completionReceipt.value, { requestId: f.settlement.requestId, provider: 'openai', model: f.model,
        usage: f.usage, diagnostics: f.diagnostics, candidates: f.candidates, settlement: f.settlement });
    }
  } else {
    assert.equal(state.job.output, null); assert.equal(state.job.completedAt, null); assert.equal(state.quote.settlement, null);
    assert.equal(state.quote.settledAt, null); assert.equal(state.suggestion, null); assert.equal(state.completionReceipt, null);
  }
  return state;
}

async function replayTextCompletion(sql, f, options = {}) {
  const before = await textCompletionState(sql, f, { ...options, completed: true });
  assert.equal(await sql(textCompletionCall(f)), f.job);
  assert.deepEqual(await textCompletionState(sql, f, { ...options, completed: true }), before,
    'Exact completion replay must not rewrite receipt, candidate, usage, source, or settlement');
  const changed = structuredClone(f.candidates);
  if (f.kind === 'ai_review') changed[0].operation.payload.text = 'A changed review cannot replace the saved receipt.';
  else changed[0].name = 'Changed narrator';
  await sql(`${service} do $$ begin
    begin ${textCompletionCall(f, f.lease, f.settlement, changed).replace(service, '').replace('select (', 'perform (')}
      raise exception 'Conflicting ${f.kind} replay unexpectedly succeeded';
    exception when check_violation or unique_violation then null; end;
  end $$;`);
  assert.deepEqual(await textCompletionState(sql, f, { ...options, completed: true }), before,
    'Conflicting completion replay must leave every durable result unchanged');
}

async function verifyPaidTextCompletionFixture(sql, kind) {
  await sql('begin;');
  try {
    const f = await paidTextCompletionFixture(sql, kind);
    await textCompletionState(sql, f, { receipt: false });
    await sql(`${service} do $$ begin
      begin ${textCompletionCall(f).replace(service, '').replace('select (', 'perform (')}
        raise exception 'Missing receipt ${kind} completion unexpectedly succeeded';
      exception when check_violation then null; end;
    end $$;`);
    await textCompletionState(sql, f, { receipt: false });
    await sql('savepoint text_receipt;'); assert.equal(await sql(textReceiptCall(f)), f.job);
    await sql('rollback to savepoint text_receipt; release savepoint text_receipt;');
    await textCompletionState(sql, f, { receipt: false });
    assert.equal(await sql(textReceiptCall(f)), f.job); assert.equal(await sql(textReceiptCall(f)), '');
    const saved = await textCompletionState(sql, f);
    await sql(`${service} do $$ begin
      begin
        update public.${textReceiptTable(f)} set result_json=jsonb_set(result_json,'{requestId}','"changed-receipt"') where job_id='${f.job}';
        raise exception 'Saved ${kind} raw receipt was overwritten';
      exception when check_violation then null; end;
      begin
        update public.${textReceiptTable(f)} set request_sha256='${'f'.repeat(64)}' where job_id='${f.job}';
        raise exception 'Saved ${kind} receipt request identity was overwritten';
      exception when check_violation then null; end;
    end $$;`);
    assert.deepEqual(await textCompletionState(sql, f), saved);
    const wrongMath = { ...f.settlement, debitCredits: '34', releaseCredits: '1166' };
    await sql(`${service} do $$ begin
      begin ${textCompletionCall(f, f.lease, wrongMath).replace(service, '').replace('select (', 'perform (')}
        raise exception 'Wrong balanced ${kind} settlement unexpectedly succeeded';
      exception when check_violation then null; end;
    end $$;`);
    assert.deepEqual(await textCompletionState(sql, f), saved);
    await sql('savepoint text_completion;'); assert.equal(await sql(textCompletionCall(f)), f.job);
    await textCompletionState(sql, f, { completed: true });
    await sql('rollback to savepoint text_completion; release savepoint text_completion;');
    assert.deepEqual(await textCompletionState(sql, f), saved, 'Completion rollback must preserve only its durable raw receipt');
    const reclaimed = JSON.parse(await sql(completionReclaimCall(f)));
    assert.notEqual(reclaimed.lease, f.lease); assert.equal(reclaimed.attempts, 2);
    await textCompletionState(sql, f, { attempts: 2, lease: reclaimed.lease });
    await sql(`${service} do $$ begin
      begin ${textCompletionCall(f).replace(service, '').replace('select (', 'perform (')}
        raise exception 'Stale ${kind} completion unexpectedly succeeded';
      exception when serialization_failure then
        assert sqlerrm='${kind === 'ai_review' ? 'AI review' : 'Book Bible'} quote lease lost', 'Wrong stale text lease rejection'; end;
    end $$;`);
    assert.equal(await sql(dispatchCall(f, f.job, reclaimed.lease)), 'f', 'Receipt recovery must not redispatch');
    assert.equal(await sql(textCompletionCall(f, reclaimed.lease)), f.job);
    await replayTextCompletion(sql, f, { attempts: 2 });
    const completed = await textCompletionState(sql, f, { completed: true, attempts: 2 });
    assert.deepEqual(JSON.parse(await sql(completionReclaimCall(f))), { status: 'succeeded', lease: null, attempts: 2 });
    assert.deepEqual(await textCompletionState(sql, f, { completed: true, attempts: 2 }), completed);
    console.log(`PASS serial paid ${kind} receipt/lease/completion fixture`);
  } finally { await sql('rollback;'); }
}

/** Serial fixture gate, not evidence of native multi-connection behavior. */
export async function verifyPaidQuoteFixtures(sql) {
  for (const kind of kinds) {
    await sql('begin;');
    try {
      const fixture = await paidQuoteFixture(sql, kind);
      await financialState(sql, fixture, false);
      assert.equal(await sql(fixture.offers[0].accept), fixture.offers[0].job);
      assert.equal(await sql(fixture.offers[0].accept), fixture.offers[0].job);
      await financialState(sql, fixture, true);
      const job = fixture.offers[0].job, lease = randomUUID();
      await sql(`${service} update public.ai_jobs set status='running',lease_token='${lease}',lease_expires_at=clock_timestamp()+interval '10 minutes' where id='${job}';`);
      assert.equal(await sql(dispatchCall(fixture, job, lease)), 't');
      assert.equal(await sql(dispatchCall(fixture, job, lease)), 'f');
      assert.equal(await sql(settlementCall(fixture, job)), 'settled');
      assert.equal(await sql(settlementCall(fixture, job)), 'settled');
      await financialState(sql, fixture, true, true);
      console.log(`PASS serial paid quote fixture ${kind}`);
    } finally { await sql('rollback;'); }
  }
  await verifyPaidImageCompletionFixture(sql);
  await verifyPaidMetadataCompletionFixture(sql);
  await verifyPaidTextCompletionFixture(sql, 'ai_review');
  await verifyPaidTextCompletionFixture(sql, 'book_bible');
}

export async function paidQuoteLifecycleRaces({ sql, session, until, database }) {
  async function concurrent(first, second, rollback, label) {
    const holder = session(database, `paid_holder_${randomUUID().replaceAll('-', '')}`);
    holder.child.stdin.write(`begin; ${first} select 'BOOKWORM_READY';\n`);
    await until(() => { assert.equal(holder.ended, false, holder.stderr); return holder.stdout.includes('BOOKWORM_READY'); }, 'Paid quote holder not ready');
    const name = `paid_wait_${randomUUID().replaceAll('-', '')}`;
    const contender = session(database, name); contender.child.stdin.end(second);
    await until(async () => {
      assert.equal(contender.ended, false, `Paid quote contender did not wait: ${contender.stderr}`);
      return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1';
    }, 'Expected paid quote PostgreSQL lock wait');
    holder.child.stdin.end(rollback ? 'rollback;\n' : 'commit;\n');
    assert.equal((await holder.done).code, 0, holder.stderr);
    return { result: await contender.done, holder: holder.stdout.split('\n')[0], label };
  }
  // Run actual queue claims before the acceptance-only primitive fixtures leave
  // queued holds. Each real completion fixture finishes before the next claim.
  await paidImageCompletionRaces(sql, concurrent);
  await paidAtomicLeaseCompletionRaces(sql, concurrent, 'metadata');
  for (const kind of ['ai_review', 'book_bible']) {
    await paidTextReceiptCompletionRaces(sql, concurrent, kind);
    await paidAtomicLeaseCompletionRaces(sql, concurrent, kind);
  }
  for (const kind of kinds) {
    for (const mode of ['replay', 'competing', 'rollback']) {
      const f = await paidQuoteFixture(sql, kind);
      const second = f.offers[mode === 'replay' ? 0 : 1];
      const { result, holder } = await concurrent(f.offers[0].accept, second.accept, mode === 'rollback', mode);
      assert.equal(holder, f.offers[0].job);
      if (mode === 'competing') {
        assert.notEqual(result.code, 0); assert.match(result.stderr, /23514.*insufficient credits/s);
      } else { assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), second.job); }
      await financialState(sql, f, true);
      assert.equal(await sql((mode === 'rollback' ? second : f.offers[0]).accept), mode === 'rollback' ? second.job : f.offers[0].job);
      await financialState(sql, f, true);
      console.log(`PASS native paid quote ${kind} acceptance ${mode}`);
    }
    const f = await paidQuoteFixture(sql, kind), job = f.offers[0].job, lease = randomUUID();
    await sql(f.offers[0].accept);
    await sql(`${service} update public.ai_jobs set status='running',lease_token='${lease}',lease_expires_at=clock_timestamp()+interval '10 minutes' where id='${job}';`);
    const dispatch = dispatchCall(f, job, lease);
    const dispatched = await concurrent(dispatch, dispatch, false, 'dispatch');
    assert.equal(dispatched.result.code, 0, dispatched.result.stderr);
    assert.equal(dispatched.holder, 't'); assert.equal(dispatched.result.stdout.trim(), 'f');
    await financialState(sql, f, true);
    console.log(`PASS native paid quote ${kind} one-time dispatch`);
    const settle = settlementCall(f, job);
    const settled = await concurrent(settle, settle, false, 'settlement');
    assert.equal(settled.holder, 'settled');
    assert.equal(settled.result.code, 0, settled.result.stderr); assert.equal(settled.result.stdout.trim(), 'settled');
    await financialState(sql, f, true, true);
    console.log(`PASS native paid quote ${kind} settlement replay`);
  }
  // These guards protect new committed settlement/results, not provider spend
  // or Storage. Each fixture is already dispatched; rejection retains its hold.
  for (const kind of ['image', 'book_bible']) {
    for (const mode of ['permission-first', 'permission-rollback', 'settlement-first', 'settlement-rollback']) {
      const f = await paidQuoteFixture(sql, kind), job = f.offers[0].job, lease = randomUUID();
      await sql(f.offers[0].accept);
      await sql(`${service} update public.ai_jobs set status='running',lease_token='${lease}',lease_expires_at=clock_timestamp()+interval '10 minutes' where id='${job}';`);
      assert.equal(await sql(dispatchCall(f, job, lease)), 't');
      const permission = `${service} update public.workspace_members set role='viewer' where workspace_id='${f.offers[0].workspace}' and user_id='${f.user}';`;
      const settle = settlementCall(f, job);
      const settlementFirst = mode.startsWith('settlement'), rollback = mode.endsWith('rollback');
      const { result } = await concurrent(settlementFirst ? settle : permission, settlementFirst ? permission : settle, rollback, mode);
      if (!settlementFirst && !rollback) { assert.notEqual(result.code, 0); assert.match(result.stderr, /42501/s); }
      else assert.equal(result.code, 0, result.stderr);
      const settled = settlementFirst ? !rollback : rollback;
      await financialState(sql, f, true, settled);
      assert.equal(await sql(`select status from public.funded_usage_quotes where job_id='${job}';`), settled ? 'settled' : 'held');
      assert.equal(await sql(`select role from public.workspace_members where workspace_id='${f.offers[0].workspace}' and user_id='${f.user}';`),
        !settlementFirst && rollback ? 'editor' : 'viewer');
      assert.equal(await sql(`select status from public.workspace_members where workspace_id='${f.offers[0].workspace}' and user_id='${f.user}';`), 'active');
      assert.equal(await sql(`select status from public.ai_jobs where id='${job}';`), 'running',
        'Billing primitive schedules must not claim atomic worker completion');
      if (settled) { assert.equal(await sql(settle), 'settled'); await financialState(sql, f, true, true); }
      console.log(`PASS native paid quote ${kind} ${mode}`);
    }
  }
}

async function paidImageCompletionRaces(sql, concurrent) {
  for (const mode of ['receipt-first', 'receipt-rollback', 'completion-first', 'completion-rollback']) {
    const f = await paidImageCompletionFixture(sql);
    const completionFirst = mode.startsWith('completion'), rollback = mode.endsWith('rollback');
    if (completionFirst) assert.equal(await sql(imageReceiptCall(f)), f.job);
    const save = imageReceiptCall(f), complete = imageCompletionCall(f);
    const { result } = await concurrent(completionFirst ? complete : save, completionFirst ? save : complete, rollback, mode);
    if (completionFirst && !rollback) {
      assert.notEqual(result.code, 0); assert.match(result.stderr, /40001.*image receipt lease lost/s);
    } else if (!completionFirst && rollback) {
      assert.notEqual(result.code, 0); assert.match(result.stderr, /23514.*image completion receipt mismatch/s);
    } else { assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), f.job); }
    await imageCompletionState(sql, f, { completed: !rollback, receipt: completionFirst || !rollback });
    if (rollback) {
      if (!completionFirst) assert.equal(await sql(save), f.job);
      assert.equal(await sql(complete), f.job);
    }
    await replayImageCompletion(sql, f);
    console.log(`PASS native paid image atomic receipt/completion ${mode}`);
  }
  await paidAtomicLeaseCompletionRaces(sql, concurrent, 'image');
}

async function paidAtomicLeaseCompletionRaces(sql, concurrent, kind) {
  const image = kind === 'image';
  const metadata = kind === 'metadata';
  const prepare = image ? paidImageCompletionFixture : metadata ? paidMetadataCompletionFixture : (sql) => paidTextCompletionFixture(sql, kind);
  const completeCall = image ? imageCompletionCall : metadata ? metadataCompletionCall : textCompletionCall;
  const state = image ? imageCompletionState : metadata ? metadataCompletionState : textCompletionState;
  const replay = image ? replayImageCompletion : metadata ? replayMetadataCompletion : replayTextCompletion;
  for (const mode of ['lease-first', 'lease-rollback', 'completion-first', 'completion-rollback']) {
    const f = await prepare(sql);
    if (image) assert.equal(await sql(imageReceiptCall(f)), f.job);
    else if (!metadata) assert.equal(await sql(textReceiptCall(f)), f.job);
    const completionFirst = mode.startsWith('completion'), rollback = mode.endsWith('rollback');
    const reclaim = completionReclaimCall(f), complete = completeCall(f);
    const { result, holder } = await concurrent(completionFirst ? complete : reclaim, completionFirst ? reclaim : complete, rollback, mode);
    if (!completionFirst && !rollback) {
      assert.notEqual(result.code, 0);
      const message = image ? 'image completion' : metadata ? 'metadata quote' : kind === 'ai_review' ? 'AI review quote' : 'Book Bible quote';
      assert.match(result.stderr, new RegExp(`40001.*${message} lease lost`, 's'));
    } else assert.equal(result.code, 0, result.stderr);
    const completed = completionFirst ? !rollback : rollback;
    const recovered = completed ? null : JSON.parse(completionFirst ? result.stdout.trim() : holder);
    const attempts = completed ? 1 : 2, lease = completed ? null : recovered.lease;
    if (completed) {
      if (completionFirst) assert.deepEqual(JSON.parse(result.stdout.trim()), { status: 'succeeded', lease: null, attempts: 1 });
      else assert.equal(result.stdout.trim(), f.job);
    } else {
      assert.equal(recovered.status, 'running'); assert.equal(recovered.attempts, 2); assert.ok(lease); assert.notEqual(lease, f.lease);
    }
    await state(sql, f, { completed, attempts, lease });
    if (!completed) {
      assert.equal(await sql(dispatchCall(f, f.job, lease)), 'f', 'Durable receipt recovery must not redispatch');
      assert.equal(await sql(completeCall(f, lease)), f.job);
    }
    await replay(sql, f, { attempts });
    console.log(`PASS native paid ${kind} atomic lease/completion ${mode}`);
  }
}

async function paidTextReceiptCompletionRaces(sql, concurrent, kind) {
  for (const mode of ['receipt-first', 'receipt-rollback', 'completion-first', 'completion-rollback']) {
    const f = await paidTextCompletionFixture(sql, kind);
    const completionFirst = mode.startsWith('completion'), rollback = mode.endsWith('rollback');
    if (completionFirst) assert.equal(await sql(textReceiptCall(f)), f.job);
    // The reverse ordering deliberately locks the saved receipt identity. It
    // tests completion's share-lock boundary, not Python's HTTP reserve/load.
    const receiptReplay = `${service} select job_id from public.${textReceiptTable(f)} where job_id='${f.job}' for update;`;
    const save = completionFirst ? receiptReplay : textReceiptCall(f), complete = textCompletionCall(f);
    const { result } = await concurrent(completionFirst ? complete : save, completionFirst ? save : complete, rollback, mode);
    if (!completionFirst && rollback) {
      assert.notEqual(result.code, 0); assert.match(result.stderr, /23514/s);
    } else { assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), f.job); }
    await textCompletionState(sql, f, { completed: !rollback, receipt: completionFirst || !rollback });
    if (rollback) {
      if (!completionFirst) assert.equal(await sql(textReceiptCall(f)), f.job);
      assert.equal(await sql(complete), f.job);
    }
    await replayTextCompletion(sql, f);
    console.log(`PASS native paid ${kind} atomic receipt/completion ${mode}`);
  }
}
