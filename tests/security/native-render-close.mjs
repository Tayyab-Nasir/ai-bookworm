/** Disposable PostgreSQL two-session render closure and creation races. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function renderCloseRaces({ sql, session, until, database }) {
  async function fixture(uppercaseKey = false) {
    const [user, org, workspace, book, edition] = Array.from({ length: 5 }, () => randomUUID());
    await sql(`begin;
      insert into auth.users(id,email) values('${user}','${user}@local.test');
      insert into public.organizations(id,name,slug,owner_user_id) values('${org}','Synthetic','${org}','${user}');
      insert into public.workspaces(id,organization_id,name,slug,created_by) values('${workspace}','${org}','Synthetic','${workspace}','${user}');
      insert into public.workspace_members(workspace_id,user_id,role,status) values('${workspace}','${user}','editor','active');
      insert into public.books(id,workspace_id,title,author_name,created_by) values('${book}','${workspace}','Synthetic','Author','${user}');
      insert into public.editions(id,book_id,type,language) values('${edition}','${book}','ebook','en'); commit;`);
    const auth = `set local role authenticated; set local request.jwt.claims='{"sub":"${user}","role":"authenticated"}';`;
    const generatedKey = randomUUID();
    const key = uppercaseKey ? generatedKey.toUpperCase() : generatedKey;
    return {user, workspace, book, edition, key, auth,
      close: `${auth} select public.close_render_request('${book}','${edition}','${key}');`,
      create: `insert into public.publishing_jobs(book_id,edition_id,channel,status,idempotency_key,created_by,request_json) values('${book}','${edition}','render','running','${key}','${user}','{"action":"render"}');`};
  }
  async function barrier(holder, waiter) {
    await until(() => { assert.equal(holder.ended, false, holder.stderr); return holder.stdout.includes('RENDER_CLOSE_LOCK_READY'); }, 'Render holder did not reach barrier');
    const name = `render_close_wait_${randomUUID().replaceAll('-', '')}`, waiting = session(database, name);
    waiting.child.stdin.end(`begin; ${waiter} commit;`);
    await until(async () => { assert.equal(waiting.ended, false, waiting.stderr); return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1'; }, 'Render waiter did not block');
    return waiting;
  }
  for (const first of ['close', 'create']) for (const rollback of [false, true]) {
    const f = await fixture(first === 'close' && !rollback), holder = session(database, `render_close_hold_${randomUUID().replaceAll('-', '')}`);
    holder.child.stdin.write(`begin; ${f[first]} select 'RENDER_CLOSE_LOCK_READY';\n`);
    const waiting = await barrier(holder, f[first === 'close' ? 'create' : 'close']);
    holder.child.stdin.end(rollback ? 'rollback;' : 'commit;');
    const [held, waited] = await Promise.all([holder.done, waiting.done]);
    assert.equal(held.code, 0, held.stderr);
    if (first === 'close' && !rollback) { assert.notEqual(waited.code, 0); assert.match(waited.stderr, /23505/); }
    else assert.equal(waited.code, 0, waited.stderr);
    const expected = first === 'close' ? (rollback ? 'running' : 'cancelled') : (rollback ? 'cancelled' : 'running');
    assert.equal(await sql(`select status from public.publishing_jobs where idempotency_key='${f.key}';`), expected);
    console.log(`PASS native render closure ${first} ${rollback ? 'rollback takeover' : 'commit wins'}`);
  }
  const f = await fixture(), holder = session(database, `render_close_role_${randomUUID().replaceAll('-', '')}`);
  holder.child.stdin.write(`begin; ${f.close} select 'RENDER_CLOSE_LOCK_READY';\n`);
  const waiting = await barrier(holder, `update public.workspace_members set role='viewer' where workspace_id='${f.workspace}' and user_id='${f.user}';`);
  holder.child.stdin.end('commit;');
  const [held, changed] = await Promise.all([holder.done, waiting.done]);
  assert.equal(held.code, 0, held.stderr); assert.equal(changed.code, 0, changed.stderr);
  const denied = session(database, `render_close_denied_${randomUUID().replaceAll('-', '')}`);
  denied.child.stdin.end(`begin; ${f.auth} select public.close_render_request('${f.book}','${f.edition}','${randomUUID()}');`);
  const result = await denied.done; assert.notEqual(result.code, 0); assert.match(result.stderr, /42501/);
  console.log('PASS native render closure membership downgrade');
}
