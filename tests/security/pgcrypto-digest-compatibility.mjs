/** Namespace matrix and fail-closed DDL checks; in-memory PostgreSQL only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

assert.equal(process.argv.length, 2, 'No connection URLs or operator options accepted');
const migration = await readFile(new URL('../../supabase/migrations/20260912175000_pgcrypto_digest_compatibility.sql', import.meta.url), 'utf8');
const assertions = await readFile(new URL('./pgcrypto-digest-compatibility.test.sql', import.meta.url), 'utf8');
for (const schema of ['public', 'extensions', 'crypto fixture']) {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      ${schema === 'public' ? '' : `create schema "${schema}";`}
      create extension pgcrypto with schema "${schema}";
      grant usage on schema "${schema}" to authenticated,service_role;`);
    const before = (await db.query(`select p.oid,p.proacl,pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=$1 and p.proname='digest' order by p.oid`, [schema])).rows;
    if (schema !== 'public') {
      // The bytea bridge is created first. A text-overload collision must roll
      // that first DDL back, without replacing the unrelated operator function.
      await db.exec(`begin; create function public.digest(text,text) returns bytea
        language sql as 'select decode(''00'',''hex'')'; savepoint before_bridge;`);
      await assert.rejects(db.exec(migration), /refuses a pre-existing public.digest overload/);
      await db.exec('rollback to savepoint before_bridge;');
      assert.equal((await db.query("select to_regprocedure('public.digest(bytea,text)') as value")).rows[0].value, null);
      assert.equal((await db.query("select encode(public.digest('x','sha256'),'hex') as value")).rows[0].value, '00');
      await db.exec('rollback;');
      await db.exec(`begin; revoke usage on schema "${schema}" from authenticated; savepoint before_bridge;`);
      await assert.rejects(db.exec(migration), /requires existing application access/);
      await db.exec('rollback to savepoint before_bridge;');
      assert.equal((await db.query("select to_regprocedure('public.digest(bytea,text)') as value")).rows[0].value, null);
      await db.exec('rollback;');
    }
    await db.exec(`begin; ${migration} commit;`);
    await db.exec(assertions);
    const text = 'Captain Mira — café\n\tHarbor 🐛';
    const digest = (await db.query("select encode(public.digest($1,'sha256'),'hex') as value", [text])).rows[0].value;
    assert.equal(digest, createHash('sha256').update(text).digest('hex'), 'UTF-8 identity must not change');
    assert.deepEqual((await db.query(`select p.oid,p.proacl,pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=$1 and p.proname='digest' order by p.oid`, [schema])).rows, before,
    'Extension-owned functions and grants must remain untouched');
    console.log(`PASS pgcrypto ${schema}: bytea/text/Unicode parity, invoker grants, extension preservation${schema === 'public' ? '' : ', collision/access guards and atomic rollback'}`);
  } finally { await db.close(); }
}
