/** Real lock schedules, called only by the disposable native PostgreSQL runner. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const output = text => JSON.parse(text.split('\n').find(line => line.startsWith('{')) ?? 'null');

export async function workspaceCreationReceiptRaces({ sql, session, until, database }) {
  async function fixture() {
    const actor = randomUUID(), operation = randomUUID();
    await sql(`insert into auth.users(id,email) values('${actor}','${actor}@workspace-race.local.test');`);
    const auth = `set local role authenticated; set local request.jwt.claims='{"sub":"${actor}","role":"authenticated"}';`;
    const create = name => `${auth} select row_to_json(w) from public.create_workspace_with_receipt('${operation}','${name}') w;`;
    const close = `${auth} select public.workspace_creation_receipt('${operation}',true);`;
    const check = `${auth} select public.workspace_creation_receipt('${operation}',false);`;
    return { actor, operation, create, close, check };
  }

  async function contention(first, second, rollback = false, during) {
    const held = session(database, `workspace_holder_${randomUUID().replaceAll('-', '')}`);
    held.child.stdin.write(`begin; ${first} select 'WORKSPACE_RECEIPT_READY';\n`);
    await until(() => {
      assert.equal(held.ended, false, held.stderr);
      return held.stdout.includes('WORKSPACE_RECEIPT_READY');
    }, 'Workspace receipt holder did not become ready');
    if (during) await during();
    const name = `workspace_wait_${randomUUID().replaceAll('-', '')}`;
    const contender = session(database, name);
    contender.child.stdin.end(`begin; ${second} commit;`);
    await until(async () => {
      assert.equal(contender.ended, false, `Workspace contender did not wait: ${contender.stderr}`);
      return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1';
    }, 'Expected workspace receipt lock wait');
    held.child.stdin.end(rollback ? 'rollback;\n' : 'commit;\n');
    assert.equal((await held.done).code, 0, held.stderr);
    return { first: output(held.stdout), second: await contender.done };
  }

  async function counts(f, expectedWorkspaces, expectedReceipts) {
    assert.equal(await sql(`select count(*) from public.workspaces where created_by='${f.actor}';`), String(expectedWorkspaces));
    assert.equal(await sql(`select count(*) from public.organizations where owner_user_id='${f.actor}';`), String(expectedWorkspaces));
    assert.equal(await sql(`select count(*) from bookworm_private.workspace_creation_receipts where actor_id='${f.actor}';`), String(expectedReceipts));
  }

  for (const rollback of [false, true]) {
    const f = await fixture();
    const race = await contention(f.create('Race studio'), f.create('Race studio'), rollback, async () => {
      const receipt = output(await sql(`begin; ${f.check} commit;`));
      assert.equal(receipt.status, 'not_found', 'An uncommitted create must remain unconfirmed');
    });
    assert.equal(race.second.code, 0, race.second.stderr);
    const second = output(race.second.stdout);
    if (rollback) assert.notEqual(second.id, race.first.id);
    else assert.equal(second.id, race.first.id);
    await counts(f, 1, 1);
  }
  console.log('PASS workspace creation concurrent replay and rollback');

  {
    const f = await fixture(), race = await contention(f.create('Committed studio'), f.close);
    assert.equal(race.second.code, 0, race.second.stderr);
    const receipt = output(race.second.stdout);
    assert.equal(receipt.status, 'created'); assert.equal(receipt.workspaceId, race.first.id);
    await counts(f, 1, 1);
  }
  console.log('PASS workspace close waits for committed creation');

  for (const rollback of [false, true]) {
    const f = await fixture(), race = await contention(f.close, f.create('Delayed studio'), rollback);
    if (rollback) {
      assert.equal(race.second.code, 0, race.second.stderr);
      await counts(f, 1, 1);
    } else {
      assert.notEqual(race.second.code, 0); assert.match(race.second.stderr, /PT409[\s\S]*workspace request is closed or differs/);
      await counts(f, 0, 1);
    }
  }
  console.log('PASS workspace close fences delayed creation and rollback releases it');

  {
    const f = await fixture(), race = await contention(f.create('Original studio'), f.create('Different studio'));
    assert.notEqual(race.second.code, 0); assert.match(race.second.stderr, /PT409[\s\S]*workspace request is closed or differs/);
    await counts(f, 1, 1);
  }
  console.log('PASS workspace operation rejects concurrent changed details');
}
