import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {chromium, expect} from "@playwright/test";
const bundled=await build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import {ApiClientError} from '@bookworm/api-client'; import Setup from './apps/web/components/BookSetupClient'; window.TestApiClientError=ApiClientError; createRoot(document.getElementById('root')).render(React.createElement(Setup));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',plugins:[{name:'fixtures',setup(b){
 b.onResolve({filter:/^(next\/link|next\/navigation|\.\/api|\.\/AuthorShell)$/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({resolveDir:process.cwd(),contents:a.path==='next/link'?`import React from 'react'; export default p=>React.createElement('a',p,p.children);`:a.path==='next/navigation'?`export const useRouter=()=>({push: x=>window.dest=x});`:a.path==='./AuthorShell'?`import React from 'react'; export const AuthorHeader=()=>React.createElement('div');`:`export const apiClient=()=>window.bookwormApi;`}));
}}]});
const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_TEST_CHANNEL||'chromium-headless-shell'}); test.after(()=>browser.close());

test("setup completes only when the background import report matches the saved source", async () => {
 const page = await browser.newPage();
 try {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://127.0.0.1/books/new");
  const scope = await page.evaluate(() => {
   const actor = "11111111-1111-4111-8111-111111111111";
   const workspace = "22222222-2222-4222-8222-222222222222";
   const book = "33333333-3333-4333-8333-333333333333";
   const asset = "44444444-4444-4444-8444-444444444444";
   const job = "55555555-5555-4555-8555-555555555555";
   const key = `bookworm:setup:${actor}:${workspace}`;
   sessionStorage.setItem(key, JSON.stringify({ version: 1, userId: actor, workspaceId: workspace, bookId: book,
     savedAt: Date.now(), completed: false, importing: true, bookCreated: true, setupMode: "import",
     source: { assetId: asset, checksumSha256: "a".repeat(64), sizeBytes: 128, uploaded: true } }));
   window.fetch = async () => Response.json({ user: { id: actor } });
   window.bookwormApi = {
    listWorkspaces: async () => ({ workspaces: [{ id: workspace, name: "Workspace" }] }),
    getBook: async () => ({ book: { id: book, workspace_id: workspace, title: "Saved book", author_name: "Writer", language: "en" } }),
    listManuscriptImports: async () => ({ jobs: [{ id: job, book_id: book, source_asset_id: asset, status: "succeeded" }] }),
    getManuscriptImport: async () => ({ import: { sourceAssetId: window.correctSource ? asset : job,
      report: { chapterCount: 1, warnings: [window.correctSource ? "Check the title." : "Different source warning."] } } }),
   };
   return { book, job, key };
  });
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  await expect(page.getByRole("alert").filter({ hasText: "Status temporarily unavailable" })).toContainText("report could not be verified");
  await expect(page.getByText("Different source warning.")).toHaveCount(0);
  assert.equal(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)).completed, scope.key), false);
  await page.evaluate(() => { window.correctSource = true; });
  await page.getByRole("button", { name: "Check saved import status" }).click();
  await expect(page.getByText("Check the title.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "View import history in the Book Desk" })).toHaveAttribute("href",
    `/books/${scope.book}/overview#import-job-${scope.job}`);
  assert.equal(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)).completed, scope.key), true);
 } finally { await page.close(); }
});

test("an existing upload waits for a verified import status before allowing retry", async () => {
 const page = await browser.newPage();
 try {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://127.0.0.1/books/new");
  await page.evaluate(() => {
   const actor = "11111111-1111-4111-8111-111111111111";
   const workspace = "22222222-2222-4222-8222-222222222222";
   const book = "33333333-3333-4333-8333-333333333333";
   const asset = "44444444-4444-4444-8444-444444444444";
   const job = "55555555-5555-4555-8555-555555555555";
   const checkpoint = { version: 1, userId: actor, workspaceId: workspace, bookId: book, savedAt: Date.now(),
     completed: false, importing: true, bookCreated: true, setupMode: "import",
     source: { assetId: asset, checksumSha256: "a".repeat(64), sizeBytes: 128, uploaded: true } };
   window.setupKey = `bookworm:setup:${actor}:${workspace}`;
   sessionStorage.setItem(window.setupKey, JSON.stringify(checkpoint));
   window.originalSetup = sessionStorage.getItem(window.setupKey);
   window.importReads = 0;
   window.writes = 0;
   window.fetch = async () => Response.json({ user: { id: actor } });
   window.bookwormApi = {
    listWorkspaces: async () => ({ workspaces: [{ id: workspace, name: "Workspace" }] }),
    getBook: async () => ({ book: { id: book, workspace_id: workspace, title: "Saved book", author_name: "Writer", language: "en" } }),
    getManuscriptImport: async () => ({ import: null }),
    listManuscriptImports: async () => {
     const read = ++window.importReads;
     if (read === 1) return new Promise((_, reject) => { window.failStatusRead = () => reject(new Error("Import status is offline.")); });
     if (read === 2) return { jobs: [{ id: job, book_id: actor, source_asset_id: asset, status: "failed" }] };
     return { jobs: [] };
    },
    queueManuscriptImport: async () => { window.writes++; throw Error("Unexpected queue"); },
    retryManuscriptImport: async () => { window.writes++; throw Error("Unexpected retry"); },
   };
  });
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const retry = page.getByRole("button", { name: "Retry import", exact: true });
  const check = page.getByRole("button", { name: "Check saved import status", exact: true });
  await page.waitForFunction(() => typeof window.failStatusRead === "function");
  await expect(retry).toBeDisabled();
  await expect(page.getByText("Checking the saved import status…")).toBeVisible();
  await page.evaluate(() => window.failStatusRead());
  await expect(page.getByRole("alert")).toContainText("Import status is offline.");
  await expect(retry).toBeDisabled();
  await check.click();
  await expect(page.getByRole("alert")).toContainText("saved import job list could not be verified");
  await expect(retry).toBeDisabled();
  await check.click();
  await expect(retry).toBeEnabled();
  assert.deepEqual(await page.evaluate(() => ({
   reads: window.importReads, writes: window.writes, checkpointIntact: sessionStorage.getItem(window.setupKey) === window.originalSetup,
  })), { reads: 3, writes: 0, checkpointIntact: true });
 } finally { await page.close(); }
});

test('switching account during book creation stops the manuscript upload and keeps its recovery ID',async()=>{
 const page=await browser.newPage();try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));
 await page.goto('http://127.0.0.1/books/new');
 await page.evaluate(()=>{const owner='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222';window.actor=owner;window.calls=[];window.dest=null;
 window.fetch=async path=>{if(path==='/api/auth/session')return Response.json({user:{id:window.actor}});throw new Error('Unexpected fetch');};
 window.bookwormApi={listWorkspaces:async actor=>{window.calls.push(['workspaces',actor]);return {workspaces:[{id:workspace,name:'Workspace'}]};},
 createBook:async(body,actor)=>{window.calls.push(['create',actor]);window.releaseCreate=()=>{};await new Promise(resolve=>window.releaseCreate=resolve);return {id:body.requestId};},
 createAssetUploadUrl:async(...args)=>{window.calls.push(['allocate',args[1]]);throw Error('must not allocate');}};});
 await page.addScriptTag({content:bundled.outputFiles[0].text});
 await expect(page.getByRole('button',{name:'Create book',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Import manuscript',exact:true}).click();
 await page.getByPlaceholder('The title on the cover').fill('My private book');
 const language = page.getByRole('combobox', { name: 'Manuscript language' });
 await page.locator('input[type=file]').setInputFiles({name:'story.PDF',mimeType:'application/pdf',buffer:Buffer.from('PDF fixture')});
 await expect(language).toHaveAccessibleDescription(/choose the language printed on the page/);
 await page.locator('input[type=file]').setInputFiles({name:'story.txt',mimeType:'text/plain',buffer:Buffer.from('my manuscript')});
 await expect(language).toHaveAccessibleDescription('');
 await page.getByRole('button',{name:'Create and import',exact:true}).click();
 await page.waitForFunction(()=>typeof window.releaseCreate==='function');
 await page.evaluate(()=>{window.actor='33333333-3333-4333-8333-333333333333';window.releaseCreate();});
 await expect(page.getByText('The original account could not be verified.',{exact:false})).toBeVisible();
 assert.deepEqual(await page.evaluate(()=>window.calls),[['workspaces','11111111-1111-4111-8111-111111111111'],['create','11111111-1111-4111-8111-111111111111']]);
 const state=await page.evaluate(()=>Object.values(sessionStorage).map(s=>JSON.parse(s)).find(v=>v.version===1));
 assert.equal(state.userId,'11111111-1111-4111-8111-111111111111');assert.equal(state.bookCreated,false);assert.equal(await page.evaluate(()=>window.dest),null);
 }finally{await page.close();}
});

test("first draft model lookup can recover without recreating the book or losing the brief", async () => {
 const page = await browser.newPage();
 try {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://127.0.0.1/books/new");
  await page.evaluate(() => {
   const owner = "11111111-1111-4111-8111-111111111111";
   const workspace = "22222222-2222-4222-8222-222222222222";
   window.calls = { books: 0, chapters: 0, catalogs: [], quotes: 0 };
   window.fetch = async () => Response.json({ user: { id: owner } });
   window.bookwormApi = {
    listWorkspaces: async () => ({ workspaces: [{ id: workspace, name: "Workspace" }] }),
    createBook: async body => { window.calls.books++; return { id: body.requestId }; },
    createChapter: async book => {
     window.calls.chapters++;
     return { chapter: { id: "44444444-4444-4444-8444-444444444444", book_id: book } };
    },
    listAiReviewModels: async (book, actor) => {
     window.calls.catalogs.push({ book, actor });
     if (window.calls.catalogs.length === 1) throw Error("Temporary catalog failure");
     return { models: window.calls.catalogs.length === 2 ? [] : [{ id: "writer", label: "Writer" }] };
    },
    createAiReviewQuote: async () => { window.calls.quotes++; throw Error("Quote was not requested"); },
   };
  });
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  await page.getByRole("button", { name: "Start with AI", exact: true }).click();
  await page.getByPlaceholder("The title on the cover").fill("Preview book");
  const brief = page.getByLabel("Story brief");
  await brief.fill("A private opening scene");
  await page.getByRole("button", { name: "Create book & Chapter 1", exact: true }).click();
  const check = page.getByRole("button", { name: "Check writing models" });
  await expect(page.getByText(/Could not load writing models/)).toBeVisible();
  await check.click();
  await expect(page.getByText(/No writing model is available for a new quote/)).toBeVisible();
  await check.click();
  await expect(page.getByLabel("Generation model")).toHaveValue("writer");
  await expect(brief).toHaveValue("A private opening scene");
  await expect(page.getByRole("button", { name: "Prepare exact credit quote" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Continue to editor" })).toBeEnabled();
  const calls = await page.evaluate(() => window.calls);
  assert.equal(calls.books, 1);
  assert.equal(calls.chapters, 1);
  assert.equal(calls.catalogs.length, 3);
  assert.equal(new Set(calls.catalogs.map(call => call.book)).size, 1);
  assert.ok(calls.catalogs.every(call => call.actor === "11111111-1111-4111-8111-111111111111"));
  assert.equal(calls.quotes, 0);
 } finally { await page.close(); }
});

test('switching accounts during token counting hides the quote and retains only the original recovery key',async()=>{
 const page=await browser.newPage();try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1/books/new');
 await page.evaluate(()=>{const owner='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222',chapter='44444444-4444-4444-8444-444444444444';window.actor=owner;window.calls=[];window.dest=null;
 window.fetch=async path=>{if(path==='/api/auth/session')return Response.json({user:{id:window.actor}});throw Error('Unexpected fetch');};
 window.bookwormApi={listWorkspaces:async actor=>({workspaces:[{id:workspace,name:'Workspace'}]}),
 createBook:async(body,actor)=>{window.calls.push(['book',actor]);return {id:body.requestId}},
 createChapter:async(book,body,actor)=>{window.calls.push(['chapter',actor]);return {chapter:{id:chapter,book_id:book}}},
 listAiReviewModels:async(book,actor)=>({models:[{id:'writer',label:'Writer'}]}),
 createAiReviewQuote:async(book,body,actor)=>{window.calls.push(['count',actor]);await new Promise(resolve=>window.releaseQuote=resolve);return {quote:{requestId:'55555555-5555-4555-8555-555555555555',reservedCredits:5,countedInputTokens:30,maxOutputTokens:50,expiresAt:'2030-01-01T00:00:00.000Z'}}},
 acceptAiReviewQuote:async()=>{window.calls.push(['accept']);throw Error('unexpected accept');}};});
 await page.addScriptTag({content:bundled.outputFiles[0].text});await expect(page.getByRole('button',{name:'Create book',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Start with AI',exact:true}).click();await page.getByPlaceholder('The title on the cover').fill('Private book');await page.locator('textarea').fill('A small private story.');
 await page.getByRole('button',{name:'Create book & Chapter 1',exact:true}).click();await expect(page.getByLabel('Generation model')).toBeVisible();
 await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Prepare exact credit quote'}).click();await page.waitForFunction(()=>typeof window.releaseQuote==='function');
 await page.evaluate(()=>{window.actor='33333333-3333-4333-8333-333333333333';window.releaseQuote();});
 await expect(page.getByText('The original account could not be verified.',{exact:false})).toBeVisible();
 assert.deepEqual(await page.evaluate(()=>window.calls),[['book','11111111-1111-4111-8111-111111111111'],['chapter','11111111-1111-4111-8111-111111111111'],['count','11111111-1111-4111-8111-111111111111']]);
 const state=await page.evaluate(()=>Object.values(sessionStorage).map(s=>JSON.parse(s)).find(v=>v.version===1));assert.ok(state.starter.quoteKey);assert.equal(state.starter.quoteRequestId,undefined);assert.doesNotMatch(JSON.stringify(state),/private story/);assert.equal(await page.evaluate(()=>window.dest),null);
 }finally{await page.close()}
});


test('starting another book holds the setup lock while the original account is checked',async()=>{
 const page=await browser.newPage();try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1/books/new');
 await page.evaluate(()=>{const owner='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222',book='33333333-3333-4333-8333-333333333333';window.calls=[];window.holdNext=false;window.checks=0;window.dest=null;
 sessionStorage.setItem(`bookworm:setup:${owner}:${workspace}`,JSON.stringify({version:1,userId:owner,workspaceId:workspace,bookId:book,savedAt:Date.now(),completed:false,importing:false,setupMode:'ai',bookCreated:true}));
 window.fetch=async path=>{if(path!=='/api/auth/session')throw Error('Unexpected fetch');window.checks++;if(window.holdNext){window.holdNext=false;await new Promise(resolve=>window.releaseSession=resolve)}return Response.json({user:{id:owner}})};
 window.bookwormApi={listWorkspaces:async()=>({workspaces:[{id:workspace,name:'Workspace'}]}),getBook:async()=>({book:{id:book,workspace_id:workspace,title:'Book',author_name:'Author',genre:null,language:'en'}}),listAiReviewModels:async()=>({models:[]}),
 createChapter:async()=>{window.calls.push('chapter');await new Promise(resolve=>window.releaseChapter=resolve);return {chapter:{id:'44444444-4444-4444-8444-444444444444',book_id:book}}}};});
 await page.addScriptTag({content:bundled.outputFiles[0].text});
 await expect(page.getByRole('button',{name:'Start another book'})).toBeVisible();await page.waitForFunction(()=>window.checks>=6);
 await page.evaluate(()=>{window.holdNext=true});await page.getByRole('button',{name:'Start another book'}).click();await page.waitForFunction(()=>typeof window.releaseSession==='function');
 await page.evaluate(()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 await page.waitForTimeout(300);assert.deepEqual(await page.evaluate(()=>window.calls),[]);
 assert.equal(await page.evaluate(()=>Object.values(sessionStorage).some(v=>{try{return JSON.parse(v).bookCreated===true}catch{return false}})),true);
 await page.evaluate(()=>window.releaseSession());await expect(page.getByRole('button',{name:'Create book & Chapter 1',exact:true})).toBeEnabled();
 assert.equal(await page.evaluate(()=>Object.values(sessionStorage).some(v=>{try{return JSON.parse(v).bookCreated===true}catch{return false}})),false);
 }finally{await page.close()}
});

test('continuing to editor holds setup lock until navigation is decided',async()=>{
 const page=await browser.newPage();try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1/books/new');
 await page.evaluate(()=>{const owner='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222',book='33333333-3333-4333-8333-333333333333';window.calls=[];window.holdNext=false;window.checks=0;window.dest=null;
 sessionStorage.setItem(`bookworm:setup:${owner}:${workspace}`,JSON.stringify({version:1,userId:owner,workspaceId:workspace,bookId:book,savedAt:Date.now(),completed:false,importing:false,setupMode:'ai',bookCreated:true}));
 window.fetch=async path=>{if(path!=='/api/auth/session')throw Error('Unexpected fetch');window.checks++;if(window.holdNext){window.holdNext=false;await new Promise(resolve=>window.releaseSession=resolve)}return Response.json({user:{id:owner}})};
 window.bookwormApi={listWorkspaces:async()=>({workspaces:[{id:workspace,name:'Workspace'}]}),getBook:async()=>({book:{id:book,workspace_id:workspace,title:'Book',author_name:'Author',genre:null,language:'en'}}),listAiReviewModels:async()=>({models:[]}),
 createChapter:async()=>{window.calls.push('chapter');await new Promise(resolve=>window.releaseChapter=resolve);return {chapter:{id:'44444444-4444-4444-8444-444444444444',book_id:book}}}};});
 await page.addScriptTag({content:bundled.outputFiles[0].text});
 await expect(page.getByRole('button',{name:'Start another book'})).toBeVisible();await page.waitForFunction(()=>window.checks>=6);
 await page.evaluate(()=>{window.holdNext=true});await page.getByRole('button',{name:'Continue to editor'}).click();await page.waitForFunction(()=>typeof window.releaseSession==='function');
 await page.evaluate(()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 await page.waitForTimeout(300);assert.deepEqual(await page.evaluate(()=>window.calls),[]);
 assert.equal(await page.evaluate(()=>Object.values(sessionStorage).some(v=>{try{return JSON.parse(v).bookCreated===true}catch{return false}})),true);
 await page.evaluate(()=>window.releaseSession());await page.waitForFunction(()=>typeof window.dest==='string');
 assert.match(await page.evaluate(()=>window.dest),/\/books\/33333333-3333-4333-8333-333333333333/);
 assert.equal(await page.evaluate(()=>Object.values(sessionStorage).some(v=>{try{return JSON.parse(v).bookCreated===true}catch{return false}})),true);
 }finally{await page.close()}
});

test('first draft quote locks the exact brief while counting and when ready',async()=>{
 const page=await browser.newPage();try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1/books/new');
 await page.evaluate(()=>{const owner='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222',chapter='44444444-4444-4444-8444-444444444444';window.actor=owner;window.calls=[];
 window.fetch=async path=>{if(path==='/api/auth/session')return Response.json({user:{id:owner}});throw Error('Unexpected fetch')};
 window.bookwormApi={listWorkspaces:async()=>({workspaces:[{id:workspace,name:'Workspace'}]}),createBook:async body=>({id:body.requestId}),createChapter:async book=>({chapter:{id:chapter,book_id:book}}),listAiReviewModels:async()=>({models:[{id:'writer',label:'Writer'}]}),
 createAiReviewQuote:async(book,body)=>{window.calls.push(body.userInstruction);await new Promise(resolve=>window.releaseQuote=resolve);return {quote:{requestId:'55555555-5555-4555-8555-555555555555',status:'ready',agentType:'writer',model:'test-model',reservedCredits:5,countedInputTokens:30,maxOutputTokens:50,expiresAt:'2030-01-01T00:00:00.000Z'}}},
 getAiReviewQuote:async()=>({quote:{requestId:'55555555-5555-4555-8555-555555555555',status:'ready',agentType:'writer',model:'test-model',reservedCredits:5,countedInputTokens:30,maxOutputTokens:50,expiresAt:'2030-01-01T00:00:00.000Z'}})};});
 await page.addScriptTag({content:bundled.outputFiles[0].text});await expect(page.getByRole('button',{name:'Create book',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Start with AI',exact:true}).click();await page.getByPlaceholder('The title on the cover').fill('Book');
 const brief=page.getByLabel('Story brief');await brief.fill('Original opening scene');await page.getByRole('button',{name:'Create book & Chapter 1',exact:true}).click();await expect(page.getByLabel('Generation model')).toBeVisible();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Prepare exact credit quote'}).click();await page.waitForFunction(()=>typeof window.releaseQuote==='function');
 await expect(brief).toBeDisabled();await page.evaluate(()=>window.releaseQuote());await expect(page.getByText('Exact quote · 5 credits')).toBeVisible();await expect(brief).toBeDisabled();await expect(page.getByRole('button',{name:'Accept · 5 credits and generate'})).toBeEnabled();assert.deepEqual(await page.evaluate(()=>window.calls),['Original opening scene']);
 }finally{await page.close()}
});

test('a recovered quote cannot be accepted when its original brief is unavailable',async()=>{
 const page=await browser.newPage();try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1/books/new');
 await page.evaluate(()=>{const owner='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222',book='33333333-3333-4333-8333-333333333333',chapter='44444444-4444-4444-8444-444444444444',request='55555555-5555-4555-8555-555555555555';window.calls=[];
 sessionStorage.setItem(`bookworm:setup:${owner}:${workspace}`,JSON.stringify({version:1,userId:owner,workspaceId:workspace,bookId:book,savedAt:Date.now(),completed:false,importing:false,setupMode:'ai',bookCreated:true,starter:{chapterId:chapter,quoteKey:'story-starter:key',quoteRequestId:request,modelId:'writer',allowProviderTokenCounting:true}}));
 window.fetch=async path=>{if(path==='/api/auth/session')return Response.json({user:{id:owner}});throw Error('Unexpected fetch')};window.bookwormApi={listWorkspaces:async()=>({workspaces:[{id:workspace,name:'Workspace'}]}),getBook:async()=>({book:{id:book,workspace_id:workspace,title:'Book',author_name:'Author',genre:null,language:'en'}}),listAiReviewModels:async()=>({models:[{id:'writer',label:'Writer'}]}),getAiReviewQuote:async()=>({quote:{requestId:request,status:'ready',agentType:'writer',model:'test-model',reservedCredits:5,countedInputTokens:30,maxOutputTokens:50,expiresAt:'2030-01-01T00:00:00.000Z'}}),acceptAiReviewQuote:async()=>{window.calls.push('accept');throw Error('unexpected')}};});
 await page.addScriptTag({content:bundled.outputFiles[0].text});await expect(page.getByText('Exact quote · 5 credits')).toBeVisible();await expect(page.getByRole('button',{name:'Accept · 5 credits and generate'})).toBeDisabled();await expect(page.getByText('The original story brief is unavailable in this tab',{exact:false})).toBeVisible();assert.deepEqual(await page.evaluate(()=>window.calls),[]);
 }finally{await page.close()}
});

test('a failed first-draft count permits a fresh request with a new key',async()=>{
 const page=await browser.newPage();try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1/books/new');
 await page.evaluate(()=>{const owner='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222',chapter='44444444-4444-4444-8444-444444444444';window.keys=[];
 window.fetch=async path=>{if(path==='/api/auth/session')return Response.json({user:{id:owner}});throw Error('Unexpected fetch')};window.bookwormApi={listWorkspaces:async()=>({workspaces:[{id:workspace,name:'Workspace'}]}),createBook:async body=>({id:body.requestId}),createChapter:async book=>({chapter:{id:chapter,book_id:book}}),listAiReviewModels:async()=>({models:[{id:'writer',label:'Writer'}]}),
 createAiReviewQuote:async(book,body)=>{window.keys.push(body.idempotencyKey);return window.keys.length===1?{request:{id:'55555555-5555-4555-8555-555555555555',status:'counting'},quote:null}:{quote:{requestId:'66666666-6666-4666-8666-666666666666',status:'ready',agentType:'writer',model:'test-model',reservedCredits:5,countedInputTokens:30,maxOutputTokens:50,expiresAt:'2030-01-01T00:00:00.000Z'}}},
 getAiReviewQuote:async(book,id)=>({quote:id.startsWith('5555')?{requestId:id,status:'failed'}:{requestId:id,status:'ready',agentType:'writer',model:'test-model',reservedCredits:5,countedInputTokens:30,maxOutputTokens:50,expiresAt:'2030-01-01T00:00:00.000Z'}})};});
 await page.addScriptTag({content:bundled.outputFiles[0].text});await expect(page.getByRole('button',{name:'Create book',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Start with AI',exact:true}).click();await page.getByPlaceholder('The title on the cover').fill('Book');await page.getByLabel('Story brief').fill('Original opening');await page.getByRole('button',{name:'Create book & Chapter 1',exact:true}).click();await expect(page.getByLabel('Generation model')).toBeVisible();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Prepare exact credit quote'}).click();
 await expect(page.getByText('Token counting failed.',{exact:false})).toBeVisible();await expect(page.getByLabel('Story brief')).toBeEnabled();await page.getByLabel('Story brief').fill('Revised opening');await page.getByRole('button',{name:'Prepare exact credit quote'}).click();await expect(page.getByRole('button',{name:'Accept · 5 credits and generate'})).toBeEnabled();const keys=await page.evaluate(()=>window.keys);assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);
 }finally{await page.close()}
});

test('lost quote response retries only the original request and never accepts changed text',async()=>{
 const page=await browser.newPage();try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1/books/new');
 await page.evaluate(()=>{const owner='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222',chapter='44444444-4444-4444-8444-444444444444',request='55555555-5555-4555-8555-555555555555';window.requests=[];window.accepts=0;
 window.fetch=async path=>{if(path==='/api/auth/session')return Response.json({user:{id:owner}});throw Error('Unexpected fetch')};window.bookwormApi={listWorkspaces:async()=>({workspaces:[{id:workspace,name:'Workspace'}]}),createBook:async body=>({id:body.requestId}),createChapter:async book=>({chapter:{id:chapter,book_id:book}}),listAiReviewModels:async()=>({models:[{id:'writer',label:'Writer'},{id:'another',label:'Another writer'}]}),
 createAiReviewQuote:async(book,body)=>{window.requests.push({key:body.idempotencyKey,brief:body.userInstruction,model:body.modelId});if(window.requests.length===1)throw Error('Response lost');if(body.userInstruction!=='Original opening')throw Error('This AI review quote key is already bound to different settings or saved inputs.');return {quote:{requestId:request,status:'ready',agentType:'writer',model:'test-model',reservedCredits:5,countedInputTokens:30,maxOutputTokens:50,expiresAt:'2030-01-01T00:00:00.000Z'}}},getAiReviewQuote:async()=>({quote:{requestId:request,status:'ready',agentType:'writer',model:'test-model',reservedCredits:5,countedInputTokens:30,maxOutputTokens:50,expiresAt:'2030-01-01T00:00:00.000Z'}}),acceptAiReviewQuote:async()=>{window.accepts++;throw Error('unexpected')}};});
 await page.addScriptTag({content:bundled.outputFiles[0].text});await expect(page.getByRole('button',{name:'Create book',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Start with AI',exact:true}).click();await page.getByPlaceholder('The title on the cover').fill('Book');const brief=page.getByLabel('Story brief');await brief.fill('Original opening');await page.getByRole('button',{name:'Create book & Chapter 1',exact:true}).click();await expect(page.getByLabel('Generation model')).toBeVisible();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Prepare exact credit quote'}).click();await expect(page.getByText('Response lost',{exact:false})).toBeVisible();
 const model=page.getByLabel('Generation model');
 await expect(model).toBeDisabled();
 await expect(model).toHaveValue('writer');
 const retry=page.getByRole('button',{name:'Retry same quote request'});
 await brief.fill('Different opening');await retry.click();await expect(page.getByText('This AI review quote key is already bound',{exact:false})).toBeVisible();assert.equal(await page.getByRole('button',{name:/Accept ·/}).count(),0);
 await brief.fill('Original opening');await retry.click();await expect(page.getByRole('button',{name:'Accept · 5 credits and generate'})).toBeEnabled();const observed=await page.evaluate(()=>({requests:window.requests,accepts:window.accepts,storage:Object.values(sessionStorage).join(' ')}));assert.equal(new Set(observed.requests.map(v=>v.key)).size,1);assert.ok(observed.requests.every(v=>v.model==='writer'));assert.deepEqual(observed.requests.map(v=>v.brief),['Original opening','Different opening','Original opening']);assert.equal(observed.accepts,0);assert.doesNotMatch(observed.storage,/Original opening|Different opening/);
 }finally{await page.close()}
});

test("a lost quote can recover its original model after the catalog changes", async () => {
 const page = await browser.newPage();
 try {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://127.0.0.1/books/new");
  await page.evaluate(() => {
   const owner = "11111111-1111-4111-8111-111111111111";
   const workspace = "22222222-2222-4222-8222-222222222222";
   const book = "33333333-3333-4333-8333-333333333333";
   const chapter = "44444444-4444-4444-8444-444444444444";
   window.fetch = async () => Response.json({ user: { id: owner } });
   window.calls = [];
   window.bookwormApi = {
    listWorkspaces: async () => ({ workspaces: [{ id: workspace, name: "Workspace" }] }),
    getBook: async () => ({ book: { id: book, workspace_id: workspace, title: "Saved book", author_name: "Author", language: "en" } }),
    listAiReviewModels: async () => ({ models: [{ id: "new-writer", label: "New writer" }] }),
    createAiReviewQuote: async (bookId, body, actor) => {
     window.calls.push({ bookId, model: body.modelId, key: body.idempotencyKey, actor });
     return { quote: {
      requestId: "55555555-5555-4555-8555-555555555555", status: "ready", agentType: "writer", model: "old-model",
      reservedCredits: 5, countedInputTokens: 30, maxOutputTokens: 50, expiresAt: "2030-01-01T00:00:00.000Z",
     } };
    },
    getAiReviewQuote: async () => { throw Error("Ignore polling in this fixture"); },
   };
   sessionStorage.setItem(`bookworm:setup:${owner}:${workspace}`, JSON.stringify({
    version: 1, userId: owner, workspaceId: workspace, bookId: book, savedAt: Date.now(), completed: false,
    importing: false, setupMode: "ai", bookCreated: true,
    starter: { chapterId: chapter, quoteKey: "story-starter:recovery", modelId: "old-writer", allowProviderTokenCounting: true },
   }));
  });
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const model = page.getByLabel("Generation model");
  await expect(model).toHaveValue("old-writer");
  await expect(model).toBeDisabled();
  await page.getByLabel("Story brief").fill("My original opening");
  await page.getByRole("button", { name: "Retry same quote request" }).click();
  await expect(page.getByRole("button", { name: "Accept · 5 credits and generate" })).toBeEnabled();
  assert.deepEqual(await page.evaluate(() => window.calls), [{
   bookId: "33333333-3333-4333-8333-333333333333", model: "old-writer",
   key: "story-starter:recovery", actor: "11111111-1111-4111-8111-111111111111",
  }]);
 } finally { await page.close(); }
});

test('uncertain first-draft acceptance keeps its recovery identity and blocks a duplicate after reload',async()=>{
 const page=await browser.newPage();try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1/books/new');
 const install=async()=>page.evaluate(()=>{const owner='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222',chapter='44444444-4444-4444-8444-444444444444',request='55555555-5555-4555-8555-555555555555';window.accepts=0;window.jobReady=false;
 window.fetch=async path=>{if(path==='/api/auth/session')return Response.json({user:{id:owner}});throw Error('Unexpected fetch')};const quote={requestId:request,status:'ready',agentType:'writer',model:'test-model',reservedCredits:5,countedInputTokens:30,maxOutputTokens:50,expiresAt:'2030-01-01T00:00:00.000Z'};
 window.bookwormApi={listWorkspaces:async()=>({workspaces:[{id:workspace,name:'Workspace'}]}),createBook:async body=>({id:body.requestId}),getBook:async book=>({book:{id:book,workspace_id:workspace,title:'Book',author_name:'Author',genre:null,language:'en'}}),createChapter:async book=>({chapter:{id:chapter,book_id:book}}),listAiReviewModels:async()=>({models:[{id:'writer',label:'Writer'}]}),createAiReviewQuote:async()=>({quote}),getAiReviewQuote:async()=>({quote,...(window.jobReady?{job:{id:'66666666-6666-4666-8666-666666666666',status:'queued'}}:{})}),acceptAiReviewQuote:async()=>{window.accepts++;throw Error('Reply lost')}};});
 await install();await page.addScriptTag({content:bundled.outputFiles[0].text});await expect(page.getByRole('button',{name:'Create book',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Start with AI',exact:true}).click();await page.getByPlaceholder('The title on the cover').fill('Book');await page.getByLabel('Story brief').fill('Original opening');await page.getByRole('button',{name:'Create book & Chapter 1',exact:true}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Prepare exact credit quote'}).click();await expect(page.getByRole('button',{name:'Accept · 5 credits and generate'})).toBeEnabled();await page.getByRole('button',{name:'Accept · 5 credits and generate'}).click();
 await expect(page.getByText('Acceptance may still complete.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Start another book'})).toBeDisabled();assert.equal(await page.evaluate(()=>window.accepts),1);assert.equal(await page.evaluate(()=>Object.values(sessionStorage).some(raw=>{try{return JSON.parse(raw).starter?.acceptAttempted===true}catch{return false}})),true);
 await page.reload();await install();await page.addScriptTag({content:bundled.outputFiles[0].text});await expect(page.getByText('Acceptance may still complete.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Start another book'})).toBeDisabled();await expect(page.getByRole('button',{name:'Accept · 5 credits and generate'})).toBeDisabled();assert.equal(await page.evaluate(()=>window.accepts),0);
 await page.evaluate(()=>{window.jobReady=true});await expect(page.getByText('Your first draft is queued.',{exact:false})).toBeVisible({timeout:6000});await expect(page.getByRole('button',{name:'Start another book'})).toBeEnabled();
 }finally{await page.close()}
});

test('first-draft acceptance does not dispatch when recovery storage fails',async()=>{
 const page=await browser.newPage();try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1/books/new');
 await page.evaluate(()=>{const owner='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222',chapter='44444444-4444-4444-8444-444444444444',request='55555555-5555-4555-8555-555555555555';window.accepts=0;window.fetch=async path=>{if(path==='/api/auth/session')return Response.json({user:{id:owner}});throw Error('Unexpected fetch')};const quote={requestId:request,status:'ready',agentType:'writer',model:'test-model',reservedCredits:5,countedInputTokens:30,maxOutputTokens:50,expiresAt:'2030-01-01T00:00:00.000Z'};window.bookwormApi={listWorkspaces:async()=>({workspaces:[{id:workspace,name:'Workspace'}]}),createBook:async body=>({id:body.requestId}),createChapter:async book=>({chapter:{id:chapter,book_id:book}}),listAiReviewModels:async()=>({models:[{id:'writer',label:'Writer'}]}),createAiReviewQuote:async()=>({quote}),getAiReviewQuote:async()=>({quote}),acceptAiReviewQuote:async()=>{window.accepts++;throw Error('unexpected')}};});
 await page.addScriptTag({content:bundled.outputFiles[0].text});await expect(page.getByRole('button',{name:'Create book',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Start with AI',exact:true}).click();await page.getByPlaceholder('The title on the cover').fill('Book');await page.getByLabel('Story brief').fill('Original opening');await page.getByRole('button',{name:'Create book & Chapter 1',exact:true}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Prepare exact credit quote'}).click();await expect(page.getByRole('button',{name:'Accept · 5 credits and generate'})).toBeEnabled();await page.evaluate(()=>{Storage.prototype.setItem=function(){throw Error('storage blocked')}});await page.getByRole('button',{name:'Accept · 5 credits and generate'}).click();await expect(page.getByText('No acceptance was sent',{exact:false})).toBeVisible();assert.equal(await page.evaluate(()=>window.accepts),0);
 }finally{await page.close()}
});

test('definite first-draft acceptance refusal releases recovery after no job is verified',async()=>{
 const page=await browser.newPage();try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1/books/new');
 await page.evaluate(()=>{const owner='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222',chapter='44444444-4444-4444-8444-444444444444',request='55555555-5555-4555-8555-555555555555';window.fetch=async path=>{if(path==='/api/auth/session')return Response.json({user:{id:owner}});throw Error('Unexpected fetch')};const quote={requestId:request,status:'ready',agentType:'writer',model:'test-model',reservedCredits:5,countedInputTokens:30,maxOutputTokens:50,expiresAt:'2030-01-01T00:00:00.000Z'};window.bookwormApi={listWorkspaces:async()=>({workspaces:[{id:workspace,name:'Workspace'}]}),createBook:async body=>({id:body.requestId}),createChapter:async book=>({chapter:{id:chapter,book_id:book}}),listAiReviewModels:async()=>({models:[{id:'writer',label:'Writer'}]}),createAiReviewQuote:async()=>({quote}),getAiReviewQuote:async()=>({quote}),acceptAiReviewQuote:async()=>{throw new window.TestApiClientError(402,'insufficient','Insufficient credits','test')}};});
 await page.addScriptTag({content:bundled.outputFiles[0].text});await expect(page.getByRole('button',{name:'Create book',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Start with AI',exact:true}).click();await page.getByPlaceholder('The title on the cover').fill('Book');await page.getByLabel('Story brief').fill('Original opening');await page.getByRole('button',{name:'Create book & Chapter 1',exact:true}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Prepare exact credit quote'}).click();await expect(page.getByRole('button',{name:'Accept · 5 credits and generate'})).toBeEnabled();await page.getByRole('button',{name:'Accept · 5 credits and generate'}).click();await expect(page.getByText('No accepted job was found.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Start another book'})).toBeEnabled();assert.equal(await page.evaluate(()=>Object.values(sessionStorage).some(raw=>{try{return JSON.parse(raw).starter?.acceptAttempted===true}catch{return false}})),false);
 }finally{await page.close()}
});

test('late quote status cannot erase a pending or recovered first-draft acceptance',async()=>{
 const page=await browser.newPage();try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1/books/new');
 await page.evaluate(()=>{const owner='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222',chapter='44444444-4444-4444-8444-444444444444',request='55555555-5555-4555-8555-555555555555',job='66666666-6666-4666-8666-666666666666';window.calls=0;window.jobReady=false;window.fetch=async path=>{if(path==='/api/auth/session')return Response.json({user:{id:owner}});throw Error('Unexpected fetch')};const quote={requestId:request,status:'ready',agentType:'writer',model:'test-model',reservedCredits:5,countedInputTokens:30,maxOutputTokens:50,expiresAt:'2030-01-01T00:00:00.000Z'};window.bookwormApi={listWorkspaces:async()=>({workspaces:[{id:workspace,name:'Workspace'}]}),createBook:async body=>({id:body.requestId}),createChapter:async book=>({chapter:{id:chapter,book_id:book}}),listAiReviewModels:async()=>({models:[{id:'writer',label:'Writer'}]}),createAiReviewQuote:async()=>({quote}),getAiReviewQuote:async()=>{window.calls++;if(window.calls===1){await new Promise(resolve=>window.releaseOld=resolve);return {quote:{requestId:request,status:'failed'}}}return {quote,...(window.jobReady?{job:{id:job,status:'queued'}}:{})}},acceptAiReviewQuote:async()=>{await new Promise((_,reject)=>window.rejectAccept=reject)}};});
 await page.addScriptTag({content:bundled.outputFiles[0].text});await expect(page.getByRole('button',{name:'Create book',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Start with AI',exact:true}).click();await page.getByPlaceholder('The title on the cover').fill('Book');await page.getByLabel('Story brief').fill('Original opening');await page.getByRole('button',{name:'Create book & Chapter 1',exact:true}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Prepare exact credit quote'}).click();await page.waitForFunction(()=>typeof window.releaseOld==='function');await page.getByRole('button',{name:'Accept · 5 credits and generate'}).click();await page.waitForFunction(()=>typeof window.rejectAccept==='function');await page.evaluate(()=>window.releaseOld());
 assert.equal(await page.evaluate(()=>Object.values(sessionStorage).some(raw=>{try{return JSON.parse(raw).starter?.acceptAttempted===true}catch{return false}})),true);
 await page.evaluate(()=>{window.jobReady=true});await expect(page.getByText('Your first draft is queued.',{exact:false})).toBeVisible({timeout:6000});await page.evaluate(()=>window.rejectAccept(new window.TestApiClientError(402,'insufficient','Insufficient credits','test')));await expect(page.getByRole('button',{name:'Start another book'})).toBeEnabled();const saved=await page.evaluate(()=>Object.values(sessionStorage).map(v=>{try{return JSON.parse(v)}catch{return null}}).find(v=>v?.starter));assert.equal(saved.completed,true);assert.equal(saved.starter.jobId,'66666666-6666-4666-8666-666666666666');
 }finally{await page.close()}
});
