/** Disposable native PostgreSQL: closure and delayed quote creation must serialize. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function storyBlueprintQuoteClosureRaces({ sql, session, until, database }) {
  async function fixture() {
    const [user, org, workspace, book] = Array.from({ length: 4 }, () => randomUUID());
    const key = randomUUID();
    await sql(`begin;
      insert into auth.users(id,email) values('${user}','${user}@local.test');
      insert into public.organizations(id,name,slug,owner_user_id) values('${org}','Synthetic','${org}','${user}');
      insert into public.workspaces(id,organization_id,name,slug,created_by) values('${workspace}','${org}','Synthetic','${workspace}','${user}');
      insert into public.workspace_members(workspace_id,user_id,role,status) values('${workspace}','${user}','writer','active');
      insert into public.books(id,workspace_id,title,author_name,language,created_by) values('${book}','${workspace}','Synthetic','Author','en','${user}');
      insert into public.story_blueprints(book_id,created_by,updated_by) values('${book}','${user}','${user}'); commit;`);
    const role = 'set local role service_role;';
    const catalog = `jsonb_build_object('version','native','model','synthetic','provider','openai','approved',true,'expiresAt',clock_timestamp()+interval '1 hour')`;
    return { user, workspace, book, key,
      close: `${role} select public.close_story_blueprint_quote_request('${book}','${user}','${key}');`,
      create: `${role} select id from public.request_story_blueprint_quote('${book}','${user}',${catalog},'${key}');` };
  }
  for (const isolation of ['read committed', 'repeatable read']) for (const first of ['close', 'create']) for (const rollback of [false, true]) {
    const f = await fixture();
    const holder = session(database, `blueprint_hold_${randomUUID().replaceAll('-', '')}`);
    holder.child.stdin.write(`begin; ${f[first]} select 'BLUEPRINT_LOCK_READY';\n`);
    await until(() => { assert.equal(holder.ended, false, holder.stderr); return holder.stdout.includes('BLUEPRINT_LOCK_READY'); }, 'Blueprint holder did not reach barrier');
    const name = `blueprint_wait_${randomUUID().replaceAll('-', '')}`;
    const waiter = session(database, name);
    waiter.child.stdin.end(`begin isolation level ${isolation}; select count(*) from public.story_blueprint_quote_identities where user_id='${f.user}'; ${f[first === 'close' ? 'create' : 'close']} commit;`);
    await until(async () => { assert.equal(waiter.ended, false, waiter.stderr); return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1'; }, 'Blueprint waiter did not block');
    holder.child.stdin.end(rollback ? 'rollback;' : 'commit;');
    const [held, waited] = await Promise.all([holder.done, waiter.done]);
    assert.equal(held.code, 0, held.stderr);
    const closed = first === 'close' ? !rollback : rollback;
    if (!rollback && (first === 'close' || isolation === 'repeatable read')) { assert.notEqual(waited.code, 0); assert.match(waited.stderr, /23505|40001/); }
    else assert.equal(waited.code, 0, waited.stderr);
    if (first === 'create' && !rollback && isolation === 'read committed') assert.match(waited.stdout, /"state"\s*:\s*"exists"/);
    assert.equal(await sql(`select count(*) from public.story_blueprint_quote_identities where user_id='${f.user}' and idempotency_key='${f.key}' and kind='closed';`), closed ? '1' : '0');
    assert.equal(await sql(`select count(*) from public.story_blueprint_quote_identities where user_id='${f.user}' and idempotency_key='${f.key}' and kind='requested';`), closed ? '0' : '1');
    assert.equal(await sql(`select count(*) from public.story_blueprint_quote_requests where user_id='${f.user}' and idempotency_key='${f.key}';`), closed ? '0' : '1');
    console.log(`PASS native Story Blueprint quote closure ${isolation}, ${first} ${rollback ? 'rollback takeover' : 'commit wins'}`);
  }

  async function proposalFixture(expired = false) {
    const f = await fixture(), proposal = randomUUID();
    const catalog = `jsonb_build_object('version','native','model','synthetic','provider','openai','approved',true,'expiresAt',clock_timestamp()+interval '1 hour')`;
    const request = await sql(`set role service_role; select id from public.request_story_blueprint_quote('${f.book}','${f.user}',${catalog},'${f.key}');`);
    const created = expired ? "clock_timestamp()-interval '10 minutes'" : "clock_timestamp()-interval '1 second'";
    const expires = expired ? "clock_timestamp()-interval '5 minutes'" : "clock_timestamp()+interval '10 minutes'";
    await sql(`begin; set local role service_role;
      insert into public.story_blueprint_quote_proposals(
        id,request_id,user_id,workspace_id,book_id,blueprint_id,source_revision,source_snapshot_json,
        book_snapshot_json,source_sha256,generation_request_sha256,catalog_json,generation_job_id,
        usage_quote_json,reserved_credits,created_at,expires_at)
      select '${proposal}',r.id,r.user_id,r.workspace_id,r.book_id,r.blueprint_id,r.source_revision,r.source_snapshot_json,
        r.book_snapshot_json,r.source_sha256,repeat('d',64),r.catalog_json,r.generation_job_id,
        jsonb_build_object('scope',jsonb_build_object('jobId',r.generation_job_id,'userId',r.user_id,
          'workspaceId',r.workspace_id,'inputSha256',repeat('d',64)),
          'reservedCredits','5','fingerprint',repeat('a',64),
          'policy',jsonb_build_object('approved',true,'version','native'),
          'price',jsonb_build_object('version','native','model','synthetic','provider','openai'),
          'createdAt',${created},'expiresAt',${expires}),5,${created},${expires}
      from public.story_blueprint_quote_requests r where r.id='${request}';
      insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after)
        values('${f.user}','${f.workspace}','purchase',5,0); commit;`);
    return { ...f, proposal,
      accept: `set local role service_role; select id from public.accept_story_blueprint_quote('${proposal}','${f.user}',5);`,
      resolve: `set local role service_role; select public.resolve_story_blueprint_quote('${proposal}','${f.user}');` };
  }

  for (const isolation of ['read committed', 'repeatable read']) for (const first of ['accept', 'resolve']) for (const rollback of [false, true]) {
    const f = await proposalFixture();
    const holder = session(database, `blueprint_offer_hold_${randomUUID().replaceAll('-', '')}`);
    holder.child.stdin.write(`begin; ${f[first]} select 'BLUEPRINT_OFFER_READY';\n`);
    await until(() => { assert.equal(holder.ended, false, holder.stderr); return holder.stdout.includes('BLUEPRINT_OFFER_READY'); }, 'Quote acceptance holder did not reach barrier');
    const name = `blueprint_offer_wait_${randomUUID().replaceAll('-', '')}`, waiter = session(database, name);
    waiter.child.stdin.end(`begin isolation level ${isolation}; select count(*) from public.story_blueprint_quote_proposals where id='${f.proposal}'; ${f[first === 'accept' ? 'resolve' : 'accept']} commit;`);
    await until(async () => { assert.equal(waiter.ended, false, waiter.stderr); return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1'; }, 'Quote acceptance waiter did not block');
    holder.child.stdin.end(rollback ? 'rollback;' : 'commit;');
    const [held, waited] = await Promise.all([holder.done, waiter.done]);
    assert.equal(held.code, 0, held.stderr);
    if (first === 'accept' && !rollback && isolation === 'repeatable read') {
      assert.notEqual(waited.code, 0); assert.match(waited.stderr, /40001/);
    } else {
      assert.equal(waited.code, 0, waited.stderr);
      if (first === 'accept') assert.match(waited.stdout, rollback ? /"state"\s*:\s*"open"/ : /"state"\s*:\s*"accepted"/);
      if (first === 'resolve') assert.match(held.stdout, /"state"\s*:\s*"open"/);
    }
    const accepted = first === 'resolve' || !rollback;
    assert.equal(await sql(`select count(*) from public.story_blueprint_quote_proposals where id='${f.proposal}' and accepted_job_id is not null;`), accepted ? '1' : '0');
    assert.equal(await sql(`select count(*) from public.funded_usage_quotes where user_id='${f.user}';`), accepted ? '1' : '0');
    console.log(`PASS native Story Blueprint quote resolution ${isolation}, ${first} ${rollback ? 'rollback takeover' : 'commit wins'}`);
  }
  {
    const f = await proposalFixture(true), holder = session(database, `blueprint_expired_hold_${randomUUID().replaceAll('-', '')}`);
    holder.child.stdin.write(`begin; ${f.resolve} select 'BLUEPRINT_EXPIRED_READY';\n`);
    await until(() => { assert.equal(holder.ended, false, holder.stderr); return holder.stdout.includes('BLUEPRINT_EXPIRED_READY'); }, 'Expired quote holder did not reach barrier');
    assert.match(holder.stdout, /"state"\s*:\s*"unusable"/);
    const name = `blueprint_expired_wait_${randomUUID().replaceAll('-', '')}`, waiter = session(database, name);
    waiter.child.stdin.end(`begin; ${f.accept} commit;`);
    await until(async () => { assert.equal(waiter.ended, false, waiter.stderr); return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1'; }, 'Expired quote acceptance did not wait');
    holder.child.stdin.end('commit;');
    const [held, waited] = await Promise.all([holder.done, waiter.done]);
    assert.equal(held.code, 0, held.stderr); assert.notEqual(waited.code, 0); assert.match(waited.stderr, /22023/);
    assert.equal(await sql(`select count(*) from public.funded_usage_quotes where user_id='${f.user}';`), '0');
    console.log('PASS native expired Story Blueprint quote cannot accept after resolution');
  }
}
