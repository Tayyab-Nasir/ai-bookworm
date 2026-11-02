import test from "node:test";
import assert from "node:assert/strict";
import {createClient} from "@bookworm/api-client";

test("book setup transport binds all writes, recovery and paid quote requests to the original actor",async()=>{
 const previous=globalThis.fetch;const calls:{path:string;actor:string|null}[]=[];
 globalThis.fetch=async (url,init)=>{calls.push({path:String(url),actor:new Headers(init?.headers).get('x-bookworm-actor')});return Response.json({});};
 try {
  const api=createClient({baseUrl:'http://127.0.0.1'}),actor='11111111-1111-4111-8111-111111111111';
  await api.listWorkspaces(actor);await api.createBook({workspaceId:'w',title:'t',authorName:'a'},actor);
  await api.createAssetUploadUrl({workspaceId:'w',filename:'a.txt',mimeType:'text/plain',sizeBytes:1},actor);
  await api.confirmAssetUpload('a',{checksumSha256:'a'.repeat(64),sizeBytes:1},actor);
  await api.listAssetVersions('a',actor);await api.getAssetUsage('a',actor);await api.queueManuscriptImport('b','a',actor);
  await api.listManuscriptImports('b',actor);await api.retryManuscriptImport('b','j',actor);await api.getManuscriptImport('b','a',actor);
  await api.importManuscript('b','a',actor);await api.listAiReviewModels('b',actor);
  await api.createAiReviewQuote('b',{} as Parameters<typeof api.createAiReviewQuote>[1],actor);
  await api.getAiReviewQuote('b','q',actor);await api.acceptAiReviewQuote('b','q',1,actor);
  assert.equal(calls.length,15);assert.ok(calls.every(c=>c.actor===actor));
 } finally {globalThis.fetch=previous;}
});
