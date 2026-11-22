// Mounted QC history recovery with synthetic audio and account-scoped transports.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
  import React from 'react'; import {createRoot} from 'react-dom/client';
  import Audio from './apps/web/components/ChapterAudioDownload';
  const root=createRoot(document.getElementById('root')); const scope={actor:'actor',current:()=>window.actor==='actor',begin:()=>()=>window.actor==='actor',checked:async work=>{if(window.actor!=='actor')throw Error('account');const result=await work();if(window.actor!=='actor')throw Error('account');return result}};
  root.render(<Audio scope={scope} projectId="project" ready={true}/>);
` }, bundle:true, write:false, platform:"browser", format:"iife", jsx:"automatic", plugins:[{name:"mock-api",setup(b){b.onResolve({filter:/^\.\/api$/},()=>({path:"api",namespace:"mock"}));b.onLoad({filter:/.*/,namespace:"mock"},()=>({contents:"export const apiClient=()=>window.bookwormApi"}));}}] });
const server=createServer((_req,res)=>{res.writeHead(200,{"content-type":"text/html"});res.end('<div id="root"></div>')});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_TEST_CHANNEL||'chrome'});
test.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
async function fixture(deferred=false) {
  const page=await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(deferred=>{
    window.actor='actor';window.historyCalls=0;window.assemblies=0;window.signoffs=0;window.failHistory=true;window.returnReport=false;window.waiters=[];
    window.report={id:'report',createdAt:'2026-10-13T12:00:00Z',qualityReport:{rmsDbfs:-20},isCurrentSource:true,signoffs:[],signedByMe:false};
    window.bookwormApi={listAudiobookQcReports:async (_project,actor)=>{window.historyCalls++;if(actor!=='actor')throw Error('wrong actor');if(deferred)return new Promise((resolve,reject)=>window.waiters.push({resolve,reject}));if(window.failHistory)throw Error('unavailable');return {reports:window.returnReport?[window.report]:[]}},createAudiobookQcSignoff:async()=>{window.signoffs++;return {reportId:'report',listenedToExactAudio:true}}};
    window.fetch=async()=>{window.assemblies++;const quality={profile:'test',chapterDurationSeconds:1,sampleRateHz:44100,channels:1,bitRateKbps:192,bitRateMode:'cbr',rmsDbfs:-20,samplePeakDbfs:-5,technicalChecks:{},reviewRequired:true,acxNarrationPolicy:'explicit_authorization_required_for_ai_voice'};return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'audio/mpeg','x-bookworm-audio-qc':JSON.stringify(quality),'x-bookworm-audio-qc-report-id':'report'}})};
  },deferred);
  await page.addScriptTag({content:bundle.outputFiles[0].text});return page;
}

test('initial history failure has a read-only retry',async()=>{
  const page=await fixture();try{
    await expect(page.getByText(/Saved QC history is not available/)).toBeVisible();
    await expect(page.getByText(/No saved quality reports yet/)).toHaveCount(0);
    await page.evaluate(()=>{window.failHistory=false;window.returnReport=true});
    await page.getByRole('button',{name:'Retry history'}).click();
    await expect(page.getByText(/current manuscript version/)).toBeVisible();
    assert.deepEqual(await page.evaluate(()=>[window.historyCalls,window.assemblies,window.signoffs]),[2,0,0]);
  }finally{await page.close()}
});

for (const oldOutcome of ['empty','error']) test(`older ${oldOutcome} history response cannot replace a newer report`,async()=>{
  const page=await fixture(true);try{
    await expect.poll(()=>page.evaluate(()=>window.waiters.length)).toBe(1);
    await page.getByRole('button',{name:'Download chapter + QC report'}).click();
    await expect.poll(()=>page.evaluate(()=>window.waiters.length)).toBe(2);
    await page.evaluate(()=>window.waiters[1].resolve({reports:[window.report]}));
    await expect(page.getByRole('checkbox',{name:/I listened through this exact/})).toBeVisible();
    await page.evaluate(outcome=>outcome==='empty'?window.waiters[0].resolve({reports:[]}):window.waiters[0].reject(Error('old failure')),oldOutcome);
    await expect(page.getByRole('checkbox',{name:/I listened through this exact/})).toBeVisible();
    await expect(page.getByText(/Saved QC history is not available/)).toHaveCount(0);
  }finally{await page.close()}
});

test('an older completion cannot clear the latest history loading state',async()=>{
  const page=await fixture(true);try{
    await expect.poll(()=>page.evaluate(()=>window.waiters.length)).toBe(1);
    await page.getByRole('button',{name:'Download chapter + QC report'}).click();
    await expect.poll(()=>page.evaluate(()=>window.waiters.length)).toBe(2);
    await page.evaluate(()=>window.waiters[0].resolve({reports:[]}));
    await expect(page.getByRole('button',{name:'Refreshing…'})).toBeDisabled();
    await page.evaluate(()=>window.waiters[1].reject(Error('latest failure')));
    await expect(page.getByRole('button',{name:'Retry history'})).toBeEnabled();
  }finally{await page.close()}
});

test('a late older success cannot conceal the newest history failure',async()=>{
  const page=await fixture(true);try{
    await expect.poll(()=>page.evaluate(()=>window.waiters.length)).toBe(1);
    await page.getByRole('button',{name:'Download chapter + QC report'}).click();
    await expect.poll(()=>page.evaluate(()=>window.waiters.length)).toBe(2);
    await page.evaluate(()=>window.waiters[1].reject(Error('latest failure')));
    await expect(page.getByRole('button',{name:'Retry history'})).toBeEnabled();
    await page.evaluate(async()=>{window.waiters[0].resolve({reports:[window.report]});await new Promise(resolve=>setTimeout(resolve,30));});
    await expect(page.getByRole('button',{name:'Retry history'})).toBeEnabled();
    await expect(page.getByRole('checkbox',{name:/I listened through this exact/})).toHaveCount(0);
  }finally{await page.close()}
});

test('failed history after assembly retries without assembling again and restores sign-off',async()=>{
  const page=await fixture();try{
    await expect(page.getByRole('button',{name:'Retry history'})).toBeVisible();
    await page.evaluate(()=>{window.failHistory=false});
    await page.getByRole('button',{name:'Retry history'}).click();
    await expect(page.getByRole('button',{name:'Retry history'})).toHaveCount(0);
    await page.evaluate(()=>{window.failHistory=true});
    await page.getByRole('button',{name:'Download chapter + QC report'}).click();
    await expect(page.getByRole('region',{name:'Audiobook audio quality report'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Retry history'})).toBeVisible();
    await page.evaluate(()=>{window.failHistory=false;window.returnReport=true});
    await page.getByRole('button',{name:'Retry history'}).click();
    await expect(page.getByRole('checkbox',{name:/I listened through this exact/})).toBeVisible();
    assert.deepEqual(await page.evaluate(()=>[window.assemblies,window.signoffs]),[1,0]);
  }finally{await page.close()}
});

test('retry cannot read history after the account changes',async()=>{
  const page=await fixture();try{
    await expect(page.getByRole('button',{name:'Retry history'})).toBeVisible();
    await page.evaluate(()=>{window.actor='other';window.failHistory=false});
    await page.getByRole('button',{name:'Retry history'}).click();
    assert.equal(await page.evaluate(()=>window.historyCalls),1);
    assert.equal(await page.evaluate(()=>window.assemblies),0);
  }finally{await page.close()}
});
