import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {chromium, expect} from "@playwright/test";
const bundled=await build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import Setup from './apps/web/components/BookSetupClient'; createRoot(document.getElementById('root')).render(React.createElement(Setup));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',plugins:[{name:'fixtures',setup(b){
 b.onResolve({filter:/^(next\/link|next\/navigation|\.\/api|\.\/AuthorShell)$/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({resolveDir:process.cwd(),contents:a.path==='next/link'?`import React from 'react'; export default p=>React.createElement('a',p,p.children);`:a.path==='next/navigation'?`export const useRouter=()=>({push: x=>window.dest=x});`:a.path==='./AuthorShell'?`import React from 'react'; export const AuthorHeader=()=>React.createElement('div');`:`export const apiClient=()=>window.bookwormApi;`}));
}}]});
const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_TEST_CHANNEL||'chromium-headless-shell'}); test.after(()=>browser.close());
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
 await page.locator('input[type=file]').setInputFiles({name:'story.txt',mimeType:'text/plain',buffer:Buffer.from('my manuscript')});
 await page.getByRole('button',{name:'Create and import',exact:true}).click();
 await page.waitForFunction(()=>typeof window.releaseCreate==='function');
 await page.evaluate(()=>{window.actor='33333333-3333-4333-8333-333333333333';window.releaseCreate();});
 await expect(page.getByText('The original account could not be verified.',{exact:false})).toBeVisible();
 assert.deepEqual(await page.evaluate(()=>window.calls),[['workspaces','11111111-1111-4111-8111-111111111111'],['create','11111111-1111-4111-8111-111111111111']]);
 const state=await page.evaluate(()=>Object.values(sessionStorage).map(s=>JSON.parse(s)).find(v=>v.version===1));
 assert.equal(state.userId,'11111111-1111-4111-8111-111111111111');assert.equal(state.bookCreated,false);assert.equal(await page.evaluate(()=>window.dest),null);
 }finally{await page.close();}
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
