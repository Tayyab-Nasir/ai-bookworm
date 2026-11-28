/** Concurrent invitation schedules; only run against a disposable native PostgreSQL server. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const digest = () => createHash('sha256').update(randomUUID()).digest('hex');
const json = text => JSON.parse(text.split(/\r?\n/).find(line => line.startsWith('{')) ?? 'null');

export async function invitationRecoveryRaces({ sql, session, until, database }) {
  async function fixture() {
    const owner = randomUUID(), actor = randomUUID(), org = randomUUID(), workspace = randomUUID(), invitation = randomUUID();
    const token = digest(), alternate = digest(), email = `${actor}@invitation-race.local.test`;
    await sql(`insert into auth.users(id,email) values('${owner}','${owner}@invitation-race.local.test'),('${actor}','${email}');
      insert into public.organizations(id,name,slug,owner_user_id) values('${org}','Invitation race','${org}','${owner}');
      insert into public.workspaces(id,organization_id,name,slug,created_by) values('${workspace}','${org}','Invitation race','${workspace}','${owner}');
      insert into public.workspace_invitations(id,workspace_id,email,role,token_hash,status,expires_at,invited_by)
        values('${invitation}','${workspace}','${email}','writer','${token}','pending',clock_timestamp()+interval '7 days','${owner}');`);
    const auth = `set local role authenticated; set local request.jwt.claims='{"sub":"${actor}","role":"authenticated"}';`;
    return { owner, actor, workspace, invitation, token, alternate, auth };
  }
  async function lockedRace(first, second, rollback, during) {
    const holder = session(database, `invitation_holder_${randomUUID().replaceAll('-', '')}`);
    holder.child.stdin.write(`begin; ${first} select 'INVITATION_READY';\n`);
    await until(() => {
      assert.equal(holder.ended, false, holder.stderr);
      return holder.stdout.includes('INVITATION_READY');
    }, 'Invitation holder did not become ready');
    if (during) await during();
    const name = `invitation_wait_${randomUUID().replaceAll('-', '')}`;
    const contender = session(database, name);
    contender.child.stdin.end(`begin; ${second} commit;`);
    await until(async () => {
      assert.equal(contender.ended, false, `Invitation contender did not wait: ${contender.stderr}`);
      return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1';
    }, 'Expected an invitation row lock wait');
    holder.child.stdin.end(rollback ? 'rollback;\n' : 'commit;\n');
    const held = await holder.done;
    assert.equal(held.code, 0, held.stderr);
    return { held, contender: await contender.done };
  }

  for (const rollback of [false, true]) {
    const f = await fixture();
    const status = `${f.auth} select public.workspace_invitation_acceptance_status('${f.token}');`;
    const accept = `${f.auth} select public.accept_workspace_invitation('${f.token}');`;
    // The original API updated by id alone. The trigger must fence it after acceptance.
    const rotateOld = `set local role service_role; update public.workspace_invitations set token_hash='${f.alternate}',role='editor' where id='${f.invitation}';`;
    const result = await lockedRace(accept, rotateOld, rollback, async () => {
      assert.deepEqual(json(await sql(`begin; ${status} commit;`)), { viewerId: f.actor, state: 'not_confirmed' },
        'An uncommitted acceptance must not be reported as failed or complete');
    });
    if (rollback) {
      assert.equal(result.contender.code, 0, result.contender.stderr);
      assert.equal(await sql(`select token_hash from public.workspace_invitations where id='${f.invitation}';`), f.alternate);
      assert.equal(await sql(`select count(*) from public.workspace_members where workspace_id='${f.workspace}' and user_id='${f.actor}';`), '0');
    } else {
      assert.notEqual(result.contender.code, 0);
      assert.match(result.contender.stderr, /PT409[\s\S]*terminal invitation cannot be rotated/);
      assert.equal(await sql(`select token_hash from public.workspace_invitations where id='${f.invitation}';`), f.token);
      assert.deepEqual(json(await sql(`begin; ${status} commit;`)),
        { viewerId: f.actor, state: 'accepted', workspaceId: f.workspace, role: 'writer' });
    }
    console.log(`PASS invitation acceptance versus old rotation: ${rollback ? 'rollback releases pending link' : 'commit protects receipt'}`);
  }

  {
    const f = await fixture(), winner = digest(), loser = digest();
    const observed = await sql(`select updated_at::text from public.workspace_invitations where id='${f.invitation}';`);
    const rotate = hash => `set local role service_role; update public.workspace_invitations set token_hash='${hash}',updated_at=updated_at+interval '1 millisecond'
      where id='${f.invitation}' and status='pending' and updated_at='${observed}'::timestamptz returning token_hash;`;
    const result = await lockedRace(rotate(winner), rotate(loser), false);
    assert.equal(result.contender.code, 0, result.contender.stderr);
    assert.equal(result.contender.stdout.trim(), '', 'Stale conditional rotation unexpectedly matched');
    assert.equal(await sql(`select token_hash from public.workspace_invitations where id='${f.invitation}';`), winner);
    console.log('PASS competing conditional invitation rotations preserve exactly one link');
  }
}
