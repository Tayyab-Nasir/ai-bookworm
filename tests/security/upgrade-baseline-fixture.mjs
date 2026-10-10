/** Synthetic historical rows only. Accepts a disposable DB, never a connection URL. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const json = (value) => JSON.stringify(value);
const relations = [
  ['auth', 'users'], ['public', 'profiles'], ['public', 'organizations'],
  ['public', 'organization_members'], ['public', 'workspaces'], ['public', 'workspace_members'],
  ['public', 'books'], ['public', 'book_versions'], ['public', 'chapters'],
  ['public', 'document_versions'], ['public', 'book_metadata'], ['public', 'style_guides'],
  ['public', 'book_bible_items'], ['public', 'assets'], ['public', 'asset_versions'],
  ['public', 'asset_links'], ['public', 'editions'], ['public', 'credit_ledger'],
  ['public', 'usage_events'], ['public', 'ai_jobs'], ['public', 'reports'],
  ['public', 'plans'], ['public', 'subscriptions'], ['public', 'stripe_events'],
  ['storage', 'buckets'], ['storage', 'objects'],
];
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;

export async function seedUpgradeBaseline(db) {
  const fixture = { tenants: [], viewer: randomUUID(), suspended: randomUUID(), columns: [] };
  await db.exec('begin;');
  try {
    for (const label of ['A', 'B']) {
      const tenant = { label, user: randomUUID(), organization: randomUUID(), workspace: randomUUID(),
        book: randomUUID(), chapter: randomUUID(), bookVersions: [randomUUID(), randomUUID()],
        versions: [randomUUID(), randomUUID()], edition: randomUUID(), assets: [],
        job: randomUUID(), report: randomUUID(), plan: randomUUID(), subscription: randomUUID(),
        stripeEvent: `evt_upgrade_${randomUUID().replaceAll('-', '')}`,
        stripeSubscription: `sub_upgrade_${randomUUID().replaceAll('-', '')}`,
        stripeCustomer: `cus_upgrade_${randomUUID().replaceAll('-', '')}`,
        balance: label === 'A' ? 119 : 237 };
      fixture.tenants.push(tenant);
      await db.query('insert into auth.users(id,email) values($1,$2)', [tenant.user, `historical-${label.toLowerCase()}@upgrade.invalid`]);
      await db.query('update public.profiles set display_name=$2,locale=$3,timezone=$4 where id=$1',
        [tenant.user, `Historical author ${label}`, 'en-GB', 'Europe/London']);
      await db.query('insert into public.organizations(id,name,slug,owner_user_id) values($1,$2,$3,$4)',
        [tenant.organization, `Historical tenant ${label}`, `upgrade-${tenant.organization}`, tenant.user]);
      await db.query("insert into public.organization_members(organization_id,user_id,role) values($1,$2,'owner')", [tenant.organization, tenant.user]);
      // Unpublished, empty-entitlement plans preserve historical billing identity
      // without granting paid generation in this synthetic upgrade rehearsal.
      await db.query("insert into public.plans(id,name,billing_period,price_cents,entitlements_json,is_active) values($1,$2,'monthly',4900,'{}',false)",
        [tenant.plan, `Historical unpublished plan ${label}`]);
      await db.query("insert into public.subscriptions(id,organization_id,provider_customer_id,provider_subscription_id,plan_id,status,current_period_end) values($1,$2,$3,$4,$5,$6,'2024-01-31T00:00:00Z')",
        [tenant.subscription, tenant.organization, tenant.stripeCustomer, tenant.stripeSubscription, tenant.plan, label === 'A' ? 'canceled' : 'past_due']);
      await db.query("insert into public.stripe_events(id,type,created_at) values($1,'customer.subscription.updated','2024-01-01T00:00:00Z')", [tenant.stripeEvent]);
      await db.query('insert into public.workspaces(id,organization_id,name,slug,created_by) values($1,$2,$3,$4,$5)',
        [tenant.workspace, tenant.organization, `Historical workspace ${label}`, `upgrade-${label.toLowerCase()}`, tenant.user]);
      await db.query("insert into public.workspace_members(workspace_id,user_id,role) values($1,$2,'owner')", [tenant.workspace, tenant.user]);
      await db.query("insert into public.books(id,workspace_id,title,author_name,language,created_by) values($1,$2,$3,$4,'en',$5)",
        [tenant.book, tenant.workspace, `Historical book ${label}`, `Author ${label}`, tenant.user]);
      for (let version = 1; version <= 2; version++) {
        await db.query("insert into public.book_versions(id,book_id,version_number,source_type,created_by,change_summary) values($1,$2,$3,'upload',$4,$5)",
          [tenant.bookVersions[version - 1], tenant.book, version, tenant.user, `Historical revision ${version}`]);
      }
      await db.query('update public.books set current_version_id=$2 where id=$1', [tenant.book, tenant.bookVersions[1]]);
      await db.query('insert into public.chapters(id,book_id,order_index,title) values($1,$2,0,$3)', [tenant.chapter, tenant.book, `Chapter ${label}`]);
      for (let version = 1; version <= 2; version++) {
        const text = `Tenant ${label} manuscript revision ${version}: café — preserved.`;
        const nodes = [{ id: 'paragraph', type: 'paragraph', text }];
        if (version === 2) nodes.push({ id: 'figure', type: 'image', caption: `Historical caption ${label}`, altText: `Private figure ${label}` },
          { id: 'table', type: 'table', rows: [[`Historical cell ${label}`, '42']] });
        await db.query('insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by,operation_id) values($1,$2,$3,$4::jsonb,$5,8,$6,$7)',
          [tenant.versions[version - 1], tenant.chapter, version, json({ nodes }), text, tenant.user, `historical-${tenant.chapter}-${version}`]);
      }
      await db.query('update public.chapters set current_document_version_id=$2 where id=$1', [tenant.chapter, tenant.versions[1]]);
      await db.query("insert into public.book_metadata(book_id,description,keywords,categories,publication_date,contributors) values($1,$2,$3::jsonb,'[\"Fiction\"]','2024-02-29',$4::jsonb)",
        [tenant.book, `Private historical description ${label}`, json([`historical-${label}`]), json([{ name: `Author ${label}`, role: 'author' }])]);
      await db.query("insert into public.style_guides(book_id,rules_json,tone,spelling_variant) values($1,'{\"preserveDialogue\":true}','warm','British')", [tenant.book]);
      await db.query("insert into public.book_bible_items(book_id,type,name,description,attributes_json,source_refs_json,confidence) values($1,'character',$2,$3,'{\"age\":42}',$4::jsonb,0.9)",
        [tenant.book, `Historical character ${label}`, `Private canon ${label}`, json([{ chapterId: tenant.chapter, documentVersionId: tenant.versions[0], nodeId: 'paragraph' }])]);
      await db.query("insert into public.editions(id,book_id,type,language,edition_metadata_json) values($1,$2,'ebook','en','{\"historicalLayout\":\"preserve\"}')", [tenant.edition, tenant.book]);
      for (const trusted of [false, true]) {
        const asset = { id: randomUUID(), version: randomUUID(), object: randomUUID(), trusted };
        asset.path = `workspaces/${tenant.workspace}/assets/${asset.id}/v1/${trusted ? 'generated' : 'upload'}.png`;
        tenant.assets.push(asset);
        await db.query('insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by) values($1,$2,\'image\',$3,$4,\'image/png\',128,$5,$6)',
          [asset.id, tenant.workspace, `Historical ${trusted ? 'generated' : 'upload'} ${label}`, asset.path, createHash('sha256').update(asset.path).digest('hex'), tenant.user]);
        await db.query("select set_config('request.jwt.claim.role',$1,true)", [trusted ? 'service_role' : '']);
        await db.query("insert into public.asset_versions(id,asset_id,version_number,storage_path,checksum,created_by,mime_type,size_bytes) values($1,$2,1,$3,$4,$5,'image/png',128)",
          [asset.version, asset.id, asset.path, createHash('sha256').update(asset.path).digest('hex'), tenant.user]);
        await db.exec("set local request.jwt.claim.role='';");
        await db.query("insert into storage.objects(id,bucket_id,name,owner,metadata) values($1,'book-assets',$2,$3,'{\"synthetic\":true}')", [asset.object, asset.path, tenant.user]);
      }
      await db.query("insert into public.asset_links(asset_id,entity_type,entity_id,usage_role) values($1,'book',$2,'cover')", [tenant.assets[1].id, tenant.book]);
      await db.query("insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after) values($1,$2,'purchase',$3,0)", [tenant.user, tenant.workspace, tenant.balance + 5]);
      await db.query("insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after) values($1,$2,'usage',-5,0)", [tenant.user, tenant.workspace]);
      await db.query("insert into public.usage_events(organization_id,user_id,workspace_id,meter,quantity,metadata_json) values($1,$2,$3,'fixture_historical',5,'{\"synthetic\":true}')", [tenant.organization, tenant.user, tenant.workspace]);
      await db.query("insert into public.ai_jobs(id,workspace_id,book_id,agent_type,status,input_ref,idempotency_key,created_by) values($1,$2,$3,'metadata','queued',$4::jsonb,$5,$6)",
        [tenant.job, tenant.workspace, tenant.book, json({ historical: true, revision: 2 }), `historical-${tenant.job}`, tenant.user]);
      // This was legal at migration 45. NOT VALID must preserve it for operator review.
      await db.query("insert into public.reports(id,reporter_id,entity_type,entity_id,reason) values($1,$2,'post',$3,$4)",
        [tenant.report, tenant.user, randomUUID(), label === 'A' ? 'x'.repeat(1001) : 'Historical reason']);
    }
    const first = fixture.tenants[0];
    // A legacy receipt could have committed before its subscription effect failed.
    // It has no corresponding subscription and must not be certified as processed.
    fixture.orphanStripeEvent = `evt_upgrade_orphan_${randomUUID().replaceAll('-', '')}`;
    await db.query("insert into public.stripe_events(id,type,created_at) values($1,'checkout.session.completed','2024-01-02T00:00:00Z')", [fixture.orphanStripeEvent]);
    for (const [user, status] of [[fixture.viewer, 'active'], [fixture.suspended, 'suspended']]) {
      await db.query('insert into auth.users(id,email) values($1,$2)', [user, `${status}@upgrade.invalid`]);
      await db.query("insert into public.organization_members(organization_id,user_id,role) values($1,$2,'member')", [first.organization, user]);
      await db.query("insert into public.workspace_members(workspace_id,user_id,role,status) values($1,$2,'viewer',$3)", [first.workspace, user, status]);
    }
    await db.exec('commit;');
  } catch (error) { await db.exec('rollback;'); throw error; }
  for (const [schema, table] of relations) {
    const { rows } = await db.query('select column_name from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position', [schema, table]);
    assert.ok(rows.length, `Historical relation ${schema}.${table} exists at migration 45`);
    // Search re-indexing intentionally touches chapter updated_at; identities/content remain exact.
    fixture.columns.push({ schema, table, columns: rows.map(row => row.column_name).filter(column => column !== 'updated_at') });
  }
  return fixture;
}

export async function captureHistoricalState(db, fixture) {
  const state = {};
  for (const { schema, table, columns } of fixture.columns) {
    const { rows } = await db.query(`select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb) as data
      from (select ${columns.map(identifier).join(',')} from ${identifier(schema)}.${identifier(table)}) r`);
    state[`${schema}.${table}`] = createHash('sha256').update(json(rows[0].data)).digest('hex');
  }
  return state;
}

async function asUser(db, user, operation) {
  await db.exec('begin; set local role authenticated;');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.role','authenticated',true)", [json({ sub: user, role: 'authenticated' })]);
    return await operation();
  } finally { await db.exec('rollback;'); }
}

export async function verifyHistoricalIsolation(db, fixture) {
  for (const [index, tenant] of fixture.tenants.entries()) {
    const foreign = fixture.tenants[1 - index];
    await asUser(db, tenant.user, async () => {
      for (const [table, key, owned, other] of [
        ['books', 'id', tenant.book, foreign.book], ['chapters', 'id', tenant.chapter, foreign.chapter],
        ['document_versions', 'id', tenant.versions[0], foreign.versions[0]],
        ['book_search_chunks', 'book_id', tenant.book, foreign.book],
        ['book_metadata', 'book_id', tenant.book, foreign.book], ['assets', 'id', tenant.assets[0].id, foreign.assets[0].id],
        ['workspace_members', 'workspace_id', tenant.workspace, foreign.workspace],
      ]) {
        const { rows } = await db.query(`select ${identifier(key)} from public.${identifier(table)} where ${identifier(key)} in ($1,$2)`, [owned, other]);
        assert.ok(rows.length && rows.every(row => row[key] === owned), `${table} preserves own visibility and foreign denial`);
      }
      assert.deepEqual((await db.query('select id from public.profiles where id in ($1,$2)', [tenant.user, foreign.user])).rows.map(row => row.id),
        [tenant.user], 'Profiles never cross tenants; active same-workspace collaborators may be visible');
      assert.equal((await db.query("update public.profiles set display_name='Foreign mutation' where id=$1 returning id", [foreign.user])).rows.length, 0,
        'Profiles cannot be edited by a foreign caller');
      assert.equal((await db.query('select coalesce(sum(amount),0)::int as balance from public.credit_ledger')).rows[0].balance, tenant.balance, 'Ledger visibility is caller-scoped');
      const objects = (await db.query('select id from storage.objects')).rows.map(row => row.id);
      assert.deepEqual(objects, [tenant.assets[1].object], 'Only own trusted object is readable; uploads remain quarantined');
      assert.equal((await db.query("update public.books set title='Foreign mutation' where id=$1 returning id", [foreign.book])).rows.length, 0, 'Foreign update affects no rows');
    });
    await assert.rejects(asUser(db, tenant.user, () => db.query('update public.document_versions set plain_text=$2 where id=$1', [tenant.versions[0], 'Forbidden revision'])), { code: '42501' });
    await assert.rejects(asUser(db, tenant.user, () => db.query('update public.credit_ledger set amount=999 where user_id=$1', [tenant.user])), { code: '42501' });
  }
  await asUser(db, fixture.viewer, async () => {
    assert.equal((await db.query('select count(*)::int as n from public.books')).rows[0].n, 1, 'Viewer reads only own workspace');
    assert.equal((await db.query("update public.books set title='Viewer mutation' returning id")).rows.length, 0, 'Viewer cannot update book');
  });
  await asUser(db, fixture.suspended, async () => {
    assert.equal((await db.query('select count(*)::int as n from public.books')).rows[0].n, 0, 'Suspended membership cannot read books');
    assert.equal((await db.query('select count(*)::int as n from storage.objects')).rows[0].n, 0, 'Suspended membership cannot read objects');
  });
}

export async function verifyUpgradeGates(db, fixture) {
  assert.equal((await db.query("select count(*)::int as n from public.ai_jobs where billing_mode<>'operational'")).rows[0].n, 0, 'Historical jobs remain operational, never silently quoted');
  const { rows: reason } = await db.query("select convalidated from pg_constraint where conrelid='public.reports'::regclass and conname='reports_reason_bounded'");
  assert.deepEqual(reason, [{ convalidated: false }], 'Historical reasons need review, not silent validation');
  assert.equal((await db.query('select length(reason)::int as n from public.reports where id=$1', [fixture.tenants[0].report])).rows[0].n, 1001);
  await assert.rejects(db.query("insert into public.reports(reporter_id,entity_type,entity_id,reason) values($1,'post',$2,'')", [fixture.tenants[0].user, randomUUID()]), { code: '23514' });
  for (const name of ['queue_translation_project', 'claim_translation_job', 'queue_audiobook_project', 'claim_audiobook_job']) {
    const { rows } = await db.query("select has_function_privilege('anon',p.oid,'EXECUTE') as anon,has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') as service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1", [name]);
    assert.equal(rows.length, 1, `${name} has one historical signature`);
    assert.deepEqual(rows[0], { anon: false, authenticated: false, service: false }, `${name} remains retired for every application role`);
  }
  // Service-only workers retain invoker privileges where the migration requires
  // them; do not demand an unintended SECURITY DEFINER privilege escalation.
  const contracts = [
    ['public.accept_metadata_token_quote(uuid,uuid,integer)', false, 'search_path=public, extensions, pg_temp'],
    ['public.claim_quoted_translation_job(integer)', false, 'search_path=public, pg_temp'],
    ['public.claim_quoted_image_job(integer)', false, 'search_path=public, pg_temp'],
    ['public.accept_narration_chapter_quote(uuid,uuid,integer,boolean,jsonb)', true, 'search_path=public, pg_temp'],
    ['public.complete_quoted_narration_job(uuid,uuid)', false, 'search_path=public, pg_temp'],
    ['public.claim_stripe_subscription_event(text,text,text,boolean)', false, 'search_path=public, pg_temp'],
    ['public.complete_stripe_subscription_event(text,uuid,jsonb)', false, 'search_path=public, pg_temp'],
  ];
  for (const [signature, definer, searchPath] of contracts) {
    const name = signature.slice('public.'.length).split('(')[0];
    const { rows } = await db.query("select has_function_privilege('anon',p.oid,'EXECUTE') as anon,has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') as service,p.prosecdef as definer,p.proconfig as config,p.oid=to_regprocedure($2) as exact_signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1", [name, signature]);
    assert.equal(rows.length, 1, `${name} has one current signature`);
    assert.deepEqual(rows[0], { anon: false, authenticated: false, service: true, definer, config: [searchPath], exact_signature: true },
      `${name} preserves its exact service-only signature, security mode and search path`);
  }
  for (const tenant of fixture.tenants) {
    const { rows } = await db.query('select document_version_id,text_content from public.book_search_chunks where book_id=$1 and chapter_id=$2', [tenant.book, tenant.chapter]);
    assert.ok(rows.length && rows.every(row => row.document_version_id === tenant.versions[1]), 'Derived citations pin the unchanged current version');
    assert.ok(rows.some(row => row.text_content.includes(`Historical caption ${tenant.label}`)), 'Rich caption is re-indexed without replacing source');
    assert.ok(rows.some(row => row.text_content.includes(`Historical cell ${tenant.label}`)), 'Rich table is re-indexed without replacing source');
    const { rows: bible } = await db.query('select c.document_version_id,c.chapter_id,exists(select 1 from public.book_bible_items b where b.id=c.bible_item_id and b.book_id=$1) as exact_bible_source from public.book_search_chunks c where c.book_id=$1 and c.bible_item_id is not null', [tenant.book]);
    assert.deepEqual(bible, [{ document_version_id: null, chapter_id: null, exact_bible_source: true }],
      'Bible citations retain their distinct canonical item, rather than pretending to be manuscript versions');
  }
  const first = fixture.tenants[0];
  const legacyEvents = fixture.tenants.map(tenant => tenant.stripeEvent).concat(fixture.orphanStripeEvent);
  const { rows: receipts } = await db.query('select id,processing_state,provider_subscription_id,livemode,mutation_sha256,processed_at from public.stripe_events where id=any($1::text[]) order by id', [legacyEvents]);
  assert.deepEqual(receipts, [...legacyEvents].sort().map(id => ({ id, processing_state: 'legacy_unverified', provider_subscription_id: null, livemode: null, mutation_sha256: null, processed_at: null })),
    'Historical receipts, including a receipt without a subscription, remain uncertain rather than falsely processed');
  assert.equal((await db.query('select count(*)::int as n from bookworm_private.stripe_subscription_sync')).rows[0].n, 0,
    'Migration does not claim or reconcile historical events or create leases');
  for (const role of ['anon', 'authenticated']) {
    const { rows } = await db.query("select has_schema_privilege($1,'bookworm_private','USAGE') as schema,has_table_privilege($1,'bookworm_private.stripe_subscription_sync','SELECT') as select,has_table_privilege($1,'bookworm_private.stripe_subscription_sync','INSERT') as insert,has_table_privilege($1,'bookworm_private.stripe_subscription_sync','UPDATE') as update", [role]);
    assert.deepEqual(rows, [{ schema: false, select: false, insert: false, update: false }], 'Clients cannot read or mutate private reconciliation leases');
  }
  await assert.rejects(db.query("insert into public.ai_jobs(workspace_id,book_id,agent_type,idempotency_key,created_by) values($1,$2,'illustrator',$3,$4)",
    [first.workspace, first.book, `unfunded-${randomUUID()}`, first.user]), { code: '23514' });
}
