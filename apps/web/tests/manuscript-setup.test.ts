import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClientError } from "@bookworm/api-client";
import { readSetupCheckpoint, recoverManuscriptReport, runManuscriptSetup, setupKey, type SetupCheckpoint } from "../lib/manuscript-setup";

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const bookId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";
const conflict = () => new ApiClientError(409, "conflict", "Already finalized or terminal", "test");
const unavailable = () => new ApiClientError(503, "unavailable", "Service unavailable", "test");
const file = new File(["Chapter one\nThe harbor was quiet."], "manuscript.txt", { type: "text/plain" });

function fixture() {
  let saved: SetupCheckpoint | null = null;
  const calls: string[] = [];
  let confirmError: Error | null = null;
  let importError: Error | null = null;
  let clean = true;
  let replaced = false;
  let linkedBook = bookId;
  const api = {
    createBook: async () => { calls.push("create"); return { id: bookId }; },
    createAssetUploadUrl: async () => { calls.push("allocate"); return { assetId, uploadUrl: "https://storage.invalid/private?token=never-save", path: "private" }; },
    confirmAssetUpload: async () => { calls.push("confirm"); if (confirmError) throw confirmError; return {}; },
    listAssetVersions: async () => { calls.push("versions"); return { versions: [{ version_number: 1, checksum: saved!.source!.checksumSha256, scan_status: clean ? "clean" : "infected" }, ...(replaced ? [{ version_number: 2, checksum: "replacement", scan_status: "clean" }] : [])] }; },
    importManuscript: async () => { calls.push("import"); if (importError) throw importError; return { report: { chapterCount: 1, imageCount: 0, warnings: ["Review headings"] } }; },
    getAssetUsage: async () => { calls.push("usage"); return { links: [{ entity_type: "book", entity_id: linkedBook, usage_role: "manuscript_source" }] }; },
  } as unknown as Parameters<typeof runManuscriptSetup>[0]["api"];
  const run = (changes: Partial<Parameters<typeof runManuscriptSetup>[0]> = {}) => runManuscriptSetup({ api, userId,
    details: { workspaceId, title: "Harbor", authorName: "Author" }, importing: true, file,
    checkpoint: saved, save: (value) => { saved = structuredClone(value); }, stage: () => {},
    upload: async () => { calls.push("upload"); return new Response(null, { status: 200 }); }, ...changes });
  return { run, calls, saved: () => saved, scanError: (error: Error | null) => { confirmError = error; },
    parserError: (error: Error | null) => { importError = error; }, clean: (value: boolean) => { clean = value; }, replaced: () => { replaced = true; }, linkedBook: (value: string) => { linkedBook = value; } };
}

test("parser retry reuses book and original, survives serialized recovery, and returns report", async () => {
  const f = fixture(); f.parserError(unavailable());
  await assert.rejects(f.run(), /Service unavailable/);
  const checkpoint = readSetupCheckpoint(JSON.stringify(f.saved()), userId, workspaceId);
  assert.ok(checkpoint?.source); assert.equal(checkpoint.completed, false);
  const raw = JSON.stringify(checkpoint);
  assert.doesNotMatch(raw, /harbor|token|uploadUrl|contentBase64|manuscript.txt/i);
  f.parserError(null); f.scanError(conflict());
  const result = await f.run({ checkpoint, file: null });
  assert.equal(result.bookId, bookId); assert.deepEqual(result.report?.warnings, ["Review headings"]);
  assert.deepEqual(f.calls, ["create", "allocate", "upload", "confirm", "import", "confirm", "versions", "import"]);
  assert.equal(f.saved()?.completed, true);
});

test("scan outage retains source before confirmation; clean replay resumes without upload", async () => {
  const f = fixture(); f.scanError(unavailable());
  await assert.rejects(f.run()); assert.ok(f.saved()?.source); assert.ok(!f.calls.includes("import"));
  f.scanError(conflict());
  await f.run({ file: null });
  assert.equal(f.calls.filter((call) => call === "create").length, 1);
  assert.equal(f.calls.filter((call) => call === "upload").length, 1);
});

test("terminal infected confirmation never reaches import", async () => {
  const f = fixture(); f.scanError(conflict()); f.clean(false);
  await assert.rejects(f.run(), /terminal/);
  assert.ok(!f.calls.includes("import")); assert.equal(f.saved()?.completed, false);
});

test("retry refuses a source asset replaced with a newer version", async () => {
  const f = fixture(); f.scanError(conflict()); f.replaced();
  await assert.rejects(f.run(), /newer versions/); assert.ok(!f.calls.includes("import"));
});

test("legacy import conflict requires an authoritative source link to this exact book", async () => {
  const f = fixture(); f.parserError(conflict()); f.linkedBook(workspaceId);
  await assert.rejects(f.run()); assert.equal(f.saved()?.completed, false);
  f.linkedBook(bookId);
  const result = await f.run(); assert.equal(result.report, null); assert.equal(f.saved()?.completed, true);
});

test("completed setup is read-only and account/workspace/mode switches are rejected", async () => {
  const f = fixture(); await f.run(); const count = f.calls.length;
  await f.run(); assert.equal(f.calls.length, count);
  await assert.rejects(f.run({ userId: workspaceId }), /changed/);
  await assert.rejects(f.run({ details: { workspaceId: bookId, title: "Other", authorName: "Author" } }), /changed/);
  await assert.rejects(f.run({ importing: false }), /changed/);
  assert.equal(f.calls.length, count);
});

test("invalid files are rejected before creating anything; blank books skip source work", async () => {
  const f = fixture();
  await assert.rejects(f.run({ file: null }), /Choose/);
  await assert.rejects(f.run({ file: new File(["x"], "bad.exe") }), /TXT/);
  await assert.rejects(f.run({ file: new File([], "empty.txt") }), /non-empty/);
  assert.deepEqual(f.calls, []);
  await f.run({ importing: false, file: null }); assert.deepEqual(f.calls, ["create"]);
});

test("AI setup saves only recovery IDs until its reviewable first draft is queued", async () => {
  const f = fixture();
  const result = await f.run({ importing: false, file: null, setupMode: "ai", finishWhenBookCreated: false });
  assert.equal(result.bookId, bookId); assert.deepEqual(f.calls, ["create"]);
  assert.equal(f.saved()?.completed, false); assert.equal(f.saved()?.setupMode, "ai");
  const saved = f.saved()!;
  const recovered = readSetupCheckpoint(JSON.stringify({ ...saved, starter: { chapterId: assetId, jobId: userId }, storyBrief: "private idea" }), userId, workspaceId);
  assert.deepEqual(recovered?.starter, { chapterId: assetId, jobId: userId });
  assert.doesNotMatch(JSON.stringify(recovered), /private idea/);
  assert.equal(readSetupCheckpoint(JSON.stringify({ ...saved, starter: { chapterId: "not-an-id" } }), userId, workspaceId), null);
});

test("upload failure retains the created book and retry does not recreate it", async () => {
  const f = fixture(); await assert.rejects(f.run({ upload: async () => new Response(null, { status: 503 }) }), /upload failed/);
  assert.equal(f.saved()?.bookId, bookId); assert.equal(f.saved()?.source, undefined);
  await f.run(); assert.equal(f.calls.filter((call) => call === "create").length, 1);
});

test("checkpoint recovery bounds age/size, scopes identity and strips unrecognized data", async () => {
  const f = fixture(); await f.run(); const saved = f.saved()!; const now = saved.savedAt;
  const read = (value: unknown, at = now) => readSetupCheckpoint(JSON.stringify(value), userId, workspaceId, at);
  assert.equal(read(saved, now + 86400_001), null); assert.equal(read(saved, now - 1), null);
  assert.equal(read({ ...saved, bookId: "../../admin" }), null);
  assert.equal(read({ ...saved, userId: workspaceId }), null);
  assert.equal(read({ ...saved, workspaceId: bookId }), null);
  assert.equal(read({ ...saved, source: { ...saved.source, checksumSha256: "bad" } }), null);
  assert.equal(read({ ...saved, source: { ...saved.source, sizeBytes: 21 * 1024 * 1024 } }), null);
  assert.equal(read({ ...saved, secret: "x".repeat(2048) }), null);
  assert.equal(readSetupCheckpoint("{", userId, workspaceId), null);
  assert.deepEqual(read({ ...saved, token: "strip-me", source: { ...saved.source, uploadUrl: "strip-me" } }), saved);
  assert.notEqual(setupKey(userId, workspaceId), setupKey(workspaceId, userId));
});

test("report recovery uses a read-only receipt for completed and interrupted imports", async () => {
  const f = fixture(); await f.run(); const checkpoint = f.saved()!;
  const report = { chapterCount: 1, imageCount: 0, warnings: ["Review headings"] };
  const calls: string[][] = [];
  const api = { getManuscriptImport: async (book: string, asset: string) => {
    calls.push([book, asset]); return { import: { chapters: [], sourceAssetId: asset, report } };
  } };
  assert.deepEqual(await recoverManuscriptReport(api, checkpoint), report);
  assert.deepEqual(await recoverManuscriptReport(api, { ...checkpoint, completed: false }), report);
  assert.deepEqual(calls, [[bookId, assetId], [bookId, assetId]]);
  assert.equal(await recoverManuscriptReport(api, { ...checkpoint, source: undefined }), null);
  assert.equal(await recoverManuscriptReport(api, { ...checkpoint, importing: false }), null);
  assert.equal(calls.length, 2);
  assert.equal(await recoverManuscriptReport({ getManuscriptImport: async () => ({ import: null }) }, checkpoint), null);
  await assert.rejects(recoverManuscriptReport({ getManuscriptImport: async () => { throw unavailable(); } }, checkpoint), /unavailable/);
});

test("durable import queues after source confirmation and leaves completion to receipt polling", async () => {
  const f = fixture();
  const queueImport = (async (queuedBook: string, queuedAsset: string) => {
    f.calls.push("queue"); assert.equal(queuedBook, bookId); assert.equal(queuedAsset, assetId);
    return { job: { id: userId, book_id: bookId, source_asset_id: assetId, status: "queued", attempts: 0,
      error_code: null, created_at: new Date().toISOString(), available_at: new Date().toISOString(), completed_at: null } };
  }) as never;
  const queued = await f.run({ queueImport });
  assert.ok(queued.job); assert.equal(queued.job.status, "queued");
  assert.equal(f.saved()?.completed, false);
  assert.ok(f.calls.includes("queue"));
  assert.ok(!f.calls.includes("import"));
});
