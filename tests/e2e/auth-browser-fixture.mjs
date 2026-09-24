/** Isolated browser-test dependency, never imported by application code.
 * GoTrue-compatible test responses exercise the real SSR SDK and cookie/BFF
 * flow. This does NOT prove live provider or production database integration.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const user = { id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated', email: 'author@example.test', app_metadata: {}, user_metadata: { display_name: 'Fixture author' }, created_at: '2026-01-01T00:00:00Z' };
const tokens = new Set();
const workspaces = [];
const setupBooks = [];
const setupUploads = new Map();
const setupCounts = { books: 0, assets: 0, allocationRequests: 0, uploads: 0, confirmations: 0, imports: 0, reportReads: 0, jobReads: 0, jobRetries: 0 };
const setupReceipts = new Map();
const setupJobs = new Map();
const draftChapters = new Map();
const chapterKeys = new Map();
const aiReviews = new Map();
const aiKeys = new Map();
const publishingEditions = new Map();
const publishingPackages = [];
const publishingRenders = new Map();
const publishingChecks = new Map();
const publishingAudioQcReports = [];
const audioExports = new Map();
const audioExportKeys = new Map();
let lostExportReply = false;
let chapterDownloadAttempts = 0;
const fixtureFiles = new Map();
function fixtureDownload(name) {
  const token = randomUUID(); fixtureFiles.set(token, name);
  return { url: `http://127.0.0.1:4399/fixture-artifact?token=${token}`, expiresIn: 300 };
}
let lostChapterReply = false;
let lostBookReply = false;
let refusedBookBeforeAcceptance = false;
let lostUploadAllocationReply = false;
let lostUploadPutReply = false;
let lostAiReply = false;
const memoryBookId = '88888888-8888-4888-8888-888888888888';
const memoryBook = { id: memoryBookId, workspace_id: '33333333-3333-4333-8333-333333333333', title: 'The Long Way Home', subtitle: null, author_name: 'Fixture author', language: 'en', genre: 'Fantasy', status: 'draft', updated_at: '2026-08-31T08:00:00.000Z' };
const memoryItems = [];
let memoryMetadata = null;
const adminFlags = [{ id: 'flag-preview', key: 'editor-preview', scope_type: 'workspace', scope_id: 'workspace-fixture', enabled: false, config_json: { rollout: 50 } }];
const adminTickets = [{ id: 'ticket-fixture', subject: 'Export help', body: 'Please help me prepare my print edition.', category: 'publishing', priority: 'normal', status: 'open', user_id: user.id, created_at: '2026-09-05T00:00:00Z' }];
const adminAudit = [];
const dataRequests = [];
let referralClaimed = false;
const memoryChapters = [{ id: '44444444-4444-4444-8444-444444444444', title: 'Arrival', current_document_version_id: '66666666-6666-4666-8666-666666666666' }];
const memoryImages = [{ id: '55555555-5555-4555-8555-555555555555', name: 'Elara reference.png', mime_type: 'image/png' }];
const manuscript = { chapterId: memoryChapters[0].id, version: 1, nodes: [
  { id: 'intro', type: 'heading', level: 1, text: 'The harbor at first light' },
  { id: 'opening', type: 'paragraph', text: 'Elara arrived before the bells. The harbor was quiet, and a silver compass rested in her palm.' },
  { id: 'second', type: 'paragraph', text: 'Across the water, the city was beginning to wake. She opened the letter one last time.' },
] };
const manuscriptHistory = [{ id: randomUUID(), chapter_id: manuscript.chapterId, version_number: 1, plain_text: manuscript.nodes.map((n) => n.text).join('\n\n'), word_count: 50, created_at: new Date().toISOString(), change_summary: 'Initial manuscript' }];
const savedOperations = new Map();
const previewTokens = new Set();
function session() {
  const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now()/1000)+3600, aud: 'authenticated', jti: randomUUID() })).toString('base64url')}.test-only-signature`;
  tokens.add(token);
  return { access_token: token, refresh_token: 'fixture-refresh-token', token_type: 'bearer', expires_in: 3600, user };
}
const server = createServer(async (req, res) => {
  function json(status, body) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
  const url = new URL(req.url, 'http://127.0.0.1:4399');
  if (url.pathname.startsWith('/fixture-upload/')) {
    const uploadOrigin = req.headers.origin;
    if (uploadOrigin === 'http://127.0.0.1:4398' || uploadOrigin === 'http://localhost:4398') res.setHeader('access-control-allow-origin', uploadOrigin);
    res.setHeader('access-control-allow-methods', 'PUT, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const entry = setupUploads.get(url.pathname.split('/').pop());
    if (!entry || url.searchParams.get('token') !== entry.token || req.method !== 'PUT') return json(403, {});
    let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 16384) return json(413, {}); }
    entry.uploaded = length === entry.sizeBytes; setupCounts.uploads++;
    if (entry.uploaded && process.env.FIXTURE_LOST_UPLOAD_PUT_REPLY === 'true' && !lostUploadPutReply) {
      lostUploadPutReply = true;
      return json(503, { error: { message: 'Fixture lost PUT reply after storing bytes' } });
    }
    return json(entry.uploaded ? 200 : 422, {});
  }
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 16384) { json(413, {}); return; } }
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { json(400, {}); return; }
  const authorized = tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''));
  if (url.pathname === '/health') return json(200, { fixture: true });
  if (process.env.FIXTURE_PUBLISHING === 'true' && url.pathname === '/fixture-export-state') {
    if (req.method === 'POST' && ['running', 'succeeded'].includes(body.status)) {
      for (const job of audioExports.values()) if (['queued', 'running'].includes(job.status)) {
        job.status = body.status;
        if (body.status === 'succeeded') Object.assign(job, { progressChapters: 1, archiveSizeBytes: 100, totalDurationSeconds: 30, completedAt: new Date().toISOString() });
      }
    }
    return json(200, { jobs: [...audioExports.values()], keys: [...audioExportKeys.keys()] });
  }
  if (url.pathname === '/fixture-artifact' && fixtureFiles.has(url.searchParams.get('token'))) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture-artifact.txt"', 'cache-control': 'no-store' });
    return res.end(`UI acceptance fixture only: ${fixtureFiles.get(url.searchParams.get('token'))}`);
  }
  if (url.pathname === '/fixture-setup-counts') return json(200, setupCounts);
  if (url.pathname === '/fixture-image' && previewTokens.has(url.searchParams.get('token'))) {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  }
  if (url.pathname === '/auth/v1/token') {
    if (body.email === user.email && body.password === 'fixture-password' || body.refresh_token === 'fixture-refresh-token') return json(200, session());
    return json(400, { code: 'invalid_credentials', message: 'Invalid login credentials' });
  }
  if (url.pathname === '/auth/v1/signup') return json(200, { ...user, email: body.email, identities: [] });
  if (url.pathname === '/auth/v1/recover') return json(200, {});
  if (url.pathname === '/auth/v1/user') return authorized ? json(200, user) : json(401, { code: 'bad_jwt', message: 'Invalid token' });
  if (url.pathname === '/auth/v1/logout') {
    tokens.delete((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    res.writeHead(204); return res.end();
  }
  if (!authorized) return json(401, { error: { code: 'unauthenticated', message: 'Fixture requires authentication' } });
  if (process.env.FIXTURE_PUBLISHING === 'true') {
    if (url.pathname === `/v1/books/${memoryBookId}/editions`) {
      if (req.method === 'GET') return json(200, { editions: [...publishingEditions.values()] });
      const edition = { id: randomUUID(), book_id: memoryBookId, type: body.config.kind, language: body.language, status: 'draft', edition_metadata_json: body.config, updated_at: new Date().toISOString() };
      publishingEditions.set(edition.id, edition); return json(201, edition);
    }
    const edition = publishingEditions.get(url.pathname.split('/')[3]);
    const exportSummary = (job) => ({ ...job, downloadUrl: job.status === 'succeeded' ? fixtureDownload('Google Play synthesized-voice ZIP').url : null, downloadExpiresIn: job.status === 'succeeded' ? 300 : null });
    if (edition && req.method === 'GET' && url.pathname.endsWith('/audiobook-google-play-exports')) {
      return json(200, { jobs: [...audioExports.values()].filter((job) => job.editionId === edition.id).map(exportSummary) });
    }
    if (req.method === 'POST' && /^\/v1\/audiobook-google-play-exports\/[^/]+\/cancel$/.test(url.pathname)) {
      const job = audioExports.get(url.pathname.split('/')[3]);
      if (!job) return json(404, {});
      job.status = 'cancelled'; job.completedAt = new Date().toISOString();
      return json(200, { job: exportSummary(job) });
    }
    if (edition && req.method === 'POST' && url.pathname.endsWith('/audiobook-google-play-export')) {
      if (edition.type !== 'audiobook' || body.identifier !== '9780306406157' || body.coverAssetId !== memoryImages[0].id
        || !publishingAudioQcReports.some((report) => report.isCurrentSource && report.signoffs.some((signoff) => signoff.reviewerId === user.id))) {
        return json(409, { error: { message: 'Fixture requires the signed-off audiobook and selected cover.' } });
      }
      if (!body.idempotencyKey) return json(422, { error: { message: 'Export request key required.' } });
      let job = audioExports.get(audioExportKeys.get(body.idempotencyKey));
      if (!job) {
        job = { id: randomUUID(), editionId: edition.id, status: 'queued', progressChapters: 0, progressTotal: 1,
          createdAt: new Date().toISOString(), completedAt: null, errorCode: null, archiveSizeBytes: null,
          totalDurationSeconds: null, synthesizedVoiceDisclosureRequired: true };
        audioExports.set(job.id, job); audioExportKeys.set(body.idempotencyKey, job.id);
      }
      if (!lostExportReply) { lostExportReply = true; return json(503, { error: { message: 'Fixture export reply lost. Retry safely.' } }); }
      return json(202, { job: exportSummary(job) });
    }
    if (edition && req.method === 'GET' && url.pathname.endsWith('/audiobook-jobs')) {
      return json(200, { projects: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', editionId: edition.id, chapterId: memoryChapters[0].id,
        documentVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', voice: 'marin', speed: 1, status: 'succeeded', segmentCount: 2,
        creditUnits: 2, createdAt: '2026-09-18T00:00:00Z', completedAt: '2026-09-18T00:01:00Z', aiVoiceDisclosureRequired: true, segments: [] }] });
    }
    if (url.pathname === '/v1/audiobook-jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/audio-download') {
      if (++chapterDownloadAttempts === 1) return json(503, { error: { message: 'Fixture assembly busy. Try again.' } });
      const reportId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const quality = { schemaVersion: 1, profile: 'ACX technical preflight; not retailer approval', chapterDurationSeconds: 30,
        sampleRateHz: 44100, channels: 1, bitRateKbps: 192, bitRateMode: 'cbr', rmsDbfs: -20, samplePeakDbfs: -4,
        technicalChecks: { rms: { status: 'pass', value: -20, unit: 'dBFS', limit: '-23 to -18 dB RMS' },
          noiseFloor: { status: 'manual_review', value: null, limit: 'listening required' } }, reviewRequired: true,
        acxNarrationPolicy: 'explicit_authorization_required_for_ai_voice' };
      if (!publishingAudioQcReports.some((report) => report.id === reportId)) publishingAudioQcReports.push({
        id: reportId, projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', documentVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        audioSha256: 'a'.repeat(64), sourceManifestSha256: 'b'.repeat(64), qualityReport: quality,
        createdBy: user.id, createdAt: '2026-09-23T00:00:00Z', isCurrentSource: true, signoffs: [], signedByMe: false,
      });
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-disposition': 'attachment; filename="chapter.mp3"', 'cache-control': 'private, no-store',
        'x-bookworm-audio-sha256': 'a'.repeat(64), 'x-bookworm-audio-qc-report-id': reportId,
        'x-bookworm-audio-qc': JSON.stringify(quality) });
      return res.end(Buffer.from('ID3browser-audio-fixture'));
    }
    if (url.pathname === '/v1/audiobook-jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/qc-reports' && req.method === 'GET') {
      return json(200, { reports: publishingAudioQcReports.map((report) => ({ ...report, signoffs: [...report.signoffs] })) });
    }
    if (url.pathname === '/v1/audiobook-jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/qc-signoffs' && req.method === 'POST') {
      const report = publishingAudioQcReports.find((entry) => entry.id === body.reportId);
      if (!report || body.listenedToExactAudio !== true) return json(422, { error: { message: 'Confirm listening to this exact audio.' } });
      let signoff = report.signoffs.find((entry) => entry.reviewerId === user.id);
      if (!signoff) {
        signoff = { reviewerId: user.id, signedAt: new Date().toISOString() };
        report.signoffs.push(signoff); report.signedByMe = true;
      }
      return json(201, { reportId: report.id, signedAt: signoff.signedAt, listenedToExactAudio: true });
    }
    if (edition && req.method === 'PATCH') {
      if (body.expectedUpdatedAt !== edition.updated_at) return json(409, { error: { message: 'Edition changed' } });
      Object.assign(edition, { edition_metadata_json: body.config, language: body.language, updated_at: new Date().toISOString() });
      return json(200, edition);
    }
    if (edition && url.pathname.endsWith('/render')) {
      const render = { jobId: randomUUID(), status: 'succeeded', artifacts: [{ role: 'rendered_ebook', asset: { id: randomUUID(), name: 'Harbor.epub', mime_type: 'application/epub+zip', size_bytes: 1200 }, download: fixtureDownload('render') }] };
      publishingRenders.set(render.jobId, { editionId: edition.id }); return json(201, render);
    }
    if (url.pathname === '/v1/publishing/validate') {
      const check = { jobId: randomUUID(), ruleVersion: 'fixture-1', requestedChannel: body.channel, channel: body.channel, errors: 0, warnings: 1,
        findings: [{ rule_id: 'fixture-review', location: '', severity: 'warning', message: 'Review this edition before submission.' }] };
      publishingChecks.set(check.jobId, { editionId: body.editionId, channel: body.channel }); return json(201, check);
    }
    if (url.pathname === '/v1/publishing/jobs') {
      if (req.method === 'GET') return json(200, { jobs: publishingPackages.map((job) => ({ ...job, package: { ...job.package, download: fixtureDownload('package') } })) });
      const render = publishingRenders.get(body.renderJobId); const check = publishingChecks.get(body.preflightJobId);
      if (!render || render.editionId !== body.editionId || !check || check.editionId !== body.editionId || check.channel !== body.channel) return json(422, { error: { message: 'Mismatched render/preflight sources' } });
      const job = { id: randomUUID(), bookId: body.bookId, editionId: body.editionId, channel: body.channel, status: 'succeeded', submissionMode: 'manual', createdAt: new Date().toISOString(), ruleVersion: 'fixture-1',
        package: { asset: { id: randomUUID(), size_bytes: 1600, checksum: 'f'.repeat(64) }, download: fixtureDownload('package') } };
      publishingPackages.push(job); return json(201, job);
    }
  }
  if (url.pathname.startsWith('/v1/admin/')) {
    if (process.env.FIXTURE_ADMIN !== 'true') return json(403, { error: { message: 'admin required' } });
    if (url.pathname === '/v1/admin/access') return json(200, { admin: true });
    if (url.pathname === '/v1/admin/users') return json(200, { users: [{ id: user.id, display_name: 'Fixture author', created_at: user.created_at }], memberships: [] });
    if (url.pathname === '/v1/admin/jobs') return json(200, { jobs: [{ id: 'job-fixture', job_type: url.searchParams.get('type'), status: 'succeeded', attempts: 1, created_at: user.created_at }] });
    if (url.pathname === '/v1/admin/flags') return json(200, { flags: adminFlags });
    if (url.pathname === '/v1/admin/flags/editor-preview' && req.method === 'PUT') {
      if (body.scopeType !== 'workspace' || body.scopeId !== 'workspace-fixture') return json(422, { error: { message: 'Wrong flag scope' } });
      adminFlags[0].enabled = body.enabled;
      adminAudit.push({ id: 'audit-flag', action: 'flag.update', actor_id: user.id, entity_type: 'feature_flag', entity_id: adminFlags[0].id, created_at: new Date().toISOString() });
      return json(200, { flag: adminFlags[0] });
    }
    if (url.pathname === '/v1/admin/support') return json(200, { tickets: adminTickets });
    if (url.pathname === '/v1/admin/support/ticket-fixture' && req.method === 'POST') {
      adminTickets[0].status = body.status;
      return json(200, { ticket: adminTickets[0] });
    }
    if (url.pathname === '/v1/admin/audit') return json(200, { entries: adminAudit });
    if (url.pathname === '/v1/admin/usage/summary') return json(200, { days: 30, orgs: [{ organizationId: 'fixture-organization', total: 12, byMeter: { ai_tokens: 10, renders: 2 } }] });
  }
  if (url.pathname === '/v1/referrals/code') return json(200, { id: 'code-fixture', code: 'bw-abcdef12', user_id: user.id, status: 'active' });
  if (url.pathname === '/v1/referrals') return json(200, { referrals: [{ id: 'referral-fixture', referred_user_id: 'other-author', status: 'rewarded', flagged: false, created_at: user.created_at }] });
  if (url.pathname === '/v1/referrals/ledger') return json(200, {
    entries: [{ id: 2, source: 'reversal', reference_type: 'referral_reward', amount: -100, balance_after: 20, created_at: user.created_at }, { id: 1, source: 'referral_reward', amount: 100, balance_after: 120, created_at: user.created_at }],
    summary: { creditBalance: 20, referralCredits: 0, rewardedReferrals: 1 },
  });
  if (url.pathname === '/v1/referrals/claim' && req.method === 'POST') {
    const alreadyAttributed = referralClaimed;
    referralClaimed = true;
    return json(200, { alreadyAttributed });
  }
  if (url.pathname === '/v1/support/tickets' && req.method === 'GET') return json(200, { tickets: adminTickets.filter((ticket) => ticket.user_id === user.id) });
  if (url.pathname === '/v1/support/tickets' && req.method === 'POST') {
    const ticket = { id: randomUUID(), user_id: user.id, organization_id: null, category: body.category, subject: body.subject, body: body.body, status: 'open', priority: 'normal', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    adminTickets.push(ticket); return json(201, { ticket });
  }
  if (url.pathname === '/v1/account/data-requests' && req.method === 'GET') return json(200, { requests: dataRequests });
  if (url.pathname === '/v1/account/data-requests' && req.method === 'POST') {
    const now = new Date();
    const request = { id: randomUUID(), user_id: user.id, request_type: body.type, status: 'submitted', reason: body.reason ?? null, requested_at: now.toISOString(), due_at: new Date(now.getTime() + 30 * 86400000).toISOString(), completed_at: null };
    dataRequests.unshift(request); return json(201, { request });
  }
  if (url.pathname.startsWith('/v1/account/data-requests/') && req.method === 'DELETE') {
    const request = dataRequests.find((entry) => entry.id === url.pathname.split('/').pop());
    if (!request || request.status !== 'submitted') return json(request ? 409 : 404, { error: { message: request ? 'Only submitted requests can be cancelled.' : 'Data request not found.' } });
    request.status = 'cancelled'; return json(200, { request });
  }
  if (url.pathname === '/v1/workspaces' && req.method === 'GET') return json(200, { workspaces });
  if (url.pathname === '/v1/workspaces' && req.method === 'POST') {
    const workspace = { id: randomUUID(), organization_id: randomUUID(), name: body.name, slug: 'fixture-workspace', created_by: user.id, created_at: new Date().toISOString() };
    workspaces.push(workspace); return json(201, workspace);
  }
  if (url.pathname === '/v1/books' && req.method === 'POST') {
    if (process.env.FIXTURE_REFUSE_BOOK_BEFORE_ACCEPTANCE === 'true' && !refusedBookBeforeAcceptance) {
      refusedBookBeforeAcceptance = true;
      return json(503, { error: { code: 'fixture_outage', message: 'Fixture refused book before acceptance' } });
    }
    const existing = body.requestId && setupBooks.find((book) => book.id === body.requestId);
    if (existing) return json(200, existing);
    const book = { id: body.requestId ?? randomUUID(), workspace_id: body.workspaceId, title: body.title, subtitle: body.subtitle ?? null, author_name: body.authorName,
      language: body.language ?? 'en', genre: body.genre ?? null, status: 'draft', created_by: user.id };
    setupBooks.push(book); setupCounts.books++;
    if (process.env.FIXTURE_LOST_BOOK_REPLY === 'true' && !lostBookReply) {
      lostBookReply = true;
      return json(503, { error: { code: 'fixture_lost_reply', message: 'Fixture lost book reply after acceptance' } });
    }
    return json(201, book);
  }
  if (url.pathname === '/v1/books') return json(200, { books: setupBooks });
  const setupBook = setupBooks.find((book) => url.pathname.startsWith(`/v1/books/${book.id}`));
  if (setupBook) {
    const base = `/v1/books/${setupBook.id}`;
    if (url.pathname === base) return json(200, { book: setupBook, role: 'owner' });
    if (url.pathname === `${base}/chapters` && process.env.FIXTURE_AI_DRAFT === 'true') {
      if (req.method === 'GET') return json(200, { chapters: [...draftChapters.values()].filter((v) => v.chapter.book_id === setupBook.id).map((v) => v.chapter) });
      if (req.method === 'POST') {
        const key = `${setupBook.id}:${body.idempotencyKey}`;
        let chapter = chapterKeys.get(key);
        if (!chapter) {
          chapter = { id: randomUUID(), book_id: setupBook.id, title: body.title, order_index: draftChapters.size };
          draftChapters.set(chapter.id, { chapter, document: { chapterId: chapter.id, version: 1, nodes: [{ id: randomUUID(), type: 'paragraph', text: '' }] } });
          chapterKeys.set(key, chapter);
        }
        if (body.title !== 'Chapter 1' && !lostChapterReply) { lostChapterReply = true; return json(503, { error: { message: 'Fixture lost chapter reply after acceptance' } }); }
        return json(201, { chapter });
      }
    }
    if (url.pathname === `${base}/chapters`) return json(200, { chapters: memoryChapters });
    if (url.pathname.startsWith(`${base}/imports/`) && req.method === 'GET') {
      setupCounts.reportReads++;
      return json(200, { import: setupReceipts.get(`${setupBook.id}:${url.pathname.split('/').pop()}`) ?? null });
    }
    if (url.pathname === `${base}/import-jobs` && req.method === 'POST') {
      if (!setupUploads.get(body.assetId)?.clean) return json(422, { error: { message: 'Source must be clean' } });
      let job = setupJobs.get(`${setupBook.id}:${body.assetId}`);
      if (!job) {
        job = { id: randomUUID(), book_id: setupBook.id, source_asset_id: body.assetId, status: 'queued', attempts: 0,
          error_code: null, created_at: new Date().toISOString(), available_at: new Date().toISOString(), completed_at: null };
        setupJobs.set(`${setupBook.id}:${body.assetId}`, job);
      }
      return json(202, { job });
    }
    if (url.pathname === `${base}/import-jobs` && req.method === 'GET') {
      setupCounts.jobReads++;
      for (const job of setupJobs.values()) {
        if (job.book_id !== setupBook.id) continue;
        if (job.status === 'queued') {
          setupCounts.imports++;
          if (setupCounts.imports === 1) Object.assign(job, { status: 'failed', attempts: 1, error_code: 'document_dependency_unavailable', completed_at: new Date().toISOString() });
          else {
            Object.assign(job, { status: 'succeeded', attempts: 1, error_code: null, completed_at: new Date().toISOString() });
            const receipt = { chapters: memoryChapters, sourceAssetId: job.source_asset_id, assetIds: [],
              report: { chapterCount: 1, imageCount: 2, warnings: ['Review the imported heading order.', '<script>Imported text remains text.</script>'] } };
            setupReceipts.set(`${setupBook.id}:${job.source_asset_id}`, receipt);
          }
        }
      }
      return json(200, { jobs: [...setupJobs.values()].filter((job) => job.book_id === setupBook.id) });
    }
    const retryJob = [...setupJobs.values()].find((job) => url.pathname === `${base}/import-jobs/${job.id}/retry`);
    if (retryJob && req.method === 'POST') {
      setupCounts.jobRetries++;
      Object.assign(retryJob, { status: 'queued', attempts: 0, error_code: null, completed_at: null, available_at: new Date().toISOString() });
      return json(202, { job: retryJob });
    }
    if (url.pathname === `${base}/import` && req.method === 'POST') {
      if (!setupUploads.get(body.assetId)?.clean) return json(409, { error: { message: 'Source quarantined' } });
      setupCounts.imports++;
      if (setupCounts.imports === 1) return json(503, { error: { message: 'Fixture parser outage. Retry the saved original.' } });
      const receipt = { chapters: memoryChapters, sourceAssetId: body.assetId,
        report: { chapterCount: 1, imageCount: 2, warnings: ['Review the imported heading order.', '<script>Imported text remains text.</script>'] } };
      setupReceipts.set(`${setupBook.id}:${body.assetId}`, receipt);
      return json(200, receipt);
    }
  }
  if (url.pathname === '/v1/assets/upload-url' && req.method === 'POST') {
    setupCounts.allocationRequests++;
    const id = body.requestId ?? randomUUID(); const token = randomUUID();
    const existing = setupUploads.get(id);
    if (existing && (existing.filename !== body.filename || existing.mimeType !== body.mimeType
      || existing.sizeBytes !== body.sizeBytes || existing.workspaceId !== body.workspaceId || existing.type !== body.type || existing.clean)) {
      return json(409, { error: { message: 'Upload request changed or finished' } });
    }
    if (existing) existing.token = token;
    else {
      setupUploads.set(id, { token, filename: body.filename, mimeType: body.mimeType, workspaceId: body.workspaceId,
        type: body.type, sizeBytes: body.sizeBytes, uploaded: false, clean: false, checksum: null });
      setupCounts.assets++;
    }
    if (process.env.FIXTURE_LOST_UPLOAD_ALLOCATION_REPLY === 'true' && !lostUploadAllocationReply) {
      lostUploadAllocationReply = true;
      return json(503, { error: { message: 'Fixture lost allocation reply after acceptance' } });
    }
    return json(200, { assetId: id, uploadUrl: `http://127.0.0.1:4399/fixture-upload/${id}?token=${token}`, path: 'fixture-only' });
  }
  const setupAssetId = url.pathname.split('/')[3];
  const setupAsset = setupUploads.get(setupAssetId);
  if (setupAsset && url.pathname === `/v1/assets/${setupAssetId}/confirm` && req.method === 'POST') {
    setupCounts.confirmations++;
    if (setupAsset.clean) return json(409, { error: { message: 'asset already confirmed' } });
    if (!setupAsset.uploaded || body.sizeBytes !== setupAsset.sizeBytes) return json(409, { error: { message: 'Upload incomplete' } });
    setupAsset.clean = true; setupAsset.checksum = body.checksumSha256;
    return json(503, { error: { message: 'Fixture lost scan response. Retry to check its saved result.' } });
  }
  if (setupAsset && url.pathname === `/v1/assets/${setupAssetId}/versions`) return json(200, { versions: [{
    id: setupAssetId, version_number: 1, checksum: setupAsset.checksum ?? 'pending', scan_status: setupAsset.clean ? 'clean' : 'pending',
  }] });
  if (url.pathname === '/v1/usage') return json(200, { entitlements: {}, usage: {}, creditBalance: 120 });
  if (process.env.FIXTURE_AI_DRAFT === 'true') {
    const draft = draftChapters.get(url.pathname.split('/')[3]);
    if (draft && url.pathname.endsWith('/document')) return json(200, { ...draft, role: 'owner' });
    if (draft && url.pathname.endsWith('/versions')) return json(200, { versions: [] });
    if (url.pathname === '/v1/ai/jobs' && req.method === 'POST') {
      let review = aiKeys.get(body.idempotencyKey);
      if (!review) {
        const source = draftChapters.get(body.chapterIds[0]);
        if (!source) return json(422, { error: { message: 'Unknown chapter' } });
        review = { id: randomUUID(), book_id: body.bookId, chapter_ids: body.chapterIds, agent_type: body.agentType,
          status: 'queued', context_source_count: 0, created_at: new Date().toISOString(), usage_json: {}, suggestions: [{
            id: randomUUID(), status: 'pending', rationale: 'Opening scene for author review',
            operation_json: { target: { chapterId: source.chapter.id, nodeId: source.document.nodes[0].id },
              payload: { from: 0, to: 0, text: 'Mara reached the harbor before dawn.' }, expectedVersion: 1 },
          }] };
        aiReviews.set(review.id, review); aiKeys.set(body.idempotencyKey, review);
      }
      if (body.idempotencyKey.startsWith('chapter-draft:') && !lostAiReply) { lostAiReply = true; return json(503, { error: { message: 'Fixture lost AI reply after acceptance' } }); }
      return json(202, review);
    }
    if (url.pathname === '/v1/ai/jobs') return json(200, { jobs: [...aiReviews.values()].filter((v) => v.book_id === url.searchParams.get('bookId')).reverse() });
    const review = aiReviews.get(url.pathname.split('/').pop());
    if (review && url.pathname.startsWith('/v1/ai/jobs/')) { review.status = 'succeeded'; return json(200, review); }
    if (url.pathname.startsWith('/v1/ai/suggestions/')) {
      const suggestionId = url.pathname.split('/')[4];
      const owner = [...aiReviews.values()].find((v) => v.suggestions.some((s) => s.id === suggestionId));
      const suggestion = owner?.suggestions.find((s) => s.id === suggestionId);
      if (!suggestion || suggestion.status !== 'pending') return json(409, { error: { message: 'Already reviewed' } });
      const source = draftChapters.get(owner.chapter_ids[0]);
      if (url.pathname.endsWith('/apply')) {
        source.document.nodes[0].text = suggestion.operation_json.payload.text; source.document.version++;
        suggestion.status = 'accepted'; return json(200, { suggestionId, status: 'accepted', version: source.document.version });
      }
      suggestion.status = 'rejected'; return json(200, { suggestion });
    }
  }
  // Stateful HTTP fixture for browser interaction. API validation, scoping and
  // conflict behavior have separate tests against the real Fastify routes.
  const memoryBase = `/v1/books/${memoryBookId}`;
  if (url.pathname === memoryBase && req.method === 'GET') return json(200, { book: memoryBook, role: 'owner' });
  if (url.pathname === `${memoryBase}/chapters` && req.method === 'GET') return json(200, { chapters: memoryChapters.map((ch, order_index) => ({ ...ch, book_id: memoryBookId, order_index })) });
  if (url.pathname === `/v1/chapters/${manuscript.chapterId}/document` && req.method === 'GET') return json(200, { chapter: memoryChapters[0], role: 'owner', document: manuscript });
  if (url.pathname === `/v1/chapters/${manuscript.chapterId}/versions`) return json(200, { versions: manuscriptHistory });
  if (url.pathname === `/v1/chapters/${manuscript.chapterId}/document` && req.method === 'PUT') {
    if (savedOperations.has(body.operationId)) return json(200, savedOperations.get(body.operationId));
    if (body.expectedVersion !== manuscript.version) return json(409, { error: { message: 'Document changed. Reload before saving.' } });
    manuscript.nodes = body.nodes; manuscript.version++;
    const plain_text = body.nodes.map((n) => n.text ?? '').join('\n\n');
    const version = { id: randomUUID(), chapter_id: manuscript.chapterId, version_number: manuscript.version, plain_text, word_count: plain_text.split(/\s+/).length, created_at: new Date().toISOString(), change_summary: 'Browser acceptance save' };
    manuscriptHistory.unshift(version);
    const result = { version: manuscript.version, versionId: version.id, document: structuredClone(manuscript) };
    savedOperations.set(body.operationId, result);
    return json(200, result);
  }
  if (url.pathname === '/v1/assets' && url.searchParams.get('workspaceId') === memoryBook.workspace_id) return json(200, { assets: memoryImages.map((asset) => ({ ...asset, workspace_id: memoryBook.workspace_id, status: 'approved', checksum: 'fixture-confirmed', type: 'illustration', size_bytes: 68 })) });
  if (url.pathname === `/v1/assets/${memoryImages[0].id}/download-url`) {
    const token = randomUUID(); previewTokens.add(token);
    return json(200, { url: `http://127.0.0.1:4399/fixture-image?token=${token}`, expiresIn: 60 });
  }
  if (url.pathname === `${memoryBase}/memory` && req.method === 'GET') return json(200, { book: memoryBook, metadata: memoryMetadata, items: memoryItems, chapters: memoryChapters, imageAssets: memoryImages, canEdit: true });
  if (url.pathname === `${memoryBase}/search` && req.method === 'POST') {
    if (!String(body.query ?? '').toLowerCase().includes('elara')) return json(200, { results: [], strategy: 'postgres_full_text', query: body.query });
    return json(200, {
      results: [{
        id: '77777777-7777-4777-8777-777777777777', source_type: 'manuscript', chapter_id: memoryChapters[0].id,
        bible_item_id: null, document_version_id: memoryChapters[0].current_document_version_id,
        node_id: 'n1', chunk_index: 0, title: 'Arrival',
        excerpt: 'Elara carries a silver compass from the harbor.', text_hash: 'fixture-search-hash', score: 1,
      }],
      strategy: 'postgres_full_text', query: body.query,
    });
  }
  if (url.pathname === memoryBase && req.method === 'PATCH') {
    if (body.expectedUpdatedAt !== memoryBook.updated_at) return json(409, { error: { message: 'Book details changed. Reload before saving.' } });
    for (const field of ['title', 'subtitle', 'language', 'genre']) if (field in body) memoryBook[field] = body[field];
    if ('authorName' in body) memoryBook.author_name = body.authorName;
    memoryBook.updated_at = new Date().toISOString();
    return json(200, { book: memoryBook });
  }
  if (url.pathname === `${memoryBase}/bible` && req.method === 'POST') {
    const now = new Date().toISOString();
    const item = { id: randomUUID(), book_id: memoryBookId, type: body.type, name: body.name, description: body.description, attributes_json: { ...body.attributes, imageAssetIds: body.imageAssetIds }, source_refs_json: body.sourceRefs, confidence: null, created_at: now, updated_at: now };
    memoryItems.push(item); return json(201, { item });
  }
  if (url.pathname.startsWith(`${memoryBase}/bible/`) && ['PUT', 'DELETE'].includes(req.method)) {
    const item = memoryItems.find((entry) => entry.id === url.pathname.split('/').pop());
    if (!item || item.updated_at !== body.expectedUpdatedAt) return json(409, { error: { message: 'This entry changed or was removed. Reload before saving your changes.' } });
    if (req.method === 'DELETE') { memoryItems.splice(memoryItems.indexOf(item), 1); return json(200, { deleted: true, itemId: item.id }); }
    Object.assign(item, { type: body.type, name: body.name, description: body.description, attributes_json: { ...body.attributes, imageAssetIds: body.imageAssetIds }, source_refs_json: body.sourceRefs, updated_at: new Date(Math.max(Date.now(), Date.parse(item.updated_at) + 1)).toISOString() });
    return json(200, { item });
  }
  if (url.pathname === `${memoryBase}/metadata` && req.method === 'PUT') {
    if (body.expectedUpdatedAt !== (memoryMetadata?.updated_at ?? null)) return json(409, { error: { message: 'Metadata changed since you loaded it. Reload before saving.' } });
    memoryMetadata = { book_id: memoryBookId, description: body.description, keywords: body.keywords, categories: body.categories, isbn13: body.isbn13, edition: body.edition, publication_date: body.publicationDate, contributors: [], updated_at: new Date().toISOString() };
    return json(200, { metadata: memoryMetadata });
  }
  return json(404, { error: { code: 'not_found', message: 'Not implemented in browser auth fixture' } });
});
server.listen(4399, '127.0.0.1', () => console.log('Isolated auth/browser fixture listening on 127.0.0.1:4399'));
