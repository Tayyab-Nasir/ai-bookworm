/** Real retailer handoff ZIPs through authenticated API, private services and Storage. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { childEnvironment, requireNativeAuthorRunner } from './native-author-files-guard.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function inspectNativePackage(bytes) {
  // Reuse Python's ZIP reader; do not add a package dependency or extract files.
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/run-python.mjs', import.meta.url)), '-I', '-c', `
import hashlib, io, json, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 infos = archive.infolist()
 assert len(infos) == len({item.filename for item in infos}) <= 6
 assert sum(item.file_size for item in infos) < 25000000
 assert all('/' not in item.filename and '\\\\' not in item.filename for item in infos)
 files = {item.filename: archive.read(item) for item in infos}
 print(json.dumps({
  'files': {name: {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)} for name, data in files.items()},
  'manifest': json.loads(files['manifest.json']), 'metadata': json.loads(files['metadata.json']),
  'preflight': json.loads(files['preflight.json']), 'readme': files['README.txt'].decode('utf-8')
 }))
`], { input: bytes, env: childEnvironment(), timeout: 30_000, maxBuffer: 1_000_000 });
  assert.equal(result.status, 0, 'Private retailer ZIP could not be inspected with the standard ZIP reader');
  return JSON.parse(result.stdout.toString('utf8'));
}

export async function runNativeRetailerPackages({ request, service, alice, bob, upload, confirm, runOneDocumentJob, artwork }) {
  requireNativeAuthorRunner();
  assert.equal(new URL(service.supabaseUrl).origin, 'http://127.0.0.1:55321');
  const data = (result, label) => {
    assert.equal(result.error, null, `${label}: ${result.error?.code ?? 'failed'}`);
    assert.ok(result.data != null, `${label}: no data`);
    return result.data;
  };
  const capabilitiesResponse = await fetch(`${process.env.PUBLISHING_SERVICE_URL}/v1/publishing/channels`);
  assert.equal(capabilitiesResponse.status, 200);
  const capabilities = await capabilitiesResponse.json();
  for (const channel of ['kdp', 'apple', 'barnesnoble', 'lulu', 'googleplay']) {
    assert.equal(capabilities[channel].canSubmit, false);
    assert.equal(capabilities[channel].canCheckStatus, false);
  }

  const book = await request(alice.token, 'POST', '/books', { workspaceId: alice.workspace.id,
    requestId: randomUUID(), title: 'Harbor Letters', authorName: 'Synthetic Author', language: 'en' }, 201);
  const text = Array.from({ length: 32 }, (_, index) =>
    `Chapter ${index + 1}\n\nHarbor letter ${index + 1} arrived safely. Mira read the message by the lighthouse.`).join('\n\n');
  const manuscript = await upload(alice, 'retailer-manuscript.txt', 'text/plain', Buffer.from(text));
  await confirm(alice, manuscript);
  const queued = await request(alice.token, 'POST', `/books/${book.id}/import-jobs`, { assetId: manuscript.assetId }, 202);
  const imported = await runOneDocumentJob(service);
  assert.equal(imported.status, 'succeeded'); assert.equal(imported.jobId, queued.job.id);
  const chapters = await request(alice.token, 'GET', `/books/${book.id}/chapters`);
  assert.equal(chapters.chapters.length, 32);
  const listing = { expectedUpdatedAt: null, description: 'A mystery told through letters at a coastal harbor.',
    keywords: ['harbor', 'letters'], categories: ['FICTION / Mystery & Detective / General'] };
  const metadata = await request(alice.token, 'PUT', `/books/${book.id}/metadata`, listing);
  const cover = await upload(alice, 'retailer-cover.png', 'image/png', artwork, 'cover');
  assert.equal((await confirm(alice, cover)).scanStatus, 'clean');
  console.log('PASS native retailer fixture uses an imported 32-chapter manuscript, saved listing and real scanned cover');

  const coverConfig = { asset_id: cover.assetId, qr_code: {
    enabled: true, url: 'https://example.com/harbor', label: 'Author website',
  } };
  const front = { copyright_notice: 'Synthetic acceptance fixture. Not for retail sale.', publisher: 'Fixture Press' };
  const printConfig = { kind: 'print', trim_size: '6x9', bleed_in: 0.125, bleed_edges: 'outer',
    include_table_of_contents: true, cover: coverConfig, front_matter: front,
    typography: { body_font: 'BookwormVera', heading_font: 'BookwormVera-Bold' },
    wrap_cover: { enabled: true, profile: 'kdp-white' } };
  const editions = [
    { config: { kind: 'ebook', navigation: 'toc+landmarks', include_title_page: true, cover: coverConfig, front_matter: front },
      channels: ['kdp', 'apple', 'barnesnoble', 'googleplay'] },
    { config: printConfig, channels: ['kdp'] },
    { config: { ...printConfig,
      wrap_cover: { enabled: true, profile: 'custom', expected_page_count: 36, spine_width_in: 0.1 } }, channels: ['barnesnoble'] },
    { config: { ...printConfig, bleed_edges: 'all',
      wrap_cover: { enabled: true, profile: 'custom', expected_page_count: 36, spine_width_in: 0.1 } }, channels: ['lulu'] },
  ];
  const packages = [];
  let granted = false;
  for (const { config, channels } of editions) {
    const edition = await request(alice.token, 'POST', `/books/${book.id}/editions`, { config }, 201);
    const render = await request(alice.token, 'POST', `/editions/${edition.id}/render`, { idempotencyKey: randomUUID() }, 201);
    assert.equal(render.status, 'succeeded'); assert.equal(render.artifacts.length, 2);
    const sourceFiles = Object.fromEntries(render.artifacts.map(({ role, asset }) => [
      role === 'rendered_cover' ? (config.kind === 'ebook' ? 'cover.png' : 'cover.pdf')
        : config.kind === 'ebook' ? 'book.epub' : 'book.pdf', asset,
    ]));
    for (const channel of channels) {
      const validation = await request(alice.token, 'POST', '/publishing/validate', {
        bookId: book.id, editionId: edition.id, channel, idempotencyKey: randomUUID(),
      }, 201);
      assert.equal(validation.errors, 0, `${channel} ${config.kind}: ${validation.findings.map(item => item.code).join(', ')}`);
      const intent = { bookId: book.id, editionId: edition.id, channel, renderJobId: render.jobId,
        preflightJobId: validation.jobId, idempotencyKey: randomUUID() };
      await request(bob.token, 'POST', '/publishing/jobs', intent, 404);
      if (!granted) {
        const denied = await request(alice.token, 'POST', '/publishing/jobs', intent, 422);
        assert.equal(denied.error.code, 'publishing_channel_not_in_plan');
        // An unpublished, disposable fixture entitlement only. No checkout,
        // commercial seed, provider ID, generation credit or live plan change.
        const plan = data(await service.from('plans').insert({ name: 'Native retailer fixture', billing_period: 'monthly',
          price_cents: 1, is_active: false, entitlements_json: { publishing_channels: ['kdp', 'apple_books', 'barnes_noble', 'google_play', 'lulu'] },
        }).select('id').single(), 'fixture entitlement');
        data(await service.from('subscriptions').insert({ organization_id: alice.workspace.organization_id,
          plan_id: plan.id, status: 'active' }).select('id').single(), 'fixture subscription');
        granted = true;
        console.log('PASS native retailer export denied before isolated non-AI fixture entitlement; no checkout or payment');
      }
      const packaged = await request(alice.token, 'POST', '/publishing/jobs', intent, 201);
      assert.equal(packaged.status, 'succeeded'); assert.equal(packaged.submissionMode, 'manual');
      assert.equal(packaged.sourceRenderJobId, render.jobId); assert.equal(packaged.sourcePreflightJobId, validation.jobId);
      assert.equal(packaged.ruleVersion, validation.ruleVersion);
      const artifact = packaged.package;
      assert.equal(artifact.asset.mime_type, 'application/zip'); assert.equal(artifact.download.expiresIn, 300);
      const downloaded = await fetch(artifact.download.url);
      assert.equal(downloaded.status, 200);
      const bytes = Buffer.from(await downloaded.arrayBuffer());
      assert.equal(bytes.length, Number(artifact.asset.size_bytes)); assert.equal(hash(bytes), artifact.asset.checksum);
      const archive = inspectNativePackage(bytes);
      assert.deepEqual(Object.keys(archive.files).sort(), [...Object.keys(sourceFiles), 'README.txt', 'metadata.json', 'preflight.json', 'manifest.json'].sort());
      for (const [filename, source] of Object.entries(sourceFiles)) {
        assert.equal(archive.files[filename].sha256, source.checksum, 'Package replaced the saved render or cover');
        assert.equal(archive.files[filename].size, Number(source.size_bytes));
      }
      assert.equal(archive.manifest.channel, channel); assert.equal(archive.manifest.errors, 0);
      assert.equal(archive.manifest.ruleVersion, validation.ruleVersion);
      const checkedFiles = Object.keys(archive.files).filter(name => name !== 'manifest.json');
      assert.deepEqual(Object.keys(archive.manifest.files).sort(), checkedFiles.sort());
      for (const name of checkedFiles) assert.equal(archive.manifest.files[name], archive.files[name].sha256);
      assert.equal(archive.preflight.channel, channel); assert.equal(archive.preflight.errors, 0);
      assert.equal(archive.preflight.ruleVersion, packaged.ruleVersion);
      assert.equal(archive.preflight.warnings, archive.preflight.findings.filter(item => item.severity === 'warning').length);
      assert.equal(archive.metadata.metadata.title, book.title);
      assert.equal(archive.metadata.metadata.description, listing.description);
      assert.deepEqual(archive.metadata.metadata.keywords, listing.keywords);
      assert.deepEqual(archive.metadata.metadata.categories, listing.categories);
      assert.match(archive.readme, /NOT been submitted, published or approved/);
      assert.ok(!('bookBible' in archive.metadata) && !('chapters' in archive.metadata));
      const replay = await request(alice.token, 'POST', '/publishing/jobs', intent);
      assert.equal(replay.id, packaged.id); assert.equal(replay.package.asset.id, artifact.asset.id);
      const recovered = await request(alice.token, 'GET', `/publishing/jobs/${packaged.id}`);
      assert.equal(recovered.package.asset.checksum, hash(bytes));
      const history = await request(alice.token, 'GET', `/publishing/jobs?bookId=${book.id}&editionId=${edition.id}&channel=${channel}`);
      assert.deepEqual(history.jobs.map(item => item.id), [packaged.id]);
      await request(bob.token, 'GET', `/publishing/jobs/${packaged.id}`, undefined, 404);
      await request(bob.token, 'GET', `/publishing/jobs?bookId=${book.id}`, undefined, 404);
      await request(bob.token, 'GET', `/assets/${artifact.asset.id}/download-url`, undefined, 404);
      assert.ok((await bob.client.storage.from('book-assets').download(artifact.asset.storage_path)).error);
      assert.ok((await bob.client.storage.from('book-assets').createSignedUrl(artifact.asset.storage_path, 60)).error);
      if (packages.length) await request(alice.token, 'POST', '/publishing/jobs', {
        ...intent, idempotencyKey: packages[0].intent.idempotencyKey,
      }, 409);
      packages.push({ id: packaged.id, checksum: hash(bytes), intent });
      console.log(`PASS native ${channel} ${config.kind} private ZIP, exact artifact/cover/manifest/listing, replay, history and tenant refusal`);
    }
  }
  await request(alice.token, 'PUT', `/books/${book.id}/metadata`, {
    ...listing, expectedUpdatedAt: metadata.metadata.updated_at, description: 'A later listing edit must not rewrite the saved packages.',
  });
  for (const saved of packages) {
    await request(alice.token, 'POST', '/publishing/jobs', saved.intent, 422);
    const recovered = await request(alice.token, 'GET', `/publishing/jobs/${saved.id}`);
    const response = await fetch(recovered.package.download.url);
    assert.equal(response.status, 200);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), saved.checksum);
  }
  const usage = data(await service.from('usage_events').select('meter,quantity'), 'retailer usage');
  assert.equal(usage.length, 15); // Four prior author renders, four retailer renders, seven packages.
  for (const [meter, count] of [['rendering', 8], ['publishing', 7]]) {
    assert.equal(usage.filter(row => row.meter === meter).length, count);
  }
  assert.ok(usage.every(row => Number(row.quantity) === 1));
  assert.deepEqual(data(await service.from('ai_jobs').select('id'), 'AI jobs'), []);
  assert.deepEqual(data(await service.from('credit_ledger').select('id'), 'credit ledger'), []);
  console.log('PASS native seven immutable retailer packages, stale-source refusal, exact render/package usage and zero AI jobs or credit charges');
}
