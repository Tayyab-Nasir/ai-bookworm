/** The disposable database runner owns these native PostgreSQL sessions. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { indexedResolveSql, passageHint } from '../ai-evals/evals/book-retrieval-citation-binding.mjs';

const literal = value => "'" + value.replaceAll("'", "''") + "'";

export async function retrievalCitationRaces({ sql, session, until, database }) {
  const [author, viewer, org, workspace, book, chapterA, chapterB, versionA, versionB] =
    Array.from({ length: 9 }, () => randomUUID());
  const original = "Elara carries an amethyst compass to the café. 🌙";
  const revised = "Elara carries a jade lantern.";
  const nodes = text => JSON.stringify({ schemaVersion: '1.0', nodes: [{ id: 'fact', type: 'paragraph', text }] });
  const auth = user => `set local role authenticated; set local request.jwt.claims = ${literal(JSON.stringify({ sub: user, role: 'authenticated' }))};`;

  await sql(`begin;
    insert into auth.users(id,email) values ('${author}','${author}@local.test'), ('${viewer}','${viewer}@local.test');
    insert into public.organizations(id,name,slug,owner_user_id) values ('${org}','Citation fixture','${org}','${author}');
    insert into public.workspaces(id,organization_id,name,slug,created_by) values
      ('${workspace}','${org}','Citation fixture','${workspace}','${author}');
    insert into public.workspace_members(workspace_id,user_id,role) values
      ('${workspace}','${author}','owner'), ('${workspace}','${viewer}','viewer');
    insert into public.books(id,workspace_id,title,author_name,created_by) values
      ('${book}','${workspace}','Two manuscript copies','Fixture author','${author}');
    insert into public.chapters(id,book_id,order_index,title) values
      ('${chapterA}','${book}',0,'Chapter A'), ('${chapterB}','${book}',1,'Chapter B');
    insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by) values
      ('${versionA}','${chapterA}',1,${literal(nodes(original))},${literal(original)},9,'${author}'),
      ('${versionB}','${chapterB}',1,${literal(nodes(original))},${literal(original)},9,'${author}');
    update public.chapters set current_document_version_id='${versionA}' where id='${chapterA}';
    update public.chapters set current_document_version_id='${versionB}' where id='${chapterB}';
  commit;`);

  const hint = passageHint(book, original);
  const resolve = async (user, candidate = hint) => JSON.parse(await sql(`begin;
    ${auth(user)}
    prepare resolve(uuid, text[], text[], integer) as
      select coalesce(json_agg(document_version_id order by title), '[]')
      from (${indexedResolveSql}) as citations;
    execute resolve('${book}', array[${literal(candidate.filename)}], array[${literal(candidate.excerpt)}], 8);
  commit;`));

  assert.deepEqual(await resolve(viewer), [versionA, versionB]);
  for (const [chapter, before, after] of [
    [chapterA, [versionA, versionB], [versionB]],
    [chapterB, [versionB], []],
  ]) {
    const writer = session(database, `citation_writer_${randomUUID().replaceAll('-', '')}`);
    writer.child.stdin.write(`begin; ${auth(author)}
      select id from public.append_chapter_version(
        '${chapter}',1,${literal(nodes(revised))},${literal(revised)},5,'Native citation fixture','${randomUUID()}'
      );
      select 'CITATION_EDIT_READY';\n`);
    await until(() => {
      assert.equal(writer.ended, false, writer.stderr);
      return writer.stdout.includes('CITATION_EDIT_READY');
    }, 'Citation writer did not reach its commit barrier');
    assert.deepEqual(await resolve(viewer), before, 'an uncommitted edit cannot change a reader citation');
    writer.child.stdin.end('commit;\n');
    assert.equal((await writer.done).code, 0, writer.stderr);
    assert.deepEqual(await resolve(viewer), after, 'a fresh lookup must omit versions superseded by the commit');
  }

  const revisedHint = passageHint(book, revised);
  const current = await resolve(viewer, revisedHint);
  assert.equal(current.length, 2);
  assert(!current.includes(versionA) && !current.includes(versionB));
  const revoke = session(database, `citation_revoke_${randomUUID().replaceAll('-', '')}`);
  revoke.child.stdin.write(`begin;
    delete from public.workspace_members where workspace_id='${workspace}' and user_id='${viewer}';
    select 'CITATION_REVOKE_READY';\n`);
  await until(() => {
    assert.equal(revoke.ended, false, revoke.stderr);
    return revoke.stdout.includes('CITATION_REVOKE_READY');
  }, 'Membership revocation did not reach its commit barrier');
  assert.deepEqual(await resolve(viewer, revisedHint), current);
  revoke.child.stdin.end('commit;\n');
  assert.equal((await revoke.done).code, 0, revoke.stderr);
  assert.deepEqual(await resolve(viewer, revisedHint), [], 'a delayed hint cannot bypass committed revocation');
  assert.deepEqual(await resolve(author, revisedHint), current);
  console.log('PASS native citation resolution across concurrent chapter edits and membership revocation');
}
