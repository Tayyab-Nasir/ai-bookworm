/** Only the explicit, disposable native PostgreSQL runner calls this module. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const body = name => ({ type: "fact", name });
const output = text => JSON.parse(text.split("\n").find(line => line.startsWith("{")) ?? "null");

export async function manualBookBibleRecoveryRaces({ sql, session, until, database }) {
  async function fixture() {
    const [actor, org, workspace, book] = Array.from({ length: 4 }, () => randomUUID());
    await sql(`insert into auth.users(id,email) values('${actor}','manual-bible-native@local.test');
      insert into public.organizations(id,name,slug,owner_user_id) values('${org}','Manual Bible','${org}','${actor}');
      insert into public.workspaces(id,organization_id,name,slug,created_by) values('${workspace}','${org}','Manual Bible','${workspace}','${actor}');
      insert into public.workspace_members(workspace_id,user_id,role,status) values('${workspace}','${actor}','editor','active');
      insert into public.books(id,workspace_id,title,author_name,created_by) values('${book}','${workspace}','Native manual canon','Author','${actor}');`);
    const auth = `set local role authenticated; set local request.jwt.claims='{"sub":"${actor}","role":"authenticated"}';`;
    const create = (request, fields = body("Original"), targetBook = book) =>
      `${auth} select public.mutate_book_bible_item('${targetBook}','${request}','create',p_body=>${json(fields)});`;
    const mutate = (request, action, item, updatedAt, fields = null, expectedIncarnationId = null) =>
      `${auth} select public.mutate_book_bible_item('${book}','${request}','${action}','${item}',${literal(updatedAt)},${fields === null ? "null" : json(fields)},${expectedIncarnationId === null ? "null" : literal(expectedIncarnationId)});`;
    const recover = request => `${auth} select public.recover_book_bible_mutation('${book}','${request}');`;
    const close = request => `${auth} select public.close_book_bible_mutation('${book}','${request}');`;
    const revoke = `update public.workspace_members set role='viewer' where workspace_id='${workspace}' and user_id='${actor}';`;
    return { actor, org, workspace, book, auth, create, mutate, recover, close, revoke };
  }

  // Assert an actual PostgreSQL Lock wait before releasing the first connection;
  // concurrent promises without this fence would not prove a race schedule.
  async function contention(first, second, rollback = false) {
    const held = session(database, `manual_bible_holder_${randomUUID().replaceAll("-", "")}`);
    held.child.stdin.write(`begin; ${first} select 'BOOKWORM_MANUAL_BIBLE_READY';\n`);
    await until(() => {
      assert.equal(held.ended, false, held.stderr);
      return held.stdout.includes("BOOKWORM_MANUAL_BIBLE_READY");
    }, "Manual Book Bible holder did not become ready");
    const name = `manual_bible_wait_${randomUUID().replaceAll("-", "")}`;
    const contender = session(database, name);
    contender.child.stdin.end(`begin; ${second} commit;`);
    await until(async () => {
      assert.equal(contender.ended, false, `Manual Book Bible contender did not wait: ${contender.stderr}`);
      return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === "1";
    }, "Expected manual Book Bible PostgreSQL Lock wait");
    held.child.stdin.end(rollback ? "rollback;\n" : "commit;\n");
    assert.equal((await held.done).code, 0, held.stderr);
    return { first: output(held.stdout), second: await contender.done };
  }

  const success = result => { assert.equal(result.code, 0, result.stderr); return output(result.stdout); };
  const denied = (result, code, message) => {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, new RegExp(`${code}.*${message}`, "s"));
  };
  async function state(f, entries, receipts) {
    assert.equal(await sql(`select count(*) from public.book_bible_items where book_id='${f.book}';`), String(entries));
    assert.equal(await sql(`select count(*) from bookworm_private.book_bible_mutation_receipts where book_id='${f.book}';`), String(receipts));
  }
  const log = name => console.log(`PASS native manual Book Bible ${name}`);
  const emptyResult = { receipt: null, disposition: null, item: null, replayed: false, closed: false, closure: null };
  function assertClosed(r, f, request) {
    const { closure, ...envelope } = r;
    assert.deepEqual(envelope, { receipt: null, disposition: null, item: null, replayed: false, closed: true });
    assert.deepEqual(Object.keys(closure).sort(), ["bookId", "closedAt", "requestId"]);
    assert.equal(closure.requestId, request); assert.equal(closure.bookId, f.book);
    assert.ok(Number.isFinite(Date.parse(closure.closedAt)));
  }

  for (const rollback of [false, true]) {
    const f = await fixture(), request = randomUUID();
    const race = await contention(f.create(request), f.create(request), rollback);
    const r = success(race.second);
    assert.equal(r.replayed, !rollback);
    assert.equal(r.disposition, "unchanged");
    assert.equal(r.item.id, r.receipt.itemId);
    assert.equal(r.item.name, "Original");
    if (!rollback) assert.deepEqual(r.receipt, race.first.receipt);
    else assert.notEqual(r.receipt.itemId, race.first.receipt.itemId);
    await state(f, 1, 1);
    log(`simultaneous create ${rollback ? "rollback" : "commit replay"}`);
  }

  for (const action of ["update", "delete"]) for (const rollback of [false, true]) {
    const f = await fixture(), request = randomUUID();
    const initial = output(await sql(`begin; ${f.create(randomUUID())} commit;`));
    const call = f.mutate(request, action, initial.item.id, initial.item.updated_at,
      action === "update" ? body("Updated once") : null, initial.item.mutation_incarnation_id);
    const race = await contention(call, call, rollback);
    const r = success(race.second);
    assert.equal(r.replayed, !rollback);
    assert.equal(r.disposition, action === "delete" ? "deleted" : "unchanged");
    assert.equal(r.receipt.itemId, initial.item.id);
    if (action === "update") {
      assert.equal(r.item.name, "Updated once");
      assert.equal(r.item.mutation_incarnation_id, initial.item.mutation_incarnation_id);
    } else assert.equal(r.item, null);
    if (!rollback) assert.deepEqual(r.receipt, race.first.receipt);
    await state(f, action === "delete" ? 0 : 1, 2);
    log(`simultaneous ${action} ${rollback ? "rollback" : "commit replay"}`);
  }

  // Different books cannot bypass an actor-global request lease.
  for (const rollback of [false, true]) {
    const f = await fixture(), request = randomUUID(), otherBook = randomUUID();
    await sql(`insert into public.books(id,workspace_id,title,author_name,created_by) values('${otherBook}','${f.workspace}','Other','Author','${f.actor}');`);
    const race = await contention(f.create(request), f.create(request, body("Other intent"), otherBook), rollback);
    if (rollback) {
      const r = success(race.second); assert.equal(r.replayed, false); assert.equal(r.receipt.bookId, otherBook);
      await state(f, 0, 0);
    } else { denied(race.second, "40001", "different intent"); await state(f, 1, 1); }
    assert.equal(await sql(`select count(*) from bookworm_private.book_bible_mutation_receipts where actor_id='${f.actor}' and request_id='${request}';`), "1");
    log(`actor-global lease ${rollback ? "rollback" : "intent mismatch"}`);
  }

  for (const rollback of [false, true]) {
    const f = await fixture(), initial = success({ code: 0, stdout: await sql(`begin; ${f.create(randomUUID())} commit;`) });
    const firstRequest = randomUUID(), secondRequest = randomUUID();
    const race = await contention(f.mutate(firstRequest, "update", initial.item.id, initial.item.updated_at, body("First"), initial.item.mutation_incarnation_id),
      f.mutate(secondRequest, "update", initial.item.id, initial.item.updated_at, body("Second"), initial.item.mutation_incarnation_id), rollback);
    assert.equal(race.first.disposition, "unchanged");
    assert.equal(race.first.item.name, "First");
    if (rollback) { const r = success(race.second); assert.equal(r.item.name, "Second"); assert.equal(r.disposition, "unchanged"); }
    else denied(race.second, "40001", "changed or was removed");
    assert.equal(await sql(`select name from public.book_bible_items where id='${initial.item.id}';`), rollback ? "Second" : "First");
    await state(f, 1, 2);
    log(`competing target revision ${rollback ? "rollback" : "commit"}`);
  }

  for (const first of ["revocation", "mutation"]) for (const rollback of [false, true]) {
    const f = await fixture(), request = randomUUID();
    const race = await contention(first === "revocation" ? f.revoke : f.create(request),
      first === "revocation" ? f.create(request) : f.revoke, rollback);
    if (first === "revocation" && !rollback) denied(race.second, "42501", "Active Book Bible editor required");
    else assert.equal(race.second.code, 0, race.second.stderr);
    const committed = first === "mutation" ? !rollback : rollback;
    await state(f, committed ? 1 : 0, committed ? 1 : 0);
    if (first === "mutation") {
      const read = session(database); read.child.stdin.end(`begin; ${f.recover(request)} commit;`);
      denied(await read.done, "42501", "Active Book Bible editor required");
    }
    log(`membership ${first} first ${rollback ? "rollback" : "commit"}`);
  }

  // Recovery reads take their own active-membership lock and cannot leak evidence
  // after a revoker wins. Conversely, a successful read may finish before revoke.
  for (const first of ["revocation", "recovery"]) for (const rollback of [false, true]) {
    const f = await fixture(), request = randomUUID();
    const original = output(await sql(`begin; ${f.create(request)} commit;`));
    const race = await contention(first === "revocation" ? f.revoke : f.recover(request),
      first === "revocation" ? f.recover(request) : f.revoke, rollback);
    if (first === "revocation" && !rollback) denied(race.second, "42501", "Active Book Bible editor required");
    else if (first === "revocation") {
      const r = success(race.second); assert.deepEqual(r.receipt, original.receipt); assert.equal(r.disposition, "unchanged");
    } else { assert.equal(race.second.code, 0, race.second.stderr); assert.deepEqual(race.first.receipt, original.receipt); }
    await state(f, 1, 1);
    log(`recovery permission ${first} first ${rollback ? "rollback" : "commit"}`);
  }

  for (const rollback of [false, true]) {
    const f = await fixture(), request = randomUUID();
    const race = await contention(f.create(request), f.recover(request), rollback);
    const r = success(race.second);
    if (rollback) assert.deepEqual(r, emptyResult);
    else { assert.deepEqual(r.receipt, race.first.receipt); assert.equal(r.disposition, "unchanged"); assert.equal(r.item.id, race.first.item.id); }
    await state(f, rollback ? 0 : 1, rollback ? 0 : 1);
    log(`recovery waits for mutation ${rollback ? "rollback" : "commit"}`);
  }

  for (const first of ["closure", "mutation"]) for (const rollback of [false, true]) {
    const f = await fixture(), request = randomUUID();
    const race = await contention(first === "closure" ? f.close(request) : f.create(request),
      first === "closure" ? f.create(request) : f.close(request), rollback);
    const closed = first === "closure" ? !rollback : rollback;
    if (first === "closure" && !rollback) denied(race.second, "55000", "permanently closed");
    else {
      const r = success(race.second);
      assert.equal(r.closed, closed);
      if (!closed) assert.equal(r.disposition, "unchanged");
      if (first === "mutation" && !rollback) assert.deepEqual(r.receipt, race.first.receipt);
    }
    await state(f, closed ? 0 : 1, closed ? 0 : 1);
    assert.equal(await sql(`select count(*) from bookworm_private.book_bible_request_closures where actor_id='${f.actor}' and request_id='${request}';`), closed ? "1" : "0");
    const recovered = output(await sql(`begin; ${f.recover(request)} commit;`));
    assert.equal(recovered.closed, closed);
    if (closed) {
      assertClosed(recovered, f, request);
      const late = session(database); late.child.stdin.end(`begin; ${f.create(request)} commit;`);
      denied(await late.done, "55000", "permanently closed");
    }
    log(`closure versus ${first} first ${rollback ? "rollback" : "commit"}`);
  }
  for (const rollback of [false, true]) {
    const f = await fixture(), request = randomUUID();
    const race = await contention(f.close(request), f.close(request), rollback);
    const r = success(race.second);
    assertClosed(r, f, request);
    if (!rollback) assert.deepEqual(r.closure, race.first.closure);
    await state(f, 0, 0);
    assert.equal(await sql(`select count(*) from bookworm_private.book_bible_request_closures where book_id='${f.book}';`), "1");
    log(`simultaneous closure ${rollback ? "rollback" : "commit"}`);
  }
  for (const rollback of [false, true]) {
    const f = await fixture(), request = randomUUID();
    const race = await contention(f.close(request), f.recover(request), rollback);
    const r = success(race.second);
    if (rollback) assert.deepEqual(r, emptyResult);
    else { assertClosed(r, f, request); assert.deepEqual(r.closure, race.first.closure); }
    await state(f, 0, 0);
    log(`read waits for closure ${rollback ? "rollback" : "commit"}`);
  }
  for (const first of ["revocation", "closure"]) for (const rollback of [false, true]) {
    const f = await fixture(), request = randomUUID();
    const race = await contention(first === "revocation" ? f.revoke : f.close(request),
      first === "revocation" ? f.close(request) : f.revoke, rollback);
    if (first === "revocation" && !rollback) denied(race.second, "42501", "Active Book Bible editor required");
    else assert.equal(race.second.code, 0, race.second.stderr);
    const closed = first === "closure" ? !rollback : rollback;
    assert.equal(await sql(`select count(*) from bookworm_private.book_bible_request_closures where book_id='${f.book}';`), closed ? "1" : "0");
    await state(f, 0, 0);
    log(`closure permission ${first} first ${rollback ? "rollback" : "commit"}`);
  }
  for (const isolation of ["repeatable read", "serializable"]) for (const action of ["create", "recover", "close"]) {
    const f = await fixture(), request = randomUUID();
    const guarded = session(database);
    const call = action === "create" ? f.create(request) : action === "recover" ? f.recover(request) : f.close(request);
    guarded.child.stdin.end(`begin isolation level ${isolation}; ${call} commit;`);
    denied(await guarded.done, "0A000", "requires READ COMMITTED transport");
    await state(f, 0, 0);
    assert.equal(await sql(`select count(*) from bookworm_private.book_bible_request_closures where book_id='${f.book}';`), "0");
    log(`reject stronger ${isolation} ${action} before any canon or closure write`);
  }

  // A VOLATILE result helper must use a fresh snapshot after the book lock wait,
  // including direct canon CRUD that intentionally has no new manual receipt.
  for (const action of ["update", "delete"]) for (const rollback of [false, true]) {
    const f = await fixture(), request = randomUUID();
    const original = output(await sql(`begin; ${f.create(request)} commit;`));
    const direct = action === "update"
      ? `update public.book_bible_items set name='Latest direct canon' where id='${original.item.id}';`
      : `delete from public.book_bible_items where id='${original.item.id}';`;
    const race = await contention(`select id from public.books where id='${f.book}' for update; ${direct}`, f.create(request), rollback);
    const r = success(race.second);
    assert.deepEqual(r.receipt, original.receipt); assert.equal(r.replayed, true);
    assert.equal(r.disposition, rollback ? "unchanged" : action === "update" ? "changed" : "deleted");
    assert.equal(r.item?.name ?? null, rollback ? "Original" : action === "update" ? "Latest direct canon" : null);
    await state(f, action === "delete" && !rollback ? 0 : 1, 1);
    log(`post-wait direct ${action} ${rollback ? "rollback" : "commit"}`);
  }

  // Direct legacy writers cannot preserve a revision by omitting/spoofing its
  // timestamp; an exact copied row cannot preserve its server incarnation.
  // These are first writes with a NEW request UUID, not receipt replays.
  for (const boundary of ["edit", "recreation"]) for (const action of ["update", "delete"]) for (const rollback of [false, true]) {
    const f = await fixture(), request = randomUUID();
    const original = output(await sql(`begin; ${f.create(randomUUID())} commit;`));
    const direct = boundary === "edit"
      ? `update public.book_bible_items set name='Latest legacy edit',updated_at=${literal(original.item.updated_at)} where id='${original.item.id}';`
      : `delete from public.book_bible_items where id='${original.item.id}';
         insert into public.book_bible_items select (pg_catalog.jsonb_populate_record(null::public.book_bible_items,${json(original.item)})).*;`;
    const fields = action === "update" ? body("Explicit stale intent") : null;
    const race = await contention(`${direct} select pg_catalog.to_jsonb(b) from public.book_bible_items b where id='${original.item.id}';`,
      f.mutate(request, action, original.item.id, original.item.updated_at, fields, original.item.mutation_incarnation_id), rollback);
    assert.notEqual(race.first.updated_at, original.item.updated_at, "A direct writer retained the old timestamp");
    if (boundary === "edit") assert.equal(race.first.mutation_incarnation_id, original.item.mutation_incarnation_id);
    else assert.notEqual(race.first.mutation_incarnation_id, original.item.mutation_incarnation_id, "Copied insert retained the old incarnation");
    if (rollback) {
      const r = success(race.second);
      assert.equal(r.disposition, action === "delete" ? "deleted" : "unchanged");
      assert.equal(r.item?.name ?? null, action === "delete" ? null : "Explicit stale intent");
    } else {
      denied(race.second, "40001", "changed or was removed");
      assert.equal(await sql(`select name from public.book_bible_items where id='${original.item.id}';`),
        boundary === "edit" ? "Latest legacy edit" : "Original");
      if (boundary === "recreation") {
        // Matching the NEW row's timestamp must not bypass a stale incarnation.
        const staleIdentity = session(database);
        staleIdentity.child.stdin.end(`begin; ${f.mutate(randomUUID(), action, original.item.id,
          race.first.updated_at, fields, original.item.mutation_incarnation_id)} commit;`);
        denied(await staleIdentity.done, "40001", "changed or was removed");
      }
    }
    await state(f, rollback && action === "delete" ? 0 : 1, rollback ? 2 : 1);
    log(`first-write CAS direct ${boundary} ${action} ${rollback ? "rollback" : "commit"}`);
  }

  // Fault injection is isolated to this fresh test database and request. It
  // proves that canon, its retrieval side effects and receipt share a rollback.
  {
    const f = await fixture(), request = randomUUID(), suffix = randomUUID().replaceAll("-", "");
    const fn = `bookworm_private.test_manual_receipt_${suffix}`, trigger = `test_manual_receipt_${suffix}`;
    await sql(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'synthetic receipt failure' using errcode='23514'; end $$;
      create trigger ${trigger} before insert on bookworm_private.book_bible_mutation_receipts for each row
      when(new.request_id='${request}'::uuid) execute function ${fn}();`);
    try {
      const race = await contention(`select id from public.books where id='${f.book}' for update;`, f.create(request));
      denied(race.second, "23514", "synthetic receipt failure");
      await state(f, 0, 0);
      const r = output(await sql(`begin; ${f.recover(request)} commit;`));
      assert.equal(r.receipt, null);
    } finally { await sql(`drop trigger ${trigger} on bookworm_private.book_bible_mutation_receipts; drop function ${fn}();`); }
    const r = output(await sql(`begin; ${f.create(request)} commit;`));
    assert.equal(r.replayed, false); assert.equal(r.disposition, "unchanged"); await state(f, 1, 1);
    log("receipt failure atomic rollback and original-key retry");
  }

  async function imageFixture(f) {
    const image = randomUUID(), version = randomUUID();
    await sql(`begin; set local request.jwt.claim.role='service_role';
      insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by)
        values('${image}','${f.workspace}','image','Cleared','native/${image}.png','image/png',128,repeat('a',64),'${f.actor}');
      insert into public.asset_versions(id,asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
        values('${version}','${image}',1,'native/${image}.png',repeat('a',64),'image/png',128,'${f.actor}'); commit;`);
    return { image, version, fields: { ...body("Image canon"), imageAssetIds: [image] } };
  }

  async function lateVersionSelection(boundary, rollback) {
    const f = await fixture(), request = randomUUID(), version = randomUUID();
    const suffix = randomUUID().replaceAll("-", "");
    const originalSignature = "public.mutate_book_bible_item(uuid,uuid,text,uuid,timestamptz,jsonb,uuid)";
    const clone = `public.test_manual_bible_late_${suffix}`;
    const cloneSignature = `${clone}(uuid,uuid,text,uuid,timestamptz,jsonb,uuid)`;
    const fence = `pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-late-bible-${suffix}',0))`;
    const handles = [];
    let installed = false, originalDefinition;
    try {
      let fields, insert, remove;
      if (boundary === "image") {
        const image = randomUUID();
        // No version exists yet. Service insertion takes only FK key-share,
        // compatible with the asset SHARE lock held by the paused mutation.
        await sql(`begin; set local request.jwt.claim.role='service_role';
          insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by)
            values('${image}','${f.workspace}','image','Late cleared','native/${image}.png','image/png',128,repeat('a',64),'${f.actor}'); commit;`);
        fields = { ...body("Late image canon"), imageAssetIds: [image] };
        insert = `begin; set local request.jwt.claim.role='service_role';
          insert into public.asset_versions(id,asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
            values('${version}','${image}',1,'native/${image}.png',repeat('a',64),'image/png',128,'${f.actor}'); commit;`;
        remove = `delete from public.asset_versions where id='${version}';`;
      } else {
        const chapter = await sql(`begin; ${f.auth} select id from public.create_book_chapters('${f.book}',
          '[{"title":"Late evidence","nodes":[{"id":"n1","type":"paragraph","text":"Initial evidence"}]}]'); commit;`);
        fields = { ...body("Late cited canon"), sourceRefs: [{ chapterId: chapter, documentVersionId: version, nodeId: "n2" }] };
        insert = `insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
          values('${version}','${chapter}',2,'{"schemaVersion":"1.0","nodes":[{"id":"n2","type":"paragraph","text":"Late saved evidence"}]}',
            'Late saved evidence',3,'${f.actor}');`;
        remove = `delete from public.document_versions where id='${version}';`;
      }
      const relation = boundary === "image" ? "public.asset_versions" : "public.document_versions";
      assert.equal(await sql(`select count(*) from ${relation} where id='${version}';`), "0");
      originalDefinition = await sql(`select pg_catalog.pg_get_functiondef(${literal(originalSignature)}::regprocedure);`);
      const declaration = "CREATE OR REPLACE FUNCTION public.mutate_book_bible_item(";
      const marker = boundary === "image"
        ? "select * into v_asset_version from public.asset_versions where asset_id=v_asset.id and storage_path=v_asset.storage_path"
        : "for v_ref in select value from pg_catalog.jsonb_array_elements(v_body->'sourceRefs') loop";
      assert.equal(originalDefinition.split(declaration).length, 2, "Production function declaration drifted");
      assert.equal(originalDefinition.split(marker).length, 2, "Prelock/selection fence marker must occur exactly once");
      const fencedDefinition = originalDefinition.replace(declaration, `CREATE OR REPLACE FUNCTION ${clone}(`)
        .replace(marker, `perform ${fence};\n    ${marker}`);
      // Only this disposable database receives a uniquely named clone. The
      // production RPC definition and its permissions remain byte-for-byte intact.
      await sql(fencedDefinition); installed = true;
      await sql(`revoke all on function ${cloneSignature} from public,anon,authenticated,service_role;
        grant execute on function ${cloneSignature} to authenticated;`);
      const gate = session(database, `manual_bible_late_gate_${suffix}`); handles.push(gate);
      gate.child.stdin.write(`begin; select ${fence}; select 'BOOKWORM_LATE_GATE_READY';\n`);
      await until(() => {
        assert.equal(gate.ended, false, gate.stderr);
        return gate.stdout.includes("BOOKWORM_LATE_GATE_READY");
      }, "Late-version fence holder did not become ready");
      const call = f.create(request, fields);
      assert.equal(call.split("public.mutate_book_bible_item(").length, 2);
      const mutationName = `manual_bible_late_mutation_${suffix}`;
      const mutation = session(database, mutationName); handles.push(mutation);
      mutation.child.stdin.write(`begin; ${call.replace("public.mutate_book_bible_item(", `${clone}(`)} select 'BOOKWORM_LATE_MUTATION_READY';\n`);
      await until(async () => {
        assert.equal(mutation.ended, false, mutation.stderr);
        return await sql(`select count(*) from pg_stat_activity where application_name='${mutationName}'
          and wait_event_type='Lock' and wait_event='advisory';`) === "1";
      }, "Mutation did not reach the advisory fence after its bulk prelocks");
      // Commit the exact selected UUID AFTER the bulk prelock statement. This
      // statement must finish while the mutation still holds its parent locks.
      await sql(insert);
      assert.equal(await sql(`select count(*) from ${relation} where id='${version}';`), "1");
      gate.child.stdin.end("commit;\n");
      assert.equal((await gate.done).code, 0, gate.stderr);
      await until(() => {
        assert.equal(mutation.ended, false, mutation.stderr);
        return mutation.stdout.includes("BOOKWORM_LATE_MUTATION_READY");
      }, "Mutation did not select the newly committed version");
      const saved = output(mutation.stdout);
      assert.equal(saved.disposition, "unchanged");
      assert.equal(saved.receipt.requestId, request);
      if (boundary === "document") assert.equal(saved.item.source_refs_json[0].documentVersionId, version);
      const deleteName = `manual_bible_late_delete_${suffix}`;
      const deleting = session(database, deleteName); handles.push(deleting);
      deleting.child.stdin.end(`begin; ${remove} commit;`);
      await until(async () => {
        assert.equal(deleting.ended, false, `Selected late version was not locked: ${deleting.stderr}`);
        return await sql(`select count(*) from pg_stat_activity where application_name='${deleteName}' and wait_event_type='Lock';`) === "1";
      }, "DELETE of the selected late version did not wait through canon transaction");
      assert.equal(await sql(`select count(*) from ${relation} where id='${version}';`), "1");
      mutation.child.stdin.end(rollback ? "rollback;\n" : "commit;\n");
      assert.equal((await mutation.done).code, 0, mutation.stderr);
      assert.equal((await deleting.done).code, 0, deleting.stderr);
      assert.equal(await sql(`select count(*) from ${relation} where id='${version}';`), "0");
      await state(f, rollback ? 0 : 1, rollback ? 0 : 1);
      const recovered = output(await sql(`begin; ${f.recover(request)} commit;`));
      if (rollback) assert.deepEqual(recovered, emptyResult);
      else assert.deepEqual(recovered.receipt, saved.receipt);
      log(`late ${boundary} version selection locks until ${rollback ? "rollback" : "commit"}`);
    } finally {
      // On any failed fence/assertion, release owned transactions and settle ALL
      // psql handles before dropping the test clone. Never leave a test waiter.
      for (const handle of handles) {
        if (!handle.ended && !handle.child.stdin.writableEnded && !handle.child.stdin.destroyed) {
          handle.child.stdin.end("rollback;\n");
        }
      }
      await Promise.all(handles.map(handle => handle.done));
      if (installed) await sql(`drop function ${cloneSignature};`);
      if (originalDefinition !== undefined) {
        assert.equal(await sql(`select pg_catalog.pg_get_functiondef(${literal(originalSignature)}::regprocedure);`), originalDefinition,
          "Native fence changed the production RPC");
      }
    }
  }

  for (const boundary of ["image", "document"]) for (const rollback of [false, true]) {
    await lateVersionSelection(boundary, rollback);
  }
  for (const boundary of ["current bytes", "saved version"]) for (const first of ["change", "mutation"]) for (const rollback of [false, true]) {
    const f = await fixture(), image = await imageFixture(f), request = randomUUID();
    const change = boundary === "current bytes"
      ? `update public.assets set storage_path='native/replaced.png',checksum=repeat('b',64) where id='${image.image}';`
      : `delete from public.asset_versions where id='${image.version}';`;
    const mutation = f.create(request, image.fields);
    const race = await contention(first === "change" ? change : mutation, first === "change" ? mutation : change, rollback);
    if (first === "change" && !rollback) denied(race.second, "22023", "not scan-cleared");
    else if (first === "change") { const r = success(race.second); assert.equal(r.disposition, "unchanged"); }
    else { assert.equal(race.second.code, 0, race.second.stderr); assert.equal(race.first.disposition, "unchanged"); }
    const committed = first === "mutation" ? !rollback : rollback;
    await state(f, committed ? 1 : 0, committed ? 1 : 0);
    log(`image ${boundary} ${first} first ${rollback ? "rollback" : "commit"}`);
  }

  for (const first of ["change", "mutation"]) for (const rollback of [false, true]) {
    const f = await fixture(), request = randomUUID();
    const chapter = await sql(`begin; ${f.auth} select id from public.create_book_chapters('${f.book}',
      '[{"title":"Evidence","nodes":[{"id":"n1","type":"paragraph","text":"Saved evidence"}]}]'); commit;`);
    const version = await sql(`select current_document_version_id from public.chapters where id='${chapter}';`);
    const fields = { ...body("Cited canon"), sourceRefs: [{ chapterId: chapter, nodeId: "n1" }] };
    const change = `update public.chapters set current_document_version_id=null where id='${chapter}';`;
    const mutation = f.create(request, fields);
    const race = await contention(first === "change" ? change : mutation, first === "change" ? mutation : change, rollback);
    if (first === "change" && !rollback) denied(race.second, "22023", "available saved chapter version");
    else if (first === "change") assert.equal(success(race.second).item.source_refs_json[0].documentVersionId, version);
    else {
      assert.equal(race.second.code, 0, race.second.stderr);
      assert.equal(race.first.item.source_refs_json[0].documentVersionId, version);
    }
    const committed = first === "mutation" ? !rollback : rollback;
    await state(f, committed ? 1 : 0, committed ? 1 : 0);
    log(`implicit source ${first} first ${rollback ? "rollback" : "commit"}`);
  }
}
