// Invoked only by the isolated Python harness. Cover decoding is real; database,
// narration assembly and object storage are synthetic and do not prove retailer acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { runOneGooglePlayAudioExport } = await import(pathToFileURL(join(process.cwd(), 'services/api/src/lib/audiobook-google-play-export-worker.ts')).href);
const sha = data => createHash('sha256').update(data).digest('hex');
const id = n => `e7000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [job, workspace, book, edition, chapter, version, project, report, cover, audio, actor, lease] = Array.from({ length: 12 }, (_, n) => id(n + 1));
const directory = process.env.BOOKWORM_COVER_FIXTURES;
const origin = process.env.RENDERING_SERVICE_URL;
assert(directory && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin || ''), 'isolated fixture required');

async function exercise(format, scenario) {
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const valid = await readFile(join(directory, `valid.${format}`));
  const malformed = await readFile(join(directory, `truncated.${format}`));
  const pinned = scenario === 'malformed' ? malformed : valid;
  const delivered = scenario === 'hash-mismatch' ? Buffer.from(valid) : pinned;
  if (scenario === 'hash-mismatch') delivered[delivered.length - 1] ^= 1;
  const segment = Buffer.from('ID3 synthetic private segment');
  const assembled = Buffer.from('ID3 synthetic assembled audio');
  const manifest = sha(JSON.stringify({ projectId: project, documentVersionId: version,
    assets: [{ id: audio, checksum: sha(segment), sizeBytes: segment.length }] }));
  const coverPath = `workspaces/fixture/assets/cover.${format}`;
  const snapshot = { title: 'Synthetic book', author: 'Fixture author', coverMimeType: mime,
    coverStoragePath: coverPath, coverSizeBytes: pinned.length, coverSha256: sha(pinned),
    chapters: [{ chapterId: chapter, orderIndex: 0, title: 'Chapter 1', documentVersionId: version,
      projectId: project, reportId: report, sourceManifestSha256: manifest, audioSha256: sha(assembled) }] };
  const tables = {
    editions: [{ id: edition, book_id: book, type: 'audiobook' }],
    books: [{ id: book, workspace_id: workspace, title: snapshot.title, author_name: snapshot.author }],
    chapters: [{ id: chapter, book_id: book, order_index: 0, title: 'Chapter 1', current_document_version_id: version }],
    assets: [{ id: cover, workspace_id: workspace, storage_path: coverPath, mime_type: mime, size_bytes: pinned.length,
      checksum: sha(pinned), deleted_at: null }, { id: audio, workspace_id: workspace, storage_path: `workspaces/${workspace}/audiobooks/${project}/0.mp3`,
      mime_type: 'audio/mpeg', type: 'audiobook_segment', size_bytes: segment.length, checksum: sha(segment), deleted_at: null }],
    asset_versions: [{ asset_id: cover, storage_path: coverPath, checksum: sha(pinned), mime_type: mime,
      size_bytes: pinned.length, scan_status: 'clean' }],
    audiobook_projects: [{ id: project, workspace_id: workspace, book_id: book, edition_id: edition, chapter_id: chapter,
      document_version_id: version, status: 'succeeded', segment_count: 1 }],
    audiobook_segments: [{ project_id: project, segment_index: 0, asset_id: audio, completed_at: '2026-09-23T00:00:00Z' }],
    audiobook_qc_reports: [{ id: report, project_id: project, document_version_id: version,
      source_manifest_sha256: manifest, audio_sha256: sha(assembled) }],
    audiobook_qc_signoffs: [{ report_id: report }],
  };
  const claim = { id: job, workspace_id: workspace, book_id: book, edition_id: edition, created_by: actor,
    identifier: '9780306406157', cover_asset_id: cover, lease_token: lease, progress_total: 1, attempts: 1, snapshot_json: snapshot };
  const calls = [], uploads = [], inspections = [];
  let assemblies = 0;
  let failure;
  const sb = {
    from(table) {
      const filters = [];
      const rows = () => (tables[table] ?? []).filter(row => filters.every(fn => fn(row)));
      const query = { select: () => query, eq: (key, value) => { filters.push(row => row[key] === value); return query; },
        is: (key, value) => { filters.push(row => row[key] === value); return query; },
        in: (key, values) => { filters.push(row => values.includes(row[key])); return query; },
        order: () => query, limit: () => query,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: resolve => resolve({ data: rows(), error: null }) };
      return query;
    },
    storage: { from: () => ({ download: async path => ({ data: new Blob([path === coverPath ? delivered : segment]), error: null }),
      remove: async () => { throw new Error('unexpected object deletion'); } }) },
    rpc: async (name, args) => {
      calls.push(name);
      if (name === 'claim_audiobook_google_play_export') return { data: claim, error: null };
      if (name === 'progress_audiobook_google_play_export') return { data: true, error: null };
      if (name === 'complete_audiobook_google_play_export') return { data: { id: job, status: 'succeeded',
        output_storage_path: args.p_storage_path, output_sha256: args.p_sha256 }, error: null };
      if (name === 'fail_audiobook_google_play_export') {
        failure = args.p_error_code;
        return { data: { id: job, status: args.p_retryable ? 'queued' : 'failed', lease_token: null,
          lease_expires_at: null, output_storage_path: null }, error: null };
      }
      throw new Error(`unexpected synthetic RPC ${name}`);
    },
  };
  const quality = { schemaVersion: 1, profile: 'technical preflight', chapterDurationSeconds: 300,
    sampleRateHz: 44100, channels: 1, bitRateKbps: 192, bitRateMode: 'cbr', rmsDbfs: -20, samplePeakDbfs: -4,
    technicalChecks: { noise: { status: 'manual_review', value: null, limit: 'human review' } }, reviewRequired: true,
    acxNarrationPolicy: 'explicit_authorization_required_for_ai_voice' };
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/images/inspect-cover') {
      assert.equal(url.origin, origin, 'private cover bytes must stay on owned loopback');
      assert.equal(new Headers(init.headers).get('x-service-token'), 'synthetic-cover-token');
      assert.equal(init.redirect, 'error', 'cover inspection must not follow cross-origin redirects');
      const response = await fetch(url, init); inspections.push(response.status);
      if (scenario === 'receipt-mismatch' && response.ok) {
        const value = await response.json(); value.sha256 = '0'.repeat(64); return Response.json(value);
      }
      return response;
    }
    if (url.pathname === '/audio/assemble') {
      assert.equal(url.origin, origin);
      assemblies++;
      return new Response(assembled, { headers: { 'x-artifact-sha256': sha(assembled), 'x-bookworm-audio-qc': JSON.stringify(quality) } });
    }
    assert.equal(url.origin, 'https://project-ref.storage.supabase.co');
    if (init?.method === 'POST') return new Response(null, { status: 201, headers: { location: '/storage/v1/upload/resumable/synthetic' } });
    if (init?.method === 'PATCH') {
      const chunk = Buffer.from(init.body); uploads.push(chunk);
      const offset = Number(new Headers(init.headers).get('upload-offset'));
      return new Response(null, { status: 204, headers: { 'upload-offset': String(offset + chunk.length) } });
    }
    throw new Error('unexpected network request');
  };
  const result = await runOneGooglePlayAudioExport(sb, { fetcher, storage: { projectUrl: 'https://project-ref.supabase.co', serviceKey: 'synthetic-service-key' } });
  if (scenario === 'valid') {
    assert.equal(result.status, 'succeeded', JSON.stringify({ failure, calls, inspections })); assert.deepEqual(inspections, [200]);
    const zip = Buffer.concat(uploads); let offset = 0, matched = 0;
    while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
      const size = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26), extraLength = zip.readUInt16LE(offset + 28);
      const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
      const start = offset + 30 + nameLength + extraLength;
      assert(start + size <= zip.length, 'ZIP entry must be complete');
      if (name.startsWith('Cover/')) { assert.deepEqual(zip.subarray(start, start + size), valid); matched++; }
      offset = start + size;
    }
    assert.equal(matched, 1, 'exactly one ZIP entry must contain the original cover bytes');
    assert(calls.includes('complete_audiobook_google_play_export'));
  } else {
    assert.equal(result.status, scenario === 'receipt-mismatch' ? 'queued' : 'failed');
    assert.equal(failure, scenario === 'malformed' ? 'export_cover_decode_failed' : scenario === 'hash-mismatch' ? 'export_cover_integrity_failed' : 'export_cover_inspection_invalid');
    assert.deepEqual(inspections, scenario === 'hash-mismatch' ? [] : [scenario === 'malformed' ? 422 : 200]);
    assert.equal(uploads.length, 0, 'invalid covers must never reach archive upload');
    assert.equal(assemblies, 0, 'invalid covers must stop before narration assembly');
    assert(!calls.includes('complete_audiobook_google_play_export'));
  }
}

for (const format of ['png', 'jpeg']) for (const scenario of ['valid', 'malformed', 'hash-mismatch', 'receipt-mismatch']) {
  test(`${format}: ${scenario} cover uses real decoding before upload`, () => exercise(format, scenario));
}
