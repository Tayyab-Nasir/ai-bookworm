/** Only the explicit disposable native PostgreSQL runner calls this module. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export function moderationScheduleNames() {
  const names = [];
  for (const target of ["post", "comment"]) for (const holder of ["platform", "community"])
    for (const action of ["remove", "dismiss"]) for (const mode of ["commit", "rollback"])
      names.push(`${target} ${holder} ${action} ${mode}`);
  for (const first of ["revocation", "decision"]) for (const mode of ["commit", "rollback"])
    names.push(`membership ${first} ${mode}`);
  for (const target of ["comment","reaction"]) for (const boundary of ["parent","membership"])
    for (const first of ["change","write"]) for (const mode of ["commit","rollback"])
      names.push(`${target} ${boundary} ${first} ${mode}`);
  for (const mode of ["commit","rollback"]) names.push(`reaction toggle ${mode}`);
  return names;
}

export async function moderationResolutionRaces({ sql, session, until, database }) {
  async function fixture(target = "post") {
    const [owner, admin, community, post, comment, report] = Array.from({ length: 6 }, () => randomUUID());
    await sql(`insert into auth.users(id,email) values('${owner}','moderation-owner@local.test'),('${admin}','moderation-admin@local.test');
      insert into public.communities(id,owner_user_id,name,slug,visibility) values('${community}','${owner}','Native moderation','${community}','public');
      insert into public.community_members(community_id,user_id,role,status) values('${community}','${owner}','owner','active');
      insert into public.community_posts(id,community_id,author_id,body,status) values('${post}','${community}','${owner}','Fixture post','published');
      insert into public.community_comments(id,post_id,author_id,body) values('${comment}','${post}','${owner}','Fixture reply');
      insert into public.reports(id,reporter_id,entity_type,entity_id,reason) values('${report}','${owner}','${target}','${target === "post" ? post : comment}','Fixture report');`);
    const communityAuth = `set local role authenticated; set local request.jwt.claims='{"sub":"${owner}","role":"authenticated"}';`;
    const decision = (actor, action) => actor === "platform"
      ? `set local role service_role; select row_to_json(r) from public.admin_resolve_community_report('${report}','${action}','${admin}') r;`
      : `${communityAuth} select row_to_json(r) from public.moderate_community_report('${report}','${action}') r;`;
    return { owner, community, post, comment, report, target, decision,
      revoke: `update public.community_members set role='member' where community_id='${community}' and user_id='${owner}';` };
  }

  async function contention(first, second, rollback) {
    const held = session(database, `moderation_holder_${randomUUID().replaceAll("-", "")}`);
    held.child.stdin.write(`begin; ${first} select 'BOOKWORM_MODERATION_READY';\n`);
    await until(() => { assert.equal(held.ended, false, held.stderr); return held.stdout.includes("BOOKWORM_MODERATION_READY"); }, "Moderation holder not ready");
    const name = `moderation_wait_${randomUUID().replaceAll("-", "")}`;
    const contender = session(database, name);
    contender.child.stdin.end(`begin; ${second} commit;`);
    await until(async () => {
      assert.equal(contender.ended, false, `Moderation contender did not wait: ${contender.stderr}`);
      return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === "1";
    }, "Expected moderation PostgreSQL Lock wait");
    held.child.stdin.end(rollback ? "rollback;\n" : "commit;\n");
    assert.equal((await held.done).code, 0, held.stderr);
    return contender.done;
  }

  async function state(f, action) {
    const actual = JSON.parse(await sql(`select jsonb_build_object(
      'status',r.status,'action',r.resolution_action,
      'post',(select status from public.community_posts where id='${f.post}'),
      'comment',(select moderation_state from public.community_comments where id='${f.comment}'),
      'audits',(select count(*) from public.audit_logs where action='moderation.report.resolve' and entity_id='${f.report}'))
      from public.reports r where r.id='${f.report}';`));
    assert.deepEqual(actual, { status: !action ? "open" : action === "remove" ? "actioned" : "dismissed", action,
      post: f.target === "post" && action === "remove" ? "removed" : "published",
      comment: f.target === "comment" && action === "remove" ? "removed" : "visible", audits: action ? 1 : 0 });
  }

  for (const target of ["post", "comment"]) for (const holder of ["platform", "community"])
    for (const action of ["remove", "dismiss"]) for (const mode of ["commit", "rollback"]) {
      const f = await fixture(target);
      const other = action === "remove" ? "dismiss" : "remove";
      const result = await contention(f.decision(holder, action), f.decision(holder === "platform" ? "community" : "platform", other), mode === "rollback");
      assert.equal(result.code, 0, result.stderr);
      const expected = mode === "commit" ? action : other;
      assert.deepEqual(JSON.parse(result.stdout.trim()), { report_id: f.report,
        status: expected === "remove" ? "actioned" : "dismissed", resolution_action: expected, already_resolved: mode === "commit" });
      await state(f, expected);
      const replay = JSON.parse(await sql(`begin; ${f.decision("platform", expected === "remove" ? "dismiss" : "remove")} commit;`));
      assert.equal(replay.already_resolved, true);
      assert.equal(replay.resolution_action, expected);
      await state(f, expected);
      console.log(`PASS native moderation ${target} ${holder} ${action} ${mode}`);
    }

  for (const first of ["revocation", "decision"]) for (const mode of ["commit", "rollback"]) {
    const f = await fixture();
    const decision = f.decision("community", "remove");
    const result = await contention(first === "revocation" ? f.revoke : decision,
      first === "revocation" ? decision : f.revoke, mode === "rollback");
    if (first === "revocation" && mode === "commit") {
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /42501.*community moderator required/s);
    } else assert.equal(result.code, 0, result.stderr);
    await state(f, (first === "revocation" ? mode === "rollback" : mode === "commit") ? "remove" : null);
    console.log(`PASS native moderation membership ${first} ${mode}`);
  }

  for (const target of ["comment","reaction"]) for (const boundary of ["parent","membership"])
    for (const first of ["change","write"]) for (const mode of ["commit","rollback"]) {
      const f = await fixture();
      const write = target === "comment"
        ? `set local role service_role; insert into public.community_comments(post_id,author_id,body) values('${f.post}','${f.owner}','Concurrent reply');`
        : `set local role service_role; insert into public.community_post_reactions(post_id,user_id,kind) values('${f.post}','${f.owner}','like');`;
      const change = boundary === "parent"
        ? `update public.community_posts set status='removed' where id='${f.post}';`
        : `update public.community_members set status='suspended' where community_id='${f.community}' and user_id='${f.owner}';`;
      const result = await contention(first === "change" ? change : write, first === "change" ? write : change, mode === "rollback");
      const denied = first === "change" && mode === "commit";
      if (denied) { assert.notEqual(result.code,0); assert.match(result.stderr,/42501.*active discussion access required/s); }
      else assert.equal(result.code,0,result.stderr);
      const written = first === "write" ? mode === "commit" : mode === "rollback";
      const count = await sql(target === "comment"
        ? `select count(*) from public.community_comments where post_id='${f.post}' and body='Concurrent reply';`
        : `select count(*) from public.community_post_reactions where post_id='${f.post}' and user_id='${f.owner}';`);
      assert.equal(count,written ? "1" : "0");
      const changed = first === "write" || mode === "commit";
      assert.equal(await sql(boundary === "parent"
        ? `select status='removed' from public.community_posts where id='${f.post}';`
        : `select status='suspended' from public.community_members where community_id='${f.community}' and user_id='${f.owner}';`),changed ? "t" : "f");
      console.log(`PASS native moderation ${target} ${boundary} ${first} ${mode}`);
    }

  for (const mode of ["commit","rollback"]) {
    const f = await fixture();
    const toggle = `set local role authenticated; set local request.jwt.claims='{"sub":"${f.owner}","role":"authenticated"}'; select public.toggle_community_reaction('${f.post}','like');`;
    const result = await contention(toggle,toggle,mode === "rollback");
    assert.equal(result.code,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()),{ postId:f.post,kind:"like",active:mode === "rollback" });
    assert.equal(await sql(`select count(*) from public.community_post_reactions where post_id='${f.post}' and user_id='${f.owner}';`),mode === "rollback" ? "1" : "0");
    console.log(`PASS native moderation reaction toggle ${mode}`);
  }
}
