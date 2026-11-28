/** Native PostgreSQL tests for chapter creation and close fencing. Synthetic data only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function chapterCreationRecoveryRaces({ sql, session, until, database }) {
  async function fixture() {
    const [actor, organization, workspace, book, request] = Array.from({ length: 5 }, () => randomUUID());
    await sql(`
      insert into auth.users(id,email) values ('${actor}','${actor}@local.test');
      insert into public.organizations(id,name,slug,owner_user_id) values ('${organization}','Fixture','${organization}','${actor}');
      insert into public.workspaces(id,organization_id,name,slug,created_by) values ('${workspace}','${organization}','Fixture','${workspace}','${actor}');
      insert into public.workspace_members(workspace_id,user_id,role,status) values ('${workspace}','${actor}','owner','active');
      insert into public.books(id,workspace_id,title,author_name,created_by) values ('${book}','${workspace}','Fixture','Author','${actor}');
    `);
    const auth = `set local role authenticated; set local request.jwt.claims='{"sub":"${actor}"}';`;
    return {
      book, actor, request,
      create: `${auth} select id from public.create_book_chapter_once('${book}','Original',null,'${request}');`,
      close: `${auth} select public.chapter_creation_status('${book}','${request}',true);`,
    };
  }

  for (const first of ["create", "close"]) for (const rollback of [false, true]) {
    const f = await fixture();
    const holder = session(database, `chapter_hold_${randomUUID().replaceAll("-", "")}`);
    holder.child.stdin.write(`begin; ${f[first]} select 'CHAPTER_READY';\n`);
    await until(() => {
      assert.equal(holder.ended, false, holder.stderr);
      return holder.stdout.includes("CHAPTER_READY");
    }, "Chapter holder did not reach the barrier");
    const name = `chapter_wait_${randomUUID().replaceAll("-", "")}`;
    const waiter = session(database, name);
    const second = first === "create" ? "close" : "create";
    waiter.child.stdin.end(`begin; ${f[second]} commit;`);
    await until(async () => {
      assert.equal(waiter.ended, false, waiter.stderr);
      return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === "1";
    }, "Chapter waiter did not block");
    holder.child.stdin.end(rollback ? "rollback;" : "commit;");
    const [held, waited] = await Promise.all([holder.done, waiter.done]);
    assert.equal(held.code, 0, held.stderr);
    const closed = first === "close" ? !rollback : rollback;
    if (closed && second === "create") {
      assert.notEqual(waited.code, 0);
      assert.match(waited.stderr, /PT409/);
    } else assert.equal(waited.code, 0, waited.stderr);
    assert.equal(await sql(`select count(*) from public.chapter_creation_requests where book_id='${f.book}' and actor_id='${f.actor}' and request_key='${f.request}' and closed;`), closed ? "1" : "0");
    assert.equal(await sql(`select count(*) from public.chapters where book_id='${f.book}';`), closed ? "0" : "1");
    console.log(`PASS native chapter creation ${first} ${rollback ? "rollback takeover" : "commit wins"}`);
  }
  for (const rollback of [false, true]) {
    const f = await fixture();
    const holder = session(database, `chapter_create_hold_${randomUUID().replaceAll("-", "")}`);
    holder.child.stdin.write(`begin; ${f.create} select 'CHAPTER_READY';\n`);
    await until(() => {
      assert.equal(holder.ended, false, holder.stderr);
      return holder.stdout.includes("CHAPTER_READY");
    }, "First chapter creation did not reach the barrier");
    const name = `chapter_create_wait_${randomUUID().replaceAll("-", "")}`;
    const waiter = session(database, name);
    waiter.child.stdin.end(`begin; ${f.create} commit;`);
    await until(async () => {
      assert.equal(waiter.ended, false, waiter.stderr);
      return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === "1";
    }, "Second chapter creation did not block");
    holder.child.stdin.end(rollback ? "rollback;" : "commit;");
    const [held, waited] = await Promise.all([holder.done, waiter.done]);
    assert.equal(held.code, 0, held.stderr);
    assert.equal(waited.code, 0, waited.stderr);
    assert.equal(await sql(`select count(*) from public.chapters where book_id='${f.book}';`), "1");
    assert.equal(await sql(`select count(*) from public.chapter_creation_requests where book_id='${f.book}' and actor_id='${f.actor}' and request_key='${f.request}' and not closed;`), "1");
    if (!rollback) {
      const heldId = held.stdout.trim().split(/\s+/)[0];
      const waitedId = waited.stdout.trim().split(/\s+/)[0];
      assert.equal(waitedId, heldId, "Concurrent replay must return the original chapter");
    }
    console.log(`PASS native chapter replay ${rollback ? "rollback takeover" : "same receipt"}`);
  }
}
