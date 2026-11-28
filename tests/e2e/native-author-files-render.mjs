/** Actual renderer, private Storage and saved proof routes. No provider or retailer calls. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { requireNativeAuthorRunner } from './native-author-files-guard.mjs';

export async function runNativeAuthorRenders({ request, service, alice, bob, book, chapter }) {
  requireNativeAuthorRunner();
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const chapters = await request(alice.token, 'GET', `/books/${book.id}/chapters`);
  const imported = chapters.chapters.find(value => value.id === chapter.chapterId);
  assert.ok(imported?.title, 'Imported chapter missing from the saved book');
  const proofs = [];
  for (const kind of ['ebook', 'print']) {
    const config = kind === 'ebook' ? { kind } : { kind, typography: { body_font: 'BookwormVera', heading_font: 'BookwormVera-Bold' } };
    const edition = await request(alice.token, 'POST', `/books/${book.id}/editions`, { config }, 201);
    const key = { idempotencyKey: randomUUID() };
    const renderPath = `/editions/${edition.id}/render`;
    await request(bob.token, 'POST', renderPath, key, 404);
    const result = await request(alice.token, 'POST', renderPath, key, 201);
    assert.equal(result.status, 'succeeded');
    const artifact = result.artifacts.find(value => value.role === (kind === 'ebook' ? 'rendered_ebook' : 'rendered_print'));
    assert.ok(artifact);
    assert.equal(artifact.download.expiresIn, 300);
    const bytesResponse = await fetch(artifact.download.url);
    assert.equal(bytesResponse.status, 200);
    const bytes = Buffer.from(await bytesResponse.arrayBuffer());
    assert.ok(bytes.subarray(0, kind === 'ebook' ? 2 : 5).equals(Buffer.from(kind === 'ebook' ? 'PK' : '%PDF-')));
    assert.equal(hash(bytes), artifact.asset.checksum);
    assert.ok((await bob.client.storage.from('book-assets').download(artifact.asset.storage_path)).error);
    await request(bob.token, 'GET', `/assets/${artifact.asset.id}/download-url`, undefined, 404);
    const replay = await request(alice.token, 'POST', renderPath, key);
    assert.equal(replay.jobId, result.jobId);
    assert.equal(replay.artifacts[0].asset.id, result.artifacts[0].asset.id);

    const historyPath = `/editions/${edition.id}/${kind === 'ebook' ? 'renders' : 'print-renders'}`;
    await request(bob.token, 'GET', historyPath, undefined, 404);
    const history = await request(alice.token, 'GET', historyPath);
    assert.equal(history.renders.length, 1);
    const proof = history.renders[0];
    assert.equal(proof.jobId, result.jobId); assert.equal(proof.source.sha256, hash(bytes));
    assert.equal(proof.source.sizeBytes, bytes.length);
    let savedPath = kind === 'ebook'
      ? `${historyPath}/${proof.jobId}/reader?spine=0&sha256=${proof.source.sha256}`
      : `${historyPath}/${proof.jobId}/download?sha256=${proof.source.sha256}&fingerprint=${proof.fingerprint}`;
    await request(bob.token, 'GET', savedPath, undefined, 404);
    await request(alice.token, 'GET', savedPath.replace(proof.source.sha256, '0'.repeat(64)), undefined, 409);
    let saved = await request(alice.token, 'GET', savedPath);
    if (kind === 'ebook') {
      assert.deepEqual(saved.source, proof.source);
      assert.match(saved.document.title, /— Contents$/);
      // Navigation/front matter precede the manuscript in the real EPUB spine.
      const sections = saved.spine.filter(value => value.title === imported.title);
      assert.equal(sections.length, 1, 'Imported chapter missing or ambiguous in the saved EPUB');
      assert.ok(sections[0].index > 0);
      savedPath = savedPath.replace('spine=0&', `spine=${sections[0].index}&`);
      await request(bob.token, 'GET', savedPath, undefined, 404);
      saved = await request(alice.token, 'GET', savedPath);
      assert.deepEqual(saved.source, proof.source);
      assert.equal(saved.document.index, sections[0].index);
      assert.match(saved.document.html, /Captain/);
      assert.match(saved.document.html, /Author reviewed and revised this manuscript\./);
      assert.ok(saved.document.resources.length > 0, 'Imported illustration absent from saved EPUB reader');
      const image = saved.document.resources[0];
      const resource = await request(alice.token, 'GET', `${historyPath}/${proof.jobId}/reader/resources/${image.index}?sha256=${proof.source.sha256}`);
      assert.equal(hash(Buffer.from(resource.resource.base64, 'base64')), image.sha256);
    } else {
      assert.equal(saved.jobId, result.jobId);
      const reread = await fetch(saved.artifacts[0].download.url);
      assert.equal(reread.status, 200);
      assert.deepEqual(Buffer.from(await reread.arrayBuffer()), bytes);
      const pagePath = `${historyPath}/${proof.jobId}/pages/1?sha256=${proof.source.sha256}&fingerprint=${proof.fingerprint}&assetId=${proof.source.assetId}&width=720`;
      await request(bob.token, 'GET', pagePath, undefined, 404);
      await request(alice.token, 'GET', pagePath.replace(proof.source.sha256, '0'.repeat(64)), undefined, 409);
      const page = await request(alice.token, 'GET', pagePath);
      assert.equal(page.formatVersion, 'pdf-proof-1.0.0'); assert.equal(page.sourceSha256, hash(bytes));
      assert.deepEqual(page.source, { ...proof.source, role: 'rendered_print' });
      assert.equal(page.fingerprint, proof.fingerprint); assert.equal(page.pageNumber, 1); assert(page.pageCount >= 2);
      const png = Buffer.from(page.image.base64, 'base64'); assert.equal(hash(png), page.image.sha256);
      assert.equal(png.length, page.image.sizeBytes); assert.equal(page.image.mimeType, 'image/png');
      assert.equal(png.readUInt32BE(16), page.image.width); assert.equal(png.readUInt32BE(20), page.image.height);
      assert.equal(page.image.width, 720); assert(page.image.height > 0 && page.image.height <= 4096);
    }

    const intent = { bookId: book.id, editionId: edition.id, channel: 'export', idempotencyKey: randomUUID() };
    const preflight = await request(alice.token, 'POST', '/publishing/validate', intent, 201);
    assert.ok(preflight.jobId && preflight.ruleVersion);
    assert.equal(preflight.requestedChannel, 'export');
    assert.ok(Number.isInteger(preflight.errors) && Array.isArray(preflight.findings));
    assert.deepEqual(await request(alice.token, 'POST', '/publishing/validate', intent), preflight);
    await request(bob.token, 'POST', '/publishing/validate', intent, 404);
    proofs.push({ renderPath, key, savedPath, intent, kind, sha256: hash(bytes) });
    console.log(`PASS native ${kind} render, private byte-exact download, replay, saved proof, preflight and tenant refusal`);
  }

  // Existing proofs remain readable, but changed manuscript content cannot reuse
  // an earlier rendering/preflight request key or silently replace its bytes.
  await request(alice.token, 'PUT', `/chapters/${chapter.chapterId}/document`, {
    expectedVersion: chapter.version, operationId: randomUUID(),
    nodes: [...chapter.nodes, { id: randomUUID(), type: 'paragraph', text: 'A later edit must not rewrite saved proofs.' }],
  });
  for (const proof of proofs) {
    await request(alice.token, 'POST', proof.renderPath, proof.key, 409);
    await request(alice.token, 'POST', '/publishing/validate', proof.intent, 409);
    const saved = await request(alice.token, 'GET', proof.savedPath);
    if (proof.kind === 'ebook') {
      assert.equal(saved.source.sha256, proof.sha256);
      assert.ok(!saved.document.html.includes('A later edit must not rewrite saved proofs.'));
    } else {
      const response = await fetch(saved.artifacts[0].download.url);
      assert.equal(response.status, 200);
      assert.equal(hash(Buffer.from(await response.arrayBuffer())), proof.sha256);
    }
  }
  const usage = await service.from('usage_events').select('meter,quantity');
  assert.equal(usage.error, null);
  assert.equal(usage.data.length, 4); // One EPUB and PDF each through the browser and API.
  assert.ok(usage.data.every(row => row.meter === 'rendering' && Number(row.quantity) === 1));
  const jobs = await service.from('ai_jobs').select('id');
  assert.equal(jobs.error, null); assert.deepEqual(jobs.data, []);
  console.log('PASS native immutable saved proofs after edits, stale render/preflight refusal, exact rendering usage and zero AI jobs');
}
