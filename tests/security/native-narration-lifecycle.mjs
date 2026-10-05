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
}
