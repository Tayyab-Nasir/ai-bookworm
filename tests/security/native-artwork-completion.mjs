/** Runs only through the explicit disposable native PostgreSQL runner. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function artworkCompletionRaces({ sql, session, until, database }) {
  const source = await readFile(new URL('./artwork-completion.test.sql', import.meta.url), 'utf8');
  const marker = source.indexOf('\ncreate function pg_temp.artwork_job');
  assert.ok(marker > 0, 'Native artwork fixture boundary missing');
  // Retain only this suite's base fixtures in the runner's fresh database.
  // Temporary serial helpers are deliberately not shared across connections.
  const service = "set request.jwt.claim.role='service_role';";
  await sql(`${service}\n${source.slice(0, marker)}\ncommit;`);
  const workspace = 'c7300000-0000-4000-8000-000000000001';
  const book = 'd7300000-0000-4000-8000-000000000001';
  const edition = 'e7300000-0000-4000-8000-000000000001';
  const image = 'f7300000-0000-4000-8000-000000000001';
  const approval = '07300000-0000-4000-8000-000000000001';
  const author = 'a7300000-0000-4000-8000-000000000001';
  const path = `workspaces/${workspace}/assets/${image}/v1/scene.png`;
  const snapshot = { schemaVersion: 1, coverAssetId: image, illustrationAssetIds: [image], assets: [{
    assetId: image, versionNumber: 1, storagePath: path, checksum: 'a'.repeat(64), mimeType: 'image/png',
    sizeBytes: 128, requiresApproval: true, approvalId: approval,
  }] };
  const restore = `${service}
    update public.editions set edition_metadata_json='{"kind":"ebook","cover":{"asset_id":"${image}"}}' where id='${edition}';
    update public.workspace_members set role='editor' where workspace_id='${workspace}' and user_id='${author}';
    delete from public.asset_versions where asset_id='${image}';
    insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
      values('${image}',1,'${path}',repeat('a',64),'image/png',128,'${author}');
    update public.assets set storage_path='${path}',checksum=repeat('a',64),mime_type='image/png',size_bytes=128,deleted_at=null where id='${image}';
    update public.assets set status='approved',requires_approval=true where id='${image}';
    update public.approvals set status='approved',superseded_at=null where id='${approval}';`;
  const mutations = {
    permission: `${service} update public.workspace_members set role='viewer' where workspace_id='${workspace}' and user_id='${author}';`,
    edition: `${service} update public.editions set edition_metadata_json='{"kind":"ebook","cover":{"asset_id":null}}' where id='${edition}';`,
    revision: `${service}
      insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
        values('${image}',2,'${path.replace('/v1/', '/v2/')}',repeat('a',64),'image/png',128,'${author}');
      update public.assets set storage_path='${path.replace('/v1/', '/v2/')}' where id='${image}';`,
    review: `${service} update public.approvals set superseded_at=clock_timestamp() where id='${approval}';`,
    version_deletion: `${service} delete from public.asset_versions where asset_id='${image}' and version_number=1;`,
    scan: `${service}
      delete from public.asset_versions where asset_id='${image}' and version_number=1;
      insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
        values('${image}',1,'${path}','pending','image/png',128,'${author}');
      select public.record_asset_scan_verdict('${image}',1,'infected',repeat('a',64),'image/png',128,'fixture-scanner','Eicar-Test','malware_detected');`,
  };

  async function job(action, leased) {
    await sql(`begin; ${restore} commit;`);
    // Capture every restored edition's exact microseconds, without JS Date rounding.
    const updatedAt = JSON.parse(await sql(`select to_json(updated_at) from public.editions where id='${edition}';`));
    const id = randomUUID(), render = randomUUID(), preflight = randomUUID();
    const request = { action, editionUpdatedAt: updatedAt, bookModelSha256: 'a'.repeat(64),
      imageSha256: 'b'.repeat(64), artworkSnapshot: snapshot,
      ...(action === 'export_package' ? { sourceRenderJobId: render, sourcePreflightJobId: preflight } : {}) };
    let proofs = '';
    if (action === 'export_package') {
      proofs = `insert into public.publishing_jobs(id,book_id,edition_id,channel,status,request_json,response_json,idempotency_key,created_by) values
        ('${render}','${book}','${edition}','render','succeeded','${JSON.stringify({ ...request, action: 'render' })}',
         '{"artifacts":[]}','${render}','${author}'),
        ('${preflight}','${book}','${edition}','kdp','succeeded','${JSON.stringify({ ...request, action: 'validate' })}',
         '{"requestedChannel":"kdp","errors":0}','${preflight}','${author}');`;
    }
    await sql(`${service} ${proofs}
      insert into public.publishing_jobs(id,book_id,edition_id,channel,status,request_json,idempotency_key,created_by,lease_token,lease_expires_at)
      values('${id}','${book}','${edition}','${action === 'render' ? 'render' : 'kdp'}','running','${JSON.stringify(request)}',
       '${id}','${author}','${id}',clock_timestamp()+interval '5 minutes');`);
    const filename = action === 'export_package' ? 'kdp-export.zip' : 'book.epub';
    const artifact = { assetId: id, name: 'Native fixture', type: action === 'export_package' ? 'publishing_package' : 'rendered_book',
      role: action === 'export_package' ? 'publishing_package' : 'rendered_ebook', filename,
      storagePath: `workspaces/${workspace}/assets/${id}/v1/${filename}`,
      mimeType: action === 'export_package' ? 'application/zip' : 'application/epub+zip', sizeBytes: 256, checksum: 'c'.repeat(64) };
    const result = action === 'render' ? { artifacts: [artifact], rendererVersion: 'native-test', usage: {} }
      : action === 'export_package' ? { artifact, ruleVersion: 'native-test' }
        : { ruleVersion: 'native-test', requestedChannel: 'kdp', errors: 0, warnings: 1,
          findings: [{ severity: 'warning', code: 'TEST', message: 'Fixture', rule_id: 'TEST', rule_version: 'native-test' }] };
    const complete = leased ? `${service} select status from public.complete_leased_publishing_job('${id}','${id}','${JSON.stringify(result)}');`
      : action === 'render' ? `${service} select status from public.complete_render_job('${id}','${JSON.stringify([artifact])}','native-test','{}');`
        : action === 'validate' ? `${service} select status from public.complete_preflight_job('${id}','${JSON.stringify(result)}');`
          : `${service} select status from public.complete_publishing_package_job('${id}','${JSON.stringify(artifact)}','native-test','${render}','${preflight}');`;
    return { id, complete, action };
  }
  async function checkState(j, succeeded) {
    const actual = JSON.parse(await sql(`select json_build_object('status',status,
      'assets',(select count(*) from public.assets where id='${j.id}'),
      'usage',(select count(*) from public.usage_events where publishing_job_id='${j.id}'),
      'findings',(select count(*) from public.publishing_validations where publishing_job_id='${j.id}'),
      'activity',(select count(*) from public.activity_events where payload_json->>'publishingJobId'='${j.id}'))
      from public.publishing_jobs where id='${j.id}';`));
    assert.deepEqual(actual, { status: succeeded ? 'succeeded' : 'running',
      assets: Number(succeeded && j.action !== 'validate'), usage: Number(succeeded && j.action !== 'validate'),
      findings: Number(succeeded && j.action === 'validate'), activity: Number(succeeded) });
  }
  async function race(action, leased, mutation, mode) {
    const j = await job(action, leased);
    const completionFirst = mode.startsWith('completion');
    const rollback = mode.endsWith('rollback');
    const held = session(database, `artwork_holder_${randomUUID().replaceAll('-', '')}`);
    held.child.stdin.write(`begin; ${completionFirst ? j.complete : mutations[mutation]} select 'BOOKWORM_READY';\n`);
    await until(() => { assert.equal(held.ended, false, held.stderr); return held.stdout.includes('BOOKWORM_READY'); }, 'Artwork holder not ready');
    const name = `artwork_wait_${randomUUID().replaceAll('-', '')}`;
    const contender = session(database, name);
    contender.child.stdin.end(`begin; ${completionFirst ? mutations[mutation] : j.complete} commit;`);
    await until(async () => {
      assert.equal(contender.ended, false, `Artwork contender did not wait: ${contender.stderr}`);
      return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1';
    }, 'Expected artwork completion/revocation PostgreSQL lock wait');
    held.child.stdin.end(rollback ? 'rollback;\n' : 'commit;\n');
    assert.equal((await held.done).code, 0, held.stderr);
    const result = await contender.done;
    const succeeded = completionFirst ? !rollback : rollback;
    const rejection = mutation === 'permission' ? /42501.*creator can no longer edit book/s
      : mutation === 'edition' ? /(?:40001|22023).*edition changed/s : /40001.*publishing artwork/s;
    if (!completionFirst && !rollback) {
      assert.notEqual(result.code, 0); assert.match(result.stderr, rejection);
    } else assert.equal(result.code, 0, result.stderr);
    await checkState(j, succeeded);
    if (succeeded) {
      assert.equal(await sql(j.complete), 'succeeded', 'completion replay must not duplicate side effects');
      await checkState(j, true);
    } else if (completionFirst) {
      const retry = session(); retry.child.stdin.end(j.complete);
      const failed = await retry.done; assert.notEqual(failed.code, 0); assert.match(failed.stderr, rejection);
      await checkState(j, false);
    }
    console.log(`PASS native artwork ${action} ${leased ? 'leased' : 'direct'} ${mutation} ${mode}`);
  }
  for (const action of ['render', 'validate', 'export_package']) {
    for (const leased of [false, true]) {
      // All direct guards; leased entry points exercise review, permission and
      // edition locks across completion-first and rollback schedules too.
      for (const mutation of leased ? ['review', 'permission', 'edition'] : Object.keys(mutations)) {
        for (const mode of ['mutation-first', 'mutation-rollback', 'completion-first', 'completion-rollback']) {
          await race(action, leased, mutation, mode);
        }
      }
    }
  }
}
