/** Disposable PostgreSQL two-session chapter restore/closure races. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function chapterRestoreLedgerRaces({ sql, session, until, database }) {
  const parse = output => JSON.parse(output.split('\n').find(line => line.startsWith('{')) ?? 'null');
  async function fixture() {
    const [user, org, workspace, book, chapter, version, operation] = Array.from({ length: 7 }, () => randomUUID());
    await sql(`begin;
      insert into auth.users(id,email) values('${user}','${user}@local.test');
      insert into public.organizations(id,name,slug,owner_user_id) values('${org}','Synthetic','${org}','${user}');
      insert into public.workspaces(id,organization_id,name,slug,created_by) values('${workspace}','${org}','Synthetic','${workspace}','${user}');
      insert into public.workspace_members(workspace_id,user_id,role) values('${workspace}','${user}','owner');
      insert into public.books(id,workspace_id,title,author_name,created_by) values('${book}','${workspace}','Synthetic','Author','${user}');
      insert into public.chapters(id,book_id,order_index,title) values('${chapter}','${book}',0,'Synthetic');
      insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
        values('${version}','${chapter}',1,'{"schemaVersion":"1.0","nodes":[{"id":"n","type":"paragraph","text":"Synthetic"}]}','Synthetic',1,'${user}');
      update public.chapters set current_document_version_id='${version}' where id='${chapter}'; commit;`);
    const auth = `set local role authenticated; set local request.jwt.claims='{"sub":"${user}","role":"authenticated"}';`;
    return { chapter, version, operation, auth,
      call: name => `${auth} select public.${name}('${chapter}','${operation}','${version}',1);` };
  }
  async function race(first, second, rollback) {
    const holder = session(database, `restore_holder_${randomUUID().replaceAll('-', '')}`);
    holder.child.stdin.write(`begin; ${first} select 'RESTORE_LOCK_READY';\n`);
    await until(() => { assert.equal(holder.ended, false, holder.stderr); return holder.stdout.includes('RESTORE_LOCK_READY'); }, 'Restore holder did not reach barrier');
    const name = `restore_wait_${randomUUID().replaceAll('-', '')}`, waiter = session(database, name);
    waiter.child.stdin.end(`begin; ${second} commit;`);
    await until(async () => { assert.equal(waiter.ended, false, waiter.stderr); return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1'; }, 'Restore waiter did not block');
    holder.child.stdin.end(rollback ? 'rollback;' : 'commit;');
    const a = await holder.done, b = await waiter.done;
    assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
    return { first: parse(a.stdout), second: parse(b.stdout) };
  }
  for (const firstName of ['restore_chapter_version', 'close_chapter_restore_operation']) {
    for (const rollback of [false, true]) {
      const f = await fixture();
      const secondName = firstName === 'restore_chapter_version' ? 'close_chapter_restore_operation' : 'restore_chapter_version';
      const result = await race(f.call(firstName), f.call(secondName), rollback);
      const expected = (rollback ? secondName : firstName) === 'restore_chapter_version' ? 'saved' : 'closed';
      assert.equal(result.second.status, expected);
      if (!rollback) assert.deepEqual(result.first, result.second);
      const state = parse(await sql(`select jsonb_build_object('receipts',(select count(*) from public.chapter_restore_operations where chapter_id='${f.chapter}'),
        'versions',(select count(*) from public.document_versions where chapter_id='${f.chapter}'),
        'status',(select status from public.chapter_restore_operations where chapter_id='${f.chapter}'));`));
      assert.deepEqual(state, { receipts: 1, versions: expected === 'saved' ? 2 : 1, status: expected });
      console.log(`PASS native chapter restore ${firstName} ${rollback ? 'rollback takeover' : 'commit wins'}`);
    }
  }
}
