/** Native PostgreSQL: receipt closure and community visibility serialize with joins. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function communityJoinOperationRaces({ sql, session, until, database }) {
  async function fixture() {
    const [owner, user, community, operation] = Array.from({ length: 4 }, () => randomUUID());
    await sql(`begin;
      insert into auth.users(id,email) values('${owner}','${owner}@local.test'),('${user}','${user}@local.test');
      insert into public.communities(id,owner_user_id,name,slug,visibility)
        values('${community}','${owner}','Synthetic','${community}','public'); commit;`);
    const role = 'set local role service_role;';
    return { user, community, operation,
      join: `${role} select public.request_community_join('${community}','${user}','${operation}');`,
      close: `${role} select public.close_community_join_operation('${community}','${user}','${operation}');` };
  }

  for (const isolation of ['read committed', 'repeatable read']) for (const first of ['join', 'close']) for (const rollback of [false, true]) {
    const f = await fixture();
    const holder = session(database, `community_hold_${randomUUID().replaceAll('-', '')}`);
    holder.child.stdin.write(`begin; ${f[first]} select 'COMMUNITY_READY';\n`);
    await until(() => { assert.equal(holder.ended, false, holder.stderr); return holder.stdout.includes('COMMUNITY_READY'); }, 'Community holder did not reach barrier');
    const name = `community_wait_${randomUUID().replaceAll('-', '')}`;
    const waiter = session(database, name);
    waiter.child.stdin.end(`begin isolation level ${isolation}; select count(*) from public.community_join_operations where user_id='${f.user}'; ${f[first === 'join' ? 'close' : 'join']} commit;`);
    await until(async () => { assert.equal(waiter.ended, false, waiter.stderr); return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1'; }, 'Community waiter did not block');
    holder.child.stdin.end(rollback ? 'rollback;' : 'commit;');
    const [held, waited] = await Promise.all([holder.done, waiter.done]);
    assert.equal(held.code, 0, held.stderr);
    if (!rollback && isolation === 'repeatable read') {
      assert.notEqual(waited.code, 0); assert.match(waited.stderr, /40001/);
    } else assert.equal(waited.code, 0, waited.stderr);
    const closed = first === 'close' ? !rollback : rollback;
    assert.equal(await sql(`select count(*) from public.community_join_operations where user_id='${f.user}' and operation_id='${f.operation}' and state='closed';`), closed ? '1' : '0');
    assert.equal(await sql(`select count(*) from public.community_join_operations where user_id='${f.user}' and operation_id='${f.operation}' and state='joined';`), closed ? '0' : '1');
    assert.equal(await sql(`select count(*) from public.community_members where community_id='${f.community}' and user_id='${f.user}';`), closed ? '0' : '1');
    console.log(`PASS native community join ${isolation}, ${first} ${rollback ? 'rollback takeover' : 'commit wins'}`);
  }

  for (const isolation of ['read committed', 'repeatable read']) for (const rollback of [false, true]) {
    const f = await fixture();
    const holder = session(database, `community_visibility_hold_${randomUUID().replaceAll('-', '')}`);
    holder.child.stdin.write(`begin; update public.communities set visibility='private' where id='${f.community}'; select 'COMMUNITY_VISIBILITY_READY';\n`);
    await until(() => { assert.equal(holder.ended, false, holder.stderr); return holder.stdout.includes('COMMUNITY_VISIBILITY_READY'); }, 'Community visibility holder did not reach barrier');
    const name = `community_visibility_wait_${randomUUID().replaceAll('-', '')}`;
    const waiter = session(database, name);
    waiter.child.stdin.end(`begin isolation level ${isolation}; select count(*) from public.community_join_operations where user_id='${f.user}'; ${f.join} commit;`);
    await until(async () => { assert.equal(waiter.ended, false, waiter.stderr); return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1'; }, 'Community visibility waiter did not block');
    holder.child.stdin.end(rollback ? 'rollback;' : 'commit;');
    const [held, waited] = await Promise.all([holder.done, waiter.done]);
    assert.equal(held.code, 0, held.stderr);
    if (!rollback && isolation === 'repeatable read') {
      assert.notEqual(waited.code, 0); assert.match(waited.stderr, /40001/);
    } else {
      assert.equal(waited.code, 0, waited.stderr);
      assert.match(waited.stdout, rollback ? /"state"\s*:\s*"joined"/ : /"reason"\s*:\s*"not_open"/);
    }
    assert.equal(await sql(`select count(*) from public.community_members where community_id='${f.community}' and user_id='${f.user}';`), rollback ? '1' : '0');
    console.log(`PASS native community visibility ${isolation}, ${rollback ? 'rollback permits join' : 'private change wins'}`);
  }

  for (const rollback of [false, true]) {
    const f = await fixture();
    const holder = session(database, `community_join_hold_${randomUUID().replaceAll('-', '')}`);
    holder.child.stdin.write(`begin; ${f.join} select 'COMMUNITY_JOIN_READY';\n`);
    await until(() => { assert.equal(holder.ended, false, holder.stderr); return holder.stdout.includes('COMMUNITY_JOIN_READY'); }, 'Community join holder did not reach barrier');
    const name = `community_private_wait_${randomUUID().replaceAll('-', '')}`;
    const waiter = session(database, name);
    waiter.child.stdin.end(`begin; update public.communities set visibility='private' where id='${f.community}'; commit;`);
    await until(async () => { assert.equal(waiter.ended, false, waiter.stderr); return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1'; }, 'Community visibility update did not block');
    holder.child.stdin.end(rollback ? 'rollback;' : 'commit;');
    const [held, waited] = await Promise.all([holder.done, waiter.done]);
    assert.equal(held.code, 0, held.stderr); assert.equal(waited.code, 0, waited.stderr);
    assert.equal(await sql(`select visibility from public.communities where id='${f.community}';`), 'private');
    assert.equal(await sql(`select count(*) from public.community_members where community_id='${f.community}' and user_id='${f.user}';`), rollback ? '0' : '1');
    console.log(`PASS native community join precedes visibility update, ${rollback ? 'rollback' : 'commit'}`);
  }
}
