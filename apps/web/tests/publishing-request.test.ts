import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@bookworm/api-client";
import { packageRecoveryKey, readPackagePointer, persistPackagePointer, clearPackagePointer, validatePackageResult, signedDownloadDeadline, downloadExpired, nextDownloadClockWait, type PackagePointer } from "../lib/publishing-request";

const id = (n: number) => `d1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pointer: PackagePointer = { schema: 1, userId: id(1), request: { bookId: id(2), editionId: id(3), channel: "kdp", renderJobId: id(4), preflightJobId: id(5), idempotencyKey: id(6) } };
const job = { id: id(7), requestId: id(6), bookId: id(2), editionId: id(3), channel: "kdp", sourceRenderJobId: id(4), sourcePreflightJobId: id(5), status: "succeeded", submissionMode: "manual", package: null, createdAt: "2026-10-17T01:00:00Z" };

test("retailer submission SDK sends the original actor and rejects mismatched receipts", async () => {
  const before = globalThis.fetch;
  const submission = { jobId: job.id, status: "submitted", revision: id(8), updatedAt: "2026-10-17T02:00:00Z" };
  let reply: unknown = { submission: null };
  const requests: { method: string; actor: string | null; body: unknown }[] = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `https://api.example.test/v1/publishing/jobs/${job.id}/submission`);
    requests.push({ method: options!.method!, actor: new Headers(options!.headers).get("x-bookworm-actor"),
      body: options?.body ? JSON.parse(String(options.body)) : undefined });
    return Response.json(reply);
  };
  try {
    const api = createClient({ baseUrl: "https://api.example.test" });
    assert.equal(await api.getRetailerSubmission(job.id, id(1)), null);
    reply = { submission };
    assert.deepEqual(await api.saveRetailerSubmission(job.id, { status: "submitted", expectedRevision: null }, id(1)), submission);
    assert.deepEqual(requests, [
      { method: "GET", actor: id(1), body: undefined },
      { method: "PUT", actor: id(1), body: { status: "submitted", expectedRevision: null } },
    ]);
    await assert.rejects(api.saveRetailerSubmission(job.id, { status: "submitted", expectedRevision: id(8) }, id(1)), /verified/);
    reply = { submission: { ...submission, jobId: id(9) } };
    await assert.rejects(api.getRetailerSubmission(job.id, id(1)), /verified/);
    reply = {};
    await assert.rejects(api.getRetailerSubmission(job.id, id(1)), /verified/);
  } finally { globalThis.fetch = before; }
});

test("managed publishing SDK preserves the actor and rejects a different workspace or package checksum", async () => {
  const before = globalThis.fetch;
  const sha = "a".repeat(64);
  const request = { jobId: job.id, workspaceId: id(2), requestedBy: id(1), packageSha256: sha, requestedAt: "2026-10-18T00:00:00Z", withdrawnAt: null, confirmedAt: null, listingUrl: null };
  let reply: unknown = { request };
  let expectedBody: object = { packageSha256: sha };
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `https://api.example.test/v1/publishing/jobs/${job.id}/managed-request`);
    assert.equal(new Headers(options?.headers).get("x-bookworm-actor"), id(1));
    if (options?.method === "PUT") assert.deepEqual(JSON.parse(String(options.body)), expectedBody);
    return Response.json(reply);
  };
  try {
    const api = createClient({ baseUrl: "https://api.example.test" });
    assert.deepEqual(await api.requestManagedPublishing(job.id, id(2), sha, id(1)), request);
    assert.deepEqual(await api.getManagedPublishingRequest(job.id, id(2), id(1)), request);
    const claimed = { ...request, claimedAt: "2026-10-18T00:02:00Z" };
    reply = { request: claimed };
    assert.deepEqual(await api.getManagedPublishingRequest(job.id, id(2), id(1)), claimed);
    reply = { request: { ...request, claimedAt: "2026-10-17T00:00:00Z" } };
    await assert.rejects(api.getManagedPublishingRequest(job.id, id(2), id(1)), /verified/);
    reply = { request };
    await assert.rejects(api.getManagedPublishingRequest(job.id, id(3), id(1)), /verified/);
    reply = { request: { ...request, packageSha256: "b".repeat(64) } };
    await assert.rejects(api.requestManagedPublishing(job.id, id(2), sha, id(1)), /verified/);
    expectedBody = { packageSha256: sha, withdraw: true };
    reply = { request };
    await assert.rejects(api.withdrawManagedPublishing(job.id, id(2), sha, id(1)), /verified/);
    const withdrawn = { ...request, withdrawnAt: "2026-10-18T00:01:00Z" };
    reply = { request: withdrawn };
    assert.deepEqual(await api.withdrawManagedPublishing(job.id, id(2), sha, id(1)), withdrawn);
  } finally { globalThis.fetch = before; }
});

test("package pointer is strict, account/book scoped and never overwrites a different pending request", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  persistPackagePointer(storage, pointer);
  assert.deepEqual(readPackagePointer(storage, id(1), id(2)), pointer);
  assert.equal(readPackagePointer(storage, id(8), id(2)), null);
  assert.equal(readPackagePointer(storage, id(1), id(8)), null);
  const closing = { ...pointer, closing: true as const };
  persistPackagePointer(storage, closing);
  assert.deepEqual(readPackagePointer(storage, id(1), id(2)), closing);
  assert.throws(() => persistPackagePointer(storage, pointer), /original/);
  assert.throws(() => clearPackagePointer(storage, pointer), /newer/);
  clearPackagePointer(storage, closing);
  persistPackagePointer(storage, pointer);
  const other = { ...pointer, request: { ...pointer.request, idempotencyKey: id(8) } };
  assert.throws(() => persistPackagePointer(storage, other), /original/);
  values.set(packageRecoveryKey(id(1), id(2)), JSON.stringify(other));
  assert.throws(() => clearPackagePointer(storage, pointer), /newer/);
  clearPackagePointer(storage, other); assert.equal(values.size, 0);
  for (const invalid of ["not-json", JSON.stringify({ ...pointer, privateText: "do not persist" }), JSON.stringify({ ...pointer, request: { ...pointer.request, channel: "export" } }), JSON.stringify({ ...pointer, request: { ...pointer.request, renderJobId: "bad" } })]) {
    values.set(packageRecoveryKey(id(1), id(2)), invalid);
    assert.throws(() => readPackagePointer(storage, id(1), id(2)), /invalid/);
    assert.equal(values.get(packageRecoveryKey(id(1), id(2))), invalid);
  }
  assert.throws(() => persistPackagePointer({ getItem: () => null, setItem: () => {} }, pointer), /unavailable/);
});

test("only exact source-bound package receipts can clear recovery, including unavailable completed files", () => {
  assert.equal(validatePackageResult(job, pointer).id, job.id);
  const packageFile = { asset: { id: id(9), checksum: "a".repeat(64), size_bytes: 100 }, download: { url: "https://storage.example/private.zip", expiresIn: 300 } };
  assert.equal(validatePackageResult({ ...job, package: packageFile }, pointer).id, job.id);
  for (const patch of [{ requestId: id(8) }, { bookId: id(8) }, { editionId: id(8) }, { channel: "apple" }, { sourceRenderJobId: id(8) }, { sourcePreflightJobId: id(8) }, { status: "done" }, { package: undefined }]) {
    assert.throws(() => validatePackageResult({ ...job, ...patch }, pointer), /does not match/);
  }
  for (const url of ["https://", "javascript:alert(1)", "https://user:password@storage.example/file", "http://storage.example/file", "https://storage.example/file#private"]) {
    assert.throws(() => validatePackageResult({ ...job, package: { ...packageFile, download: { url, expiresIn: 300 } } }, pointer));
  }
  for (const expiresIn of [0, 3601, "300"]) {
    assert.throws(() => validatePackageResult({ ...job, package: { ...packageFile, download: { ...packageFile.download, expiresIn } } }, pointer));
  }
  assert.throws(() => validatePackageResult({ ...job, status: "cancelled", package: packageFile }, pointer));
});

test("package SDK keeps body request ID and actor, uses read-only recovery and never auto-retries", async () => {
  const before = globalThis.fetch; const sent: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  globalThis.fetch = async (url, options) => {
    sent.push({ url: String(url), method: options!.method!, headers: new Headers(options!.headers), body: options?.body ? JSON.parse(String(options.body)) : undefined });
    return Response.json({ requestId: id(6), job });
  };
  try {
    const api = createClient({ baseUrl: "https://api.example.test", idempotencyKey: () => { throw new Error("must use durable body identity"); } });
    await api.createPublishingJob(pointer.request, pointer.userId);
    await api.getPublishingRequest(id(2), id(6), id(1));
    await api.closePublishingRequest(pointer.request, id(1));
    assert.deepEqual(sent.map(row => row.method), ["POST", "GET", "POST"]);
    assert.deepEqual(sent[0].body, pointer.request); assert.equal(sent[1].body, undefined); assert.deepEqual(sent[2].body, pointer.request);
    assert.equal(sent[1].url, `https://api.example.test/v1/publishing/requests/${id(6)}?bookId=${id(2)}`);
    assert.ok(sent.every(row => row.headers.get("x-bookworm-actor") === id(1) && !row.headers.has("idempotency-key")));
    let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("reply lost"); };
    await assert.rejects(() => api.createPublishingJob(pointer.request, id(1)), /reply lost/); assert.equal(calls, 1);
  } finally { globalThis.fetch = before; }
});


test("private package deadlines use request start and reject unsafe URLs and invalid lifetimes", () => {
  const start = {wall: 1000, monotonic: 500};
  const deadline = signedDownloadDeadline({url: "https://storage.example/signed.zip", expiresIn: 300}, start);
  assert.deepEqual(deadline, {wall: 301000, monotonic: 300500});
  assert.equal(downloadExpired(deadline, {wall: 1001, monotonic: 300500}), true);
  assert.equal(downloadExpired(deadline, {wall: 301000, monotonic: 501}), true);
  for (const download of [
    {url: "javascript:alert(1)", expiresIn: 300},
    {url: "http://remote.example/file", expiresIn: 300},
    {url: "https://storage.example/signed.zip", expiresIn: 301},
    {url: "https://storage.example/signed.zip", expiresIn: 0},
  ]) assert.equal(signedDownloadDeadline(download, start), null);
  assert.deepEqual(signedDownloadDeadline({url: "https://storage.example/book.epub", expiresIn: 3600}, start, 3600), {wall: 3601000, monotonic: 3600500});
  assert.equal(signedDownloadDeadline({url: "https://storage.example/book.epub", expiresIn: 3601}, start, 3600), null);
  assert.equal(signedDownloadDeadline(null, start), null);
  assert.equal(signedDownloadDeadline({url: "https://storage.example/signed.zip", expiresIn: 300}, {wall: NaN, monotonic: 1}), null);
});

test("package clock schedules expired-between-render-and-effect deadlines immediately", () => {
  const deadline = {wall: 1000, monotonic: 800};
  const rendered = {wall: 999, monotonic: 799};
  assert.equal(nextDownloadClockWait([deadline], rendered, {wall: 1000, monotonic: 800}), 0);
  assert.equal(nextDownloadClockWait([deadline], rendered, {wall: 1200, monotonic: 799}), 0);
  assert.equal(nextDownloadClockWait([deadline], rendered, {wall: 999, monotonic: 900}), 0);
  assert.equal(nextDownloadClockWait([deadline], {wall: 1000, monotonic: 800}, {wall: 1001, monotonic: 801}), null);
  assert.equal(nextDownloadClockWait([null], rendered, rendered), null);
  assert.equal(nextDownloadClockWait([{wall: 40000, monotonic: 40000}], rendered, rendered), 10000);
});
