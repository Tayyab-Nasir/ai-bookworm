/** Synthetic funded narration on disposable SQL only. No provider, Storage or app secrets.
 * The serial fixture gate proves setup/invariants, not the multi-session schedules. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tsImport } from "tsx/esm/api";

const service = "set request.jwt.claim.role='service_role';";
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${literal(JSON.stringify(value))}::jsonb`;

export async function narrationRaceFixture(sql) {
  const { prepareNarrationChapterQuote } = await tsImport("../../services/api/src/lib/narration-pricing.ts", import.meta.url);
  const user = randomUUID(), organization = randomUUID();
  const now = new Date(JSON.parse(await sql("select to_json(clock_timestamp());")));
  const catalog = { version: "native-narration-fixture", approved: true, approvalReference: "synthetic, not retail approval",
    effectiveAt: new Date(now.getTime() - 60_000).toISOString(), expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    quoteLifetimeSeconds: 600, entries: [{ id: "fixture", label: "Synthetic narration", maxInputTokens: 128_000, maxOutputTokens: 1024,
      price: { version: "fixture-price", provider: "openai", model: "gpt-realtime-2.1-mini", rates: [
        { dimension: "text_input", microUsdPerMillionTokens: "600000" }, { dimension: "text_cached_input", microUsdPerMillionTokens: "60000" },
        { dimension: "text_output", microUsdPerMillionTokens: "2400000" }, { dimension: "audio_output", microUsdPerMillionTokens: "20000000" },
      ] }, policy: { version: "fixture-policy", approved: true, microUsdPerCredit: "100", markupBasisPoints: 15000,
        platformMicroUsd: "0", minimumCredits: "1" } }] };
  await sql(`${service} insert into auth.users(id,email) values('${user}','narration-${user}@local.test');
    insert into public.organizations(id,name,slug,owner_user_id) values('${organization}','Native narration','${organization}','${user}');`);
  const offers = [];
  for (let index = 0; index < 2; index++) {
    const [workspace, book, chapter, document, nextDocument, edition] = Array.from({ length: 6 }, () => randomUUID());
    const key = `native-narration-${randomUUID()}`, text = "A".repeat(4000);
    const prepared = prepareNarrationChapterQuote(JSON.stringify(catalog), { modelId: "fixture", idempotencyKey: key,
      now: now.toISOString(), sourceText: text, userId: user, workspaceId: workspace, bookId: book, editionId: edition,
      chapterId: chapter, documentVersionId: document, voice: "marin", speed: 1, instructions: null });
    assert(prepared.offers.length > 1, "Financial races must fund every part of a complete chapter");
    await sql(`${service}
      insert into public.workspaces(id,organization_id,name,slug,created_by) values('${workspace}','${organization}','Narration','${workspace}','${user}');
      insert into public.workspace_members(workspace_id,user_id,role) values('${workspace}','${user}','editor');
      insert into public.books(id,workspace_id,title,author_name,language,created_by) values('${book}','${workspace}','Narration','Author','en','${user}');
      insert into public.chapters(id,book_id,order_index,title) values('${chapter}','${book}',0,'Chapter');
      insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by) values
        ('${document}','${chapter}',1,'{}',${literal(text)},1,'${user}'),('${nextDocument}','${chapter}',2,'{}','Changed source',2,'${user}');
      update public.chapters set current_document_version_id='${document}' where id='${chapter}';
      insert into public.editions(id,book_id,type,language,edition_metadata_json) values('${edition}','${book}','audiobook','en','{"kind":"audiobook"}');`);
    const saved = JSON.parse(await sql(`${service} select to_jsonb(q) from public.save_narration_chapter_quote_snapshot(
      '${user}','${workspace}','${book}','${edition}','${chapter}','${document}',${literal(prepared.sourceSha256)},
      '${key}','${catalog.version}','fixture',${json(prepared.offers)}) q;`));
    offers.push({ workspace, book, chapter, document, nextDocument, edition, prepared, quoteId: saved.id,
      accept: `${service} select (public.accept_narration_chapter_quote('${saved.id}','${user}',${prepared.reservedCredits},true,${json(catalog)})).id;` });
  }
  const credits = Number(offers[0].prepared.reservedCredits);
  assert.equal(offers[1].prepared.reservedCredits, String(credits));
  await sql(`${service} insert into public.credit_ledger(user_id,source,amount,balance_after) values('${user}','purchase',${credits},0);`);
  return { user, organization, offers, credits, catalog };
}

async function state(sql, f, winner = null) {
  const actual = JSON.parse(await sql(`select json_build_object(
    'projects',(select count(*) from public.audiobook_projects where created_by='${f.user}'),
    'jobs',(select count(*) from public.ai_jobs where created_by='${f.user}'),
    'segments',(select count(*) from public.audiobook_segments s join public.ai_jobs j on j.id=s.ai_job_id where j.created_by='${f.user}'),
    'holds',(select count(*) from public.funded_usage_quotes where user_id='${f.user}'),
    'held',(select coalesce(sum(reserved_credits),0) from public.funded_usage_quotes where user_id='${f.user}' and status='held'),
    'acceptances',(select count(*) from public.narration_chapter_quote_acceptances a join public.narration_chapter_quote_snapshots q on q.id=a.quote_id where q.user_id='${f.user}'),
    'balance',(select sum(amount) from public.credit_ledger where user_id='${f.user}'),
    'reservations',(select count(*) from public.credit_ledger where user_id='${f.user}' and source='generation_reservation'),
    'releases',(select count(*) from public.credit_ledger where user_id='${f.user}' and source='generation_release'),
    'usage',(select count(*) from public.usage_events where user_id='${f.user}'));`));
  const count = winner === null ? 0 : f.offers[winner].prepared.offers.length;
  assert.deepEqual(actual, { projects: Number(winner !== null), jobs: count, segments: count, holds: count,
    held: count ? f.credits : 0, acceptances: Number(winner !== null), balance: count ? 0 : f.credits,
    reservations: count, releases: 0, usage: 0 });
  if (winner !== null) assert.equal(await sql(`select narration_quote_id from public.audiobook_projects where created_by='${f.user}';`), f.offers[winner].quoteId);
}

async function cleanup(sql, f) {
  // Retire only this fixture's undispatched work through the real release RPC.
  // Dispatched work is deliberately not refunded or rewritten by cleanup.
  await sql(`${service} select public.release_quoted_narration_before_dispatch(j.id,j.lease_token,'provider_not_configured')
    from public.ai_jobs j join public.funded_usage_quotes q on q.job_id=j.id
    where j.created_by='${f.user}' and j.status in ('queued','running') and q.status='held' and q.dispatched_at is null;`);
}

async function leasedFixture(sql) {
  const f = await narrationRaceFixture(sql), offer = f.offers[0]; await sql(offer.accept);
  const expected = offer.prepared.offers[0];
  // Isolate one eligible child without altering worker queue semantics.
  await sql(`${service} update public.ai_jobs set available_at=clock_timestamp()+interval '1 hour' where created_by='${f.user}' and id<>'${expected.request.jobId}';`);
  const claimed = JSON.parse(await sql(`${service} select to_jsonb(j) from public.claim_quoted_narration_job(600) j;`));
  assert.equal(claimed.id, expected.request.jobId); assert.ok(claimed.lease_token);
  const dispatchWith = lease => `${service} select public.claim_funded_dispatch('${claimed.id}','${lease}','${expected.quote.scope.inputSha256}','${expected.request.model}');`;
  return { f, expected, claimed, dispatchWith, dispatch: dispatchWith(claimed.lease_token),
    release: `${service} select public.release_quoted_narration_before_dispatch('${claimed.id}','${claimed.lease_token}','provider_not_configured');`,
    reclaim: `${service} update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id='${claimed.id}';
      select to_jsonb(j) from public.claim_quoted_narration_job(600) j;` };
}

// Synthetic metadata is deliberately not proof of Storage bytes or speech.
// Use the production calculator for the exact expected customer settlement.
async function evidenceFixture(sql, { leased = null, pcm = true, encoded = true } = {}) {
  const scope = leased ?? await leasedFixture(sql);
  const { f, expected, claimed } = scope, request = expected.request;
  assert.equal(await sql(scope.dispatch), "t");
  const source = JSON.parse(await sql(`select to_json(substring(plain_text from ${request.textStart + 1}
    for ${request.textEnd - request.textStart})) from public.document_versions where id='${request.documentVersionId}';`));
  const location = JSON.parse(await sql(`select json_build_object('project',project_id,'index',segment_index)
    from public.audiobook_segments where ai_job_id='${claimed.id}';`));
  const rawUsage = { input_tokens: 37, output_tokens: 10, total_tokens: 47,
    input_token_details: { text_tokens: 37, audio_tokens: 0, cached_tokens: 11,
      cached_tokens_details: { text_tokens: 11, audio_tokens: 0 } },
    output_token_details: { text_tokens: 2, audio_tokens: 8 } };
  const original = { version: "bookworm-narration-pcm-v1", provider: "openai", model: request.model,
    requestId: `synthetic-original-${claimed.id}`, sourceSha256: request.textSha256,
    storagePath: `private/narration/${f.offers[0].workspace}/${claimed.id}/${claimed.lease_token}.pcm`,
    mimeType: "audio/pcm", sizeBytes: 48000, checksum: "a".repeat(64), sampleRateHz: 24000, channels: 1,
    bitDepth: 16, durationSeconds: 1, transcript: source, rawUsage, latencyMs: 10 };
  const originalHash = await sql(`select encode(public.digest(convert_to(${json(original)}::text,'UTF8'),'sha256'),'hex');`);
  const converted = { version: "bookworm-narration-mp3-v1", pcmReceiptSha256: originalHash, assetId: claimed.id,
    storagePath: `workspaces/${request.workspaceId}/audiobooks/${location.project}/${location.index}.mp3`,
    mimeType: "audio/mpeg", sizeBytes: 1024, checksum: "b".repeat(64), durationSeconds: 1,
    encodingVersion: "narration-mp3-1.0.0", sampleRateHz: 44100, channels: 1, bitRateKbps: 192, bitRateMode: "cbr" };
  const convertedHash = await sql(`select encode(public.digest(convert_to(${json(converted)}::text,'UTF8'),'sha256'),'hex');`);
  const savePcm = (lease = claimed.lease_token, receipt = original) => `${service} select
    (public.save_quoted_narration_receipt('${claimed.id}','${lease}','${expected.quote.scope.inputSha256}',${json(receipt)})).receipt_sha256;`;
  const saveEncoding = (lease = claimed.lease_token, receipt = converted) => `${service} select
    (public.save_quoted_narration_encoding('${claimed.id}','${lease}','${originalHash}',${json(receipt)})).receipt_sha256;`;
  const complete = (lease = claimed.lease_token) => `${service} select (public.complete_quoted_narration_job('${claimed.id}','${lease}')).id;`;
  const reclaim = `${service} update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second'
    where id='${claimed.id}' and status='running'; select to_jsonb(j) from public.claim_quoted_narration_job(600) j;`;
  const { reconcileNarrationUsage } = await tsImport("../../services/api/src/lib/narration-pricing.ts", import.meta.url);
  const measured = reconcileNarrationUsage(expected.quote, { request, sourceText: source, receipt: {
    jobId: claimed.id, userId: f.user, workspaceId: request.workspaceId, requestSha256: expected.quote.scope.inputSha256,
    sourceSha256: request.textSha256, provider: "openai", model: request.model, responseId: original.requestId,
    transcript: source, rawUsage } });
  assert.equal(measured.status, "settle"); assert(Number(measured.releaseCredits) > 0);
  if (pcm) assert.equal(await sql(savePcm()), originalHash);
  if (encoded) { assert(pcm); assert.equal(await sql(saveEncoding()), convertedHash); }
  return { ...scope, original, originalHash, converted, convertedHash, savePcm, saveEncoding, complete, reclaim,
    project: location.project, measured };
}

async function evidenceState(sql, e, { pcm = true, encoded = true, completed = false, parent = "running" } = {}) {
  const job = e.claimed.id, actual = JSON.parse(await sql(`select json_build_object(
    'job',(select status from public.ai_jobs where id='${job}'),
    'fund',(select status from public.funded_usage_quotes where job_id='${job}'),
    'parent',(select status from public.audiobook_projects where id='${e.project}'),
    'pcm',(select receipt_sha256 from public.quoted_narration_receipts where job_id='${job}'),
    'encoding',(select receipt_sha256 from public.quoted_narration_encodings where job_id='${job}'),
    'assets',(select count(*) from public.assets where id='${job}'),
    'versions',(select count(*) from public.asset_versions where asset_id='${job}' and version_number=1 and scan_status='trusted_generated'),
    'links',(select count(*) from public.asset_links where asset_id='${job}' and entity_id='${e.project}' and usage_role='narration_segment'),
    'runs',(select count(*) from public.ai_runs where ai_job_id='${job}'),
    'usage',(select count(*) from public.usage_events where ai_job_id='${job}'),
    'debit',(select quantity from public.usage_events where ai_job_id='${job}' and meter='token_credits'),
    'releases',(select count(*) from public.credit_ledger where reference_id='${job}' and source='generation_release'),
    'balance',(select sum(amount) from public.credit_ledger where user_id='${e.f.user}'),
    'settlement',(select settlement_json from public.funded_usage_quotes where job_id='${job}'));`));
  const count = Number(completed);
  assert.deepEqual(actual, { job: completed ? "succeeded" : "running", fund: completed ? "settled" : "held", parent,
    pcm: pcm ? e.originalHash : null, encoding: encoded ? e.convertedHash : null,
    assets: count, versions: count, links: count, runs: count, usage: count,
    debit: completed ? Number(e.measured.debitCredits) : null, releases: count,
    balance: completed ? Number(e.measured.releaseCredits) : 0, settlement: completed ? e.measured : null });
}

async function siblingEvidence(sql, e, index) {
  const expected = e.f.offers[0].prepared.offers[index]; assert(expected);
  await sql(`${service} update public.ai_jobs set available_at=clock_timestamp() where id='${expected.request.jobId}';`);
  const claimed = JSON.parse(await sql(`${service} select to_jsonb(j) from public.claim_quoted_narration_job(600) j;`));
  assert.equal(claimed.id, expected.request.jobId); assert.ok(claimed.lease_token);
  const dispatchWith = lease => `${service} select public.claim_funded_dispatch('${claimed.id}','${lease}','${expected.quote.scope.inputSha256}','${expected.request.model}');`;
  return await evidenceFixture(sql, { leased: { f: e.f, expected, claimed, dispatchWith, dispatch: dispatchWith(claimed.lease_token) } });
}

async function verifyNarrationEvidenceFixtures(sql) {
  for (const mode of ["completion", "reclaim", "failed-parent"]) {
    await sql("begin;");
    try {
      const e = await evidenceFixture(sql); await evidenceState(sql, e);
      let lease = e.claimed.lease_token, parent = "running";
      if (mode === "reclaim") {
        const next = JSON.parse(await sql(e.reclaim));
        assert.equal(next.id, e.claimed.id); assert.notEqual(next.lease_token, lease); lease = next.lease_token;
        assert.equal(await sql(e.dispatchWith(lease)), "f");
        assert.equal(await sql(e.savePcm(lease)), e.originalHash); assert.equal(await sql(e.saveEncoding(lease)), e.convertedHash);
      } else if (mode === "failed-parent") {
        const sibling = await siblingEvidence(sql, e, 1);
        assert.equal(await sql(`${service} select public.hold_quoted_narration_for_review('${sibling.claimed.id}',
          '${sibling.claimed.lease_token}','storage_unconfirmed','synthetic-review');`), "t"); parent = "failed";
      }
      assert.equal(await sql(e.complete(lease)), e.claimed.id);
      await evidenceState(sql, e, { completed: true, parent });
      // A lost completion reply may replay the original result, never its bill.
      assert.equal(await sql(e.complete()), e.claimed.id); await evidenceState(sql, e, { completed: true, parent });
      await cleanup(sql, e.f); console.log(`PASS narration evidence serial gate: ${mode}`);
    } finally { await sql("rollback;"); }
  }
}

export async function verifyNarrationRaceFixtures(sql) {
  await sql("begin;");
  try {
    const f = await narrationRaceFixture(sql), first = f.offers[0], second = f.offers[1];
    await state(sql, f);
    const project = await sql(first.accept); await state(sql, f, 0);
    assert.equal(await sql(first.accept), project); await state(sql, f, 0);
    await sql(`${service} do $$ begin
      begin perform public.accept_narration_chapter_quote('${second.quoteId}','${f.user}',${f.credits},true,${json({})});
        raise exception 'Unavailable catalog unexpectedly accepted'; exception when check_violation then null; end;
      begin perform public.accept_narration_chapter_quote('${second.quoteId}','${f.user}',${f.credits},true,${json(f.catalog)});
        raise exception 'Competing chapter consumed unavailable funds'; exception when check_violation then
          assert sqlerrm='insufficient credits', 'Wrong competing-wallet rejection'; end;
    end $$;`);
    await state(sql, f, 0);
    await cleanup(sql, f);
    assert.equal(await sql(`select sum(amount) from public.credit_ledger where user_id='${f.user}';`), String(f.credits));
    assert.equal(await sql(`select count(*) from public.funded_usage_quotes where user_id='${f.user}' and status='held';`), "0");
    console.log("PASS narration native-fixture serial gate: complete funding, replay and bounded release");
  } finally { await sql("rollback;"); }
  for (const action of ["dispatch", "release", "reclaim"]) {
    await sql("begin;");
    try {
      const { f, expected, claimed, dispatchWith, dispatch, release, reclaim } = await leasedFixture(sql);
      await state(sql, f, 0);
      if (action === "release") {
        assert.equal(await sql(release), "t");
        await sql(`${service} do $$ begin begin ${dispatch.replace(service, "").replace("select ", "perform ")}
          raise exception 'Released narration dispatched'; exception when serialization_failure then null; end; end $$;`);
      } else {
        if (action === "dispatch") {
          assert.equal(await sql(dispatch), "t"); assert.equal(await sql(dispatch), "f");
        }
        const recovered = JSON.parse(await sql(reclaim));
        assert.equal(recovered.id, claimed.id); assert.notEqual(recovered.lease_token, claimed.lease_token); assert.equal(recovered.attempts, 2);
        await sql(`${service} do $$ begin begin ${dispatch.replace(service, "").replace("select ", "perform ")}
          raise exception 'Stale narration lease dispatched'; exception when serialization_failure then null; end; end $$;`);
        const currentDispatch = dispatchWith(recovered.lease_token);
        assert.equal(await sql(currentDispatch), action === "dispatch" ? "f" : "t"); assert.equal(await sql(currentDispatch), "f");
        const currentRelease = release.replace(claimed.lease_token, recovered.lease_token);
        await sql(`${service} do $$ begin begin ${currentRelease.replace(service, "").replace("select ", "perform ")}
          raise exception 'Dispatched narration refunded'; exception when check_violation then
            assert sqlerrm='narration hold is not releasable', 'Wrong post-dispatch release rejection'; end; end $$;`);
      }
      await cleanup(sql, f);
      const observed = JSON.parse(await sql(`select json_build_object(
        'balance',(select sum(amount) from public.credit_ledger where user_id='${f.user}'),
        'held',(select coalesce(sum(reserved_credits),0) from public.funded_usage_quotes where user_id='${f.user}' and status='held'),
        'usage',(select count(*) from public.usage_events where user_id='${f.user}'));`));
      const held = action === "release" ? 0 : Number(expected.quote.reservedCredits);
      assert.deepEqual(observed, { balance: f.credits - held, held, usage: 0 });
      console.log(`PASS narration native-fixture serial gate: ${action}, current lease and no ambiguous refund`);
    } finally { await sql("rollback;"); }
  }
  await verifyNarrationEvidenceFixtures(sql);
}

export async function narrationLifecycleRaces({ sql, session, until, database }) {
  async function concurrent(first, second, rollback = false) {
    const holder = session(database, `narration_holder_${randomUUID().replaceAll("-", "")}`);
    holder.child.stdin.write(`begin; ${first} select 'BOOKWORM_READY';\n`);
    await until(() => { assert.equal(holder.ended, false, holder.stderr); return holder.stdout.includes("BOOKWORM_READY"); }, "Narration holder not ready");
    const name = `narration_wait_${randomUUID().replaceAll("-", "")}`;
    const contender = session(database, name); contender.child.stdin.end(second);
    await until(async () => {
      assert.equal(contender.ended, false, `Narration contender did not wait: ${contender.stderr}`);
      return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === "1";
    }, "Expected narration PostgreSQL lock wait");
    holder.child.stdin.end(rollback ? "rollback;\n" : "commit;\n");
    assert.equal((await holder.done).code, 0, holder.stderr);
    return { holder: holder.stdout.split("\n")[0], result: await contender.done };
  }
  for (const mode of ["replay", "competing", "rollback"]) {
    const f = await narrationRaceFixture(sql), other = mode === "replay" ? 0 : 1;
    const { holder, result } = await concurrent(f.offers[0].accept, f.offers[other].accept, mode === "rollback");
    if (mode === "competing") { assert.notEqual(result.code, 0); assert.match(result.stderr, /23514.*insufficient credits/s); }
    else {
      assert.equal(result.code, 0, result.stderr);
      if (mode === "replay") assert.equal(result.stdout.trim(), holder);
    }
    const winner = mode === "rollback" ? 1 : 0;
    await state(sql, f, winner);
    const replay = await sql(f.offers[winner].accept);
    assert.equal(replay, mode === "rollback" ? result.stdout.trim() : holder); await state(sql, f, winner);
    await cleanup(sql, f); console.log(`PASS native narration complete-chapter acceptance ${mode}`);
  }
  for (const target of ["member", "source"]) {
    for (const first of ["change", "acceptance"]) {
      for (const rollback of [false, true]) {
        const f = await narrationRaceFixture(sql), offer = f.offers[0];
        const change = target === "member" ? `${service} update public.workspace_members set role='viewer' where workspace_id='${offer.workspace}' and user_id='${f.user}';`
          : `${service} update public.chapters set current_document_version_id='${offer.nextDocument}' where id='${offer.chapter}';`;
        const { result } = await concurrent(first === "change" ? change : offer.accept, first === "change" ? offer.accept : change, rollback);
        const accepted = first === "change" ? rollback : !rollback;
        if (first === "change" && !rollback) {
          assert.notEqual(result.code, 0); assert.match(result.stderr, target === "member" ? /42501/s : /23514.*source changed/s);
        } else assert.equal(result.code, 0, result.stderr);
        await state(sql, f, accepted ? 0 : null);
        const changed = first !== "change" || !rollback;
        assert.equal(await sql(target === "member" ? `select role from public.workspace_members where workspace_id='${offer.workspace}' and user_id='${f.user}';`
          : `select current_document_version_id from public.chapters where id='${offer.chapter}';`),
        target === "member" ? changed ? "viewer" : "editor" : changed ? offer.nextDocument : offer.document);
        await cleanup(sql, f); console.log(`PASS native narration ${target} ${first}-first ${rollback ? "rollback" : "commit"}`);
      }
    }
  }
  for (const mode of ["dispatch", "dispatch-first-release", "release-first-dispatch", "dispatch-first-reclaim", "reclaim-first-dispatch"]) {
    const { f, expected, claimed, dispatchWith, dispatch, release, reclaim } = await leasedFixture(sql);
    const first = mode.startsWith("release") ? release : mode.startsWith("reclaim") ? reclaim : dispatch;
    const second = mode === "dispatch" || mode.startsWith("release") || mode.startsWith("reclaim") ? dispatch : mode.endsWith("release") ? release : reclaim;
    const { holder, result } = await concurrent(first, second);
    if (mode === "dispatch") {
      assert.equal(holder, "t"); assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), "f");
    } else if (mode === "dispatch-first-reclaim") {
      assert.equal(holder, "t"); assert.equal(result.code, 0, result.stderr);
      const recovered = JSON.parse(result.stdout.trim()); assert.equal(recovered.id, claimed.id);
      assert.notEqual(recovered.lease_token, claimed.lease_token); assert.equal(recovered.attempts, 2);
      assert.equal(await sql(dispatchWith(recovered.lease_token)), "f");
    } else {
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, mode === "dispatch-first-release" ? /23514.*not releasable/s : /40001/s);
    }
    const released = mode === "release-first-dispatch";
    const observed = JSON.parse(await sql(`select json_build_object('status',status,'dispatched',dispatched_at is not null,
      'releases',(select count(*) from public.credit_ledger where reference_id='${claimed.id}' and source='generation_release'),
      'usage',(select count(*) from public.usage_events where ai_job_id='${claimed.id}')) from public.funded_usage_quotes where job_id='${claimed.id}';`));
    assert.deepEqual(observed, { status: released ? "cancelled" : "held", dispatched: mode !== "release-first-dispatch" && mode !== "reclaim-first-dispatch", releases: Number(released), usage: 0 });
    await cleanup(sql, f); console.log(`PASS native narration fenced ${mode}`);
  }

  for (const kind of ["PCM", "encoding"]) {
    for (const mode of ["replay", "conflict", "rollback"]) {
      const e = await evidenceFixture(sql, { pcm: kind !== "PCM", encoded: false });
      const save = kind === "PCM" ? e.savePcm : e.saveEncoding;
      const receipt = kind === "PCM" ? e.original : e.converted;
      const conflicting = kind === "PCM" ? { ...receipt, transcript: "Conflicting original evidence" }
        : { ...receipt, checksum: "c".repeat(64) };
      const { holder, result } = await concurrent(save(), save(e.claimed.lease_token, mode === "conflict" ? conflicting : receipt), mode === "rollback");
      if (mode === "conflict") { assert.notEqual(result.code, 0); assert.match(result.stderr, /23505.*receipt conflict/s); }
      else { assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), holder); }
      assert.equal(holder, kind === "PCM" ? e.originalHash : e.convertedHash);
      await evidenceState(sql, e, { encoded: kind === "encoding" }); await cleanup(sql, e.f);
      console.log(`PASS native narration ${kind} receipt ${mode}`);
    }
    for (const first of ["receipt", "reclaim"]) {
      const e = await evidenceFixture(sql, { pcm: kind !== "PCM", encoded: false });
      const save = kind === "PCM" ? e.savePcm : e.saveEncoding;
      const { holder, result } = await concurrent(first === "receipt" ? save() : e.reclaim, first === "receipt" ? e.reclaim : save());
      const reclaimed = JSON.parse(first === "receipt" ? result.stdout.trim() : holder);
      assert.equal(reclaimed.id, e.claimed.id); assert.notEqual(reclaimed.lease_token, e.claimed.lease_token);
      if (first === "reclaim") { assert.notEqual(result.code, 0); assert.match(result.stderr, /40001.*lease lost/s); }
      else assert.equal(result.code, 0, result.stderr);
      await evidenceState(sql, e, { pcm: kind !== "PCM" || first === "receipt", encoded: kind === "encoding" && first === "receipt" });
      assert.equal(await sql(e.dispatchWith(reclaimed.lease_token)), "f", "Evidence recovery redispatched provider work");
      if (kind === "PCM" && first === "reclaim") {
        await sql(`${service} do $$ begin begin ${save(reclaimed.lease_token).replace(service, "").replace("select", "perform")}
          raise exception 'Replacement manufactured missing original'; exception when serialization_failure then null; end; end $$;`);
        await evidenceState(sql, e, { pcm: false, encoded: false });
      } else {
        assert.equal(await sql(e.savePcm(reclaimed.lease_token)), e.originalHash);
        assert.equal(await sql(e.saveEncoding(reclaimed.lease_token)), e.convertedHash);
        assert.equal(await sql(e.complete(reclaimed.lease_token)), e.claimed.id); await evidenceState(sql, e, { completed: true });
      }
      await cleanup(sql, e.f); console.log(`PASS native narration ${kind} ${first}-first reclaim`);
    }
  }
  for (const rollback of [false, true]) {
    const e = await evidenceFixture(sql), { holder, result } = await concurrent(e.complete(), e.complete(), rollback);
    assert.equal(holder, e.claimed.id); assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), e.claimed.id);
    await evidenceState(sql, e, { completed: true });
    assert.equal(await sql(e.complete()), e.claimed.id); await evidenceState(sql, e, { completed: true });
    await cleanup(sql, e.f); console.log(`PASS native narration measured completion ${rollback ? "rollback" : "replay"}`);
  }
  for (const first of ["completion", "reclaim"]) {
    const e = await evidenceFixture(sql), { holder, result } = await concurrent(first === "completion" ? e.complete() : e.reclaim,
      first === "completion" ? e.reclaim : e.complete());
    if (first === "completion") {
      assert.equal(holder, e.claimed.id); assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), "");
    } else {
      assert.notEqual(result.code, 0); assert.match(result.stderr, /40001.*lease lost/s);
      const next = JSON.parse(holder); assert.notEqual(next.lease_token, e.claimed.lease_token);
      await evidenceState(sql, e); assert.equal(await sql(e.dispatchWith(next.lease_token)), "f");
      assert.equal(await sql(e.complete(next.lease_token)), e.claimed.id);
    }
    await evidenceState(sql, e, { completed: true }); await cleanup(sql, e.f);
    console.log(`PASS native narration measured ${first}-first reclaim`);
  }
  for (const first of ["review", "completion"]) {
    for (const rollback of [false, true]) {
      const e = await evidenceFixture(sql), sibling = await siblingEvidence(sql, e, 1);
      const review = `${service} select public.hold_quoted_narration_for_review('${sibling.claimed.id}',
        '${sibling.claimed.lease_token}','storage_unconfirmed','synthetic-review');`;
      const { result } = await concurrent(first === "review" ? review : e.complete(), first === "review" ? e.complete() : review, rollback);
      assert.equal(result.code, 0, result.stderr);
      const failed = first === "completion" || !rollback, completed = first === "review" || !rollback;
      await evidenceState(sql, e, { completed, parent: failed ? "failed" : "running" });
      assert.equal(await sql(`select status from public.funded_usage_quotes where job_id='${sibling.claimed.id}';`), failed ? "requires_review" : "held");
      // Completing a recovered original must not revive its failed chapter.
      assert.equal(await sql(e.complete()), e.claimed.id);
      await evidenceState(sql, e, { completed: true, parent: failed ? "failed" : "running" });
      await cleanup(sql, e.f); console.log(`PASS native narration failed-parent ${first}-first ${rollback ? "rollback" : "commit"}`);
    }
  }
  for (const rollback of [false, true]) {
    const e = await evidenceFixture(sql), remaining = [];
    for (let index = 1; index < e.f.offers[0].prepared.offers.length; index++) remaining.push(await siblingEvidence(sql, e, index));
    assert.equal(remaining.length, 2, "Final-sibling fixture must exercise two independent current jobs");
    assert.equal(await sql(e.complete()), e.claimed.id);
    const { result } = await concurrent(remaining[0].complete(), remaining[1].complete(), rollback);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await sql(`select status from public.audiobook_projects where id='${e.project}';`), rollback ? "running" : "succeeded");
    assert.equal(await sql(remaining[0].complete()), remaining[0].claimed.id);
    const parts = [e, ...remaining], credits = parts.reduce((sum, part) => sum + Number(part.measured.debitCredits), 0);
    const actual = JSON.parse(await sql(`select json_build_object('status',status,
      'assets',(select count(*) from public.assets where created_by='${e.f.user}'),
      'usage',(select count(*) from public.usage_events where user_id='${e.f.user}'),
      'balance',(select sum(amount) from public.credit_ledger where user_id='${e.f.user}'),
      'settled',(select count(*) from public.funded_usage_quotes where user_id='${e.f.user}' and status='settled'))
      from public.audiobook_projects where id='${e.project}';`));
    assert.deepEqual(actual, { status: "succeeded", assets: parts.length, usage: parts.length,
      balance: e.f.credits - credits, settled: parts.length });
    for (const part of parts) assert.equal(await sql(part.complete()), part.claimed.id);
    assert.equal(await sql(`select sum(amount) from public.credit_ledger where user_id='${e.f.user}';`), String(e.f.credits - credits));
    console.log(`PASS native narration final-sibling ${rollback ? "rollback" : "commit"}`);
  }
}
