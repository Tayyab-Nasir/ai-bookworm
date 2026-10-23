// Real component and CSS, isolated synthetic transport. No account or paid service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const id=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const A=id(1), B=id(2), USER=id(3), SPACE=id(4), now='2026-10-24T00:00:00.000Z';
const artifacts=await mkdtemp(resolve(tmpdir(),'bookworm-book-desk-'));
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import BookOverview from './apps/web/components/BookOverview';const root=createRoot(document.getElementById('root'));window.mountDesk=bookId=>root.render(React.createElement(BookOverview,{bookId}));`,resolveDir:process.cwd(),loader:'tsx'},
  bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',outfile:resolve(artifacts,'desk.js'),plugins:[{name:'desk-fixtures',setup(builder){
    builder.onResolve({filter:/^(next\/link|\.\/api)$/},args=>({path:args.path,namespace:'fixture'}));
    builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({resolveDir:process.cwd(),contents:args.path==='./api'?'export const apiClient=()=>window.bookwormApi;':`import React from 'react';export default function Link(props){return React.createElement('a',props);}`}));
  }}]});
const stylePath=resolve('apps/web/styles/globals.css');
const globals=await postcss([tailwind({base:resolve('apps/web'),optimize:false})]).process(await readFile(stylePath,'utf8'),{from:stylePath});
const font=(await readFile('apps/web/app/fonts/instrument-serif-italic.ttf')).toString('base64');
const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_TEST_CHANNEL||'msedge'});
test.after(()=>browser.close());
function data(bookId=A){return {viewerId:USER,observedAt:now,book:{id:bookId,workspaceId:SPACE,title:bookId===B?'The Second Notebook':'The Harbor Notebook',subtitle:'A journey kept in the margins',authorName:'Synthetic Author',language:'en',genre:'Literary adventure',status:'draft',updatedAt:now},
  workspace:{id:SPACE,name:'Harbor Studio',role:'owner'},manuscript:{chapterCount:2,wordCount:1235,chaptersWithoutSavedVersion:0},
  chapters:[{id:id(5),title:'The harbor at dawn',orderIndex:0,versionNumber:2,wordCount:1230,updatedAt:now},{id:id(6),title:'An unfamiliar tide',orderIndex:1,versionNumber:1,wordCount:5,updatedAt:now}],
  bibleItems:7,listing:{description:false,keywords:2,categories:1,isbn:false},editionsTotal:1,editions:[{id:id(7),kind:'print',status:'draft',updatedAt:now,coverArtworkChosen:true}],history:{renders:2,packages:1},
  jobs:[{id:id(8),kind:'publishing',label:'Edition render',status:'succeeded',createdAt:now,completedAt:now,destination:'publish'},{id:id(9),kind:'ai',label:'Proofreading',status:'failed',createdAt:now,completedAt:now,destination:'editor'}]};}
async function fixture(mode='normal',width=1280){
  const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(8000);
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><div id="root"></div></body></html>'}));
  await page.goto(`http://127.0.0.1/books/${A}/overview`);
  await page.addStyleTag({content:globals.css+'\n'+bundle.outputFiles.find(f=>f.path.endsWith('.css')).text+`\n@font-face{font-family:DeskSerif;src:url(data:font/ttf;base64,${font})}body{--font-instrument-serif:DeskSerif;font-family:Arial,sans-serif}`});
  await page.evaluate(({mode,A,B,USER,first,second})=>{
    window.mode=mode;window.account=USER;window.reads=[];window.releases={};window.fixtureData={[A]:first,[B]:second};
    window.fetch=async(url,options)=>{window.reads.push({kind:'session',method:options?.method||'GET'});if(url!=='/api/auth/session')throw Error('Unexpected network');return new Response(JSON.stringify({user:{id:window.account}}),{headers:{'content-type':'application/json'}});};
    window.bookwormApi={getBookOverview:async bookId=>{window.reads.push({kind:'overview',method:'GET',bookId});if(window.mode==='error')throw Error('private-payload');let result=structuredClone(window.fixtureData[bookId]);if(window.mode==='wrong')result.book.id=B;if(window.mode==='malformed')result.manuscript.wordCount=-1;if(window.mode==='account')window.account=B;
      if(window.mode==='hold')return new Promise(resolve=>{window.releases[bookId]=()=>resolve(result);});return result;}};
  },{mode,A,B,USER,first:data(A),second:data(B)});
  await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});
  await page.evaluate(A=>window.mountDesk(A),A);return page;
}
async function ready(page){await expect(page.getByRole('heading',{name:'The Harbor Notebook',exact:true})).toBeVisible();}
async function screenshot(page,name){await page.evaluate(()=>document.fonts.ready);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:resolve(artifacts,`${name}.png`),fullPage:true,animations:'disabled'});}
test('book desk shows saved facts and exact scoped links without commercial completion claims',async()=>{
  const page=await fixture();try{await ready(page);
    await expect(page.getByRole('definition').first()).toHaveText('1,235');
    await expect(page.getByRole('link',{name:'Prepare book details',exact:true})).toHaveAttribute('href',`/books/${A}/memory`);
    const tools=page.getByRole('navigation',{name:'Book tools'});await expect(tools.getByRole('link',{name:'Workspace artwork'})).toHaveAttribute('href',`/assets?ws=${SPACE}`);
    await expect(page.getByRole('region',{name:'Chapter ledger'}).getByRole('link',{name:/^01 The harbor at dawn v2/})).toHaveAttribute('href',`/books/${A}?chapter=${id(5)}`);
    await expect(page.getByText('1 package in saved history',{exact:true})).toBeVisible();
    await expect(page.getByRole('link',{name:/^Proofreading AI pipeline failed/})).toHaveAttribute('href',`/books/${A}?aiJob=${id(9)}`);
    await expect(page.getByText(/Stored job history does not verify current files/)).toBeVisible();
    assert((await page.evaluate(()=>window.reads)).every(r=>r.method==='GET'));
    assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
    await screenshot(page,'book-desk-desktop');
  }finally{await page.close();}
});
test('mobile book desk preserves content, readable links and keyboard focus at 320px',async()=>{
  const page=await fixture('normal',320);try{await ready(page);await screenshot(page,'book-desk-mobile-320');
    const button=page.getByRole('button',{name:'Refresh book desk',exact:true});await button.focus();await expect(button).toBeFocused();
    assert.notEqual(await button.evaluate(e=>getComputedStyle(e).outlineStyle),'none');
    await expect(page.getByRole('navigation',{name:'Book tools'})).toBeVisible();
    assert((await page.getByRole('link',{name:'Open manuscript',exact:true}).boundingBox()).height>=44);
  }finally{await page.close();}
});
test('transport, foreign-scope and malformed responses show no old or private book data',async()=>{
  for(const mode of ['error','wrong','malformed','account']){const page=await fixture(mode);try{
    await expect(page.getByRole('alert')).toContainText('Book progress could not be verified');await expect(page.getByRole('heading',{name:'The Harbor Notebook',exact:true})).toHaveCount(0);
    assert(!(await page.locator('body').innerText()).includes('private-payload'));
  }finally{await page.close();}}
});
test('retry reloads safely and refresh never retains a failed cached overview',async()=>{
  const page=await fixture('error');try{await expect(page.getByRole('alert')).toBeVisible();await page.evaluate(()=>{window.mode='normal';});await page.getByRole('button',{name:'Retry book desk'}).click();await ready(page);
    await page.evaluate(()=>{window.mode='error';});await page.getByRole('button',{name:'Refresh book desk'}).click();await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByRole('navigation',{name:'Book tools'})).toHaveCount(0);
  }finally{await page.close();}
});
test('late response from a previous book cannot replace the current desk',async()=>{
  const page=await fixture('hold');try{await page.waitForFunction(A=>Boolean(window.releases[A]),A);await page.evaluate(B=>window.mountDesk(B),B);await page.waitForFunction(B=>Boolean(window.releases[B]),B);
    await page.evaluate(B=>window.releases[B](),B);await expect(page.getByRole('heading',{name:'The Second Notebook',exact:true})).toBeVisible();await page.evaluate(A=>window.releases[A](),A);
    await expect(page.getByRole('heading',{name:'The Harbor Notebook',exact:true})).toHaveCount(0);
    await expect(page.getByRole('navigation',{name:'Book tools'}).getByRole('link',{name:'Open manuscript'})).toHaveAttribute('href',`/books/${B}`);
  }finally{await page.close();}
});
test('returning after an account switch clears the former account snapshot',async()=>{
  const page=await fixture();try{await ready(page);await page.evaluate(B=>{window.account=B;window.dispatchEvent(new Event('focus'));},B);await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByRole('navigation',{name:'Book tools'})).toHaveCount(0);
  }finally{await page.close();}
});
test('read-only and empty states offer honest next actions without pretending saved progress',async()=>{
  const page=await fixture();try{await ready(page);await page.evaluate(A=>{const d=window.fixtureData[A];d.workspace.role='viewer';d.chapters=[];d.manuscript={chapterCount:0,wordCount:0,chaptersWithoutSavedVersion:0};d.jobs=[];d.bibleItems=0;d.editions=[];d.editionsTotal=0;d.history={renders:0,packages:0};},A);
    await page.getByRole('button',{name:'Refresh book desk'}).click();await expect(page.getByRole('link',{name:'Read manuscript',exact:true})).toBeVisible();await expect(page.getByText('No chapters yet. Start in the editor or create a Story Blueprint.')).toBeVisible();await expect(page.getByText(/No import, AI, publishing, or audiobook export jobs/)).toBeVisible();
    await expect(page.getByText('Book status: draft · Read-only access',{exact:true})).toBeVisible();
  }finally{await page.close();}
});
test('long Unicode book and chapter titles remain contained without HTML execution',async()=>{
  const page=await fixture('normal',390);try{await ready(page);await page.evaluate(A=>{const d=window.fixtureData[A];d.book.title='港の物語 — حكايات الميناء '+ 'x'.repeat(250);d.chapters[0].title='<img src=x onerror=alert(1)> '+ 'É'.repeat(200);},A);await page.getByRole('button',{name:'Refresh book desk'}).click();await expect(page.getByRole('heading',{level:1})).toContainText('港の物語');assert.equal(await page.locator('main img').count(),0);await screenshot(page,'book-desk-unicode-mobile');
  }finally{await page.close();}
});
test('next action follows actual saved manuscript, listing and edition facts',async()=>{
  const page=await fixture();try{await ready(page);
    await page.evaluate(A=>{const d=window.fixtureData[A];d.chapters=[];d.manuscript={chapterCount:0,wordCount:0,chaptersWithoutSavedVersion:0};},A);
    await page.getByRole('button',{name:'Refresh book desk'}).click();await expect(page.getByRole('link',{name:'Start your manuscript',exact:true})).toHaveAttribute('href',`/books/${A}`);
    await page.evaluate(A=>{const d=window.fixtureData[A];d.chapters=[{id:'00000005-1111-4111-8111-111111111111',title:'Saved chapter',orderIndex:0,versionNumber:1,wordCount:10,updatedAt:d.observedAt}];d.manuscript={chapterCount:1,wordCount:10,chaptersWithoutSavedVersion:0};d.listing.description=true;d.editions=[];d.editionsTotal=0;},A);
    await page.getByRole('button',{name:'Refresh book desk'}).click();await expect(page.getByRole('link',{name:'Create an edition',exact:true})).toHaveAttribute('href',`/books/${A}/publish`);
    await page.evaluate(A=>{const d=window.fixtureData[A];d.editionsTotal=1;d.editions=[{id:'00000007-1111-4111-8111-111111111111',kind:'ebook',status:'draft',updatedAt:d.observedAt,coverArtworkChosen:false}];},A);
    await page.getByRole('button',{name:'Refresh book desk'}).click();await expect(page.getByRole('link',{name:'Open publishing studio',exact:true})).toHaveAttribute('href',`/books/${A}/publish`);
  }finally{await page.close();}
});
console.log(`Book desk screenshots: ${artifacts}`);
