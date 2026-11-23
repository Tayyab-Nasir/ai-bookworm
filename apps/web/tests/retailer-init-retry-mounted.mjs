// Mounted account/recovery initialization checks. All service responses are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const actor = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const book = "33333333-3333-4333-8333-333333333333";
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
  import React from 'react'; import {createRoot} from 'react-dom/client';
  import {flushSync} from 'react-dom';
  import Request from './apps/web/components/RetailerPackageRequest';
  const root=createRoot(document.getElementById('root'));
  window.mount=(bookId, request=null)=>root.render(bookId ? <Request bookId={bookId} request={request} canEdit={true} disabled={false} onBusy={()=>{}} onJob={()=>{}}/> : null);
  window.changeProof=(request)=>flushSync(()=>window.mount(request.bookId, request));
` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", plugins: [{name:"fake-api",setup(b){b.onResolve({filter:/^\.\/api$/},()=>({path:"api",namespace:"fake"}));b.onLoad({filter:/.*/,namespace:"fake"},()=>({contents:"export const apiClient=()=>new Proxy({}, {get:()=>()=>{window.writes++; throw Error('Unexpected API call')}})"}));}}] });
const server = createServer((req,res) => { res.writeHead(200,{"content-type":"text/html"}); res.end('<div id="root"></div>'); });
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const browser = await chromium.launch({headless:true,channel:process.env.BROWSER_TEST_CHANNEL || "chrome"});
async function fixture() {
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(({actor}) => { window.writes=0; window.actor=actor; window.fail=1; window.fetch=async()=>{if(window.fail-- > 0) throw Error('Session unavailable'); return {ok:true,json:async()=>({user:{id:window.actor}})};}; },{actor});
  await page.addScriptTag({content:bundle.outputFiles[0].text}); return page;
}
test.after(async()=>{await browser.close(); await new Promise(resolve=>server.close(resolve));});

test("session failure can be retried without a package request", async()=>{
  const page=await fixture(); try {
    await page.evaluate(book=>window.mount(book),book);
    await expect(page.getByRole('alert')).toContainText('Session unavailable');
    await page.getByRole('button',{name:'Retry loading saved export requests'}).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Retry loading saved export requests'})).toHaveCount(0);
    assert.equal(await page.evaluate(()=>window.writes),0);
  } finally {await page.close();}
});

test("storage failure remains closed until a successful retry", async()=>{
  const page=await fixture(); try {
    await page.evaluate(book=>{window.fail=0; const original=Storage.prototype.getItem; window.restore=()=>Storage.prototype.getItem=original; Storage.prototype.getItem=function(){throw Error('Storage unavailable')}; window.mount(book)},book);
    await expect(page.getByRole('alert')).toContainText('Storage unavailable');
    await expect(page.getByRole('button',{name:'Create retailer package'})).toBeDisabled();
    await page.evaluate(()=>window.restore()); await page.getByRole('button',{name:'Retry loading saved export requests'}).click();
    await expect(page.getByRole('alert')).toHaveCount(0); assert.equal(await page.evaluate(()=>window.writes),0);
  } finally {await page.close();}
});

test("account change during retry is rejected and no write is sent", async()=>{
  const page=await fixture(); try {
    await page.evaluate(book=>window.mount(book),book); await expect(page.getByRole('alert')).toBeVisible();
    await page.evaluate(({actor,other})=>{let calls=0; window.fetch=async()=>({ok:true,json:async()=>({user:{id:++calls===1?actor:other}})});},{actor,other});
    await page.getByRole('button',{name:'Retry loading saved export requests'}).click();
    await expect(page.getByRole('alert')).toContainText('account changed');
    await expect(page.getByRole('button',{name:'Create retailer package'})).toBeDisabled(); assert.equal(await page.evaluate(()=>window.writes),0);
  } finally {await page.close();}
});

test("retry restores only the verified account's original saved request", async()=>{
  const page=await fixture(); try {
    await page.evaluate(({actor,other,book})=>{
      const pointer=userId=>({schema:1,userId,request:{bookId:book,editionId:other,channel:'kdp',renderJobId:other,preflightJobId:other,idempotencyKey:other}});
      for(const userId of [actor,other]) sessionStorage.setItem(`bookworm:package:v1:${userId}:${book}`,JSON.stringify(pointer(userId)));
      window.mount(book);
    },{actor,other,book});
    await expect(page.getByRole('alert')).toBeVisible();
    const before=await page.evaluate(()=>JSON.stringify({...sessionStorage}));
    await page.getByRole('button',{name:'Retry loading saved export requests'}).click();
    await expect(page.getByRole('button',{name:'Recover saved export'})).toBeEnabled();
    assert.equal(await page.evaluate(()=>JSON.stringify({...sessionStorage})),before); assert.equal(await page.evaluate(()=>window.writes),0);
  } finally {await page.close();}
});

test("late retry results cannot replace the newly selected book", async()=>{
  const page=await fixture(); try {
    await page.evaluate(book=>window.mount(book),book); await expect(page.getByRole('alert')).toBeVisible();
    await page.evaluate(()=>{let first=true;window.fetch=()=>{if(first){first=false;return new Promise(resolve=>window.finishOld=()=>resolve({ok:true,json:async()=>({user:{id:window.actor}})}))}return Promise.resolve({ok:true,json:async()=>({user:{id:window.actor}})})}});
    await page.getByRole('button',{name:'Retry loading saved export requests'}).click();
    await expect.poll(()=>page.evaluate(()=>typeof window.finishOld)).toBe('function');
    await page.evaluate(other=>window.mount(other),other);
    await expect(page.getByRole('button',{name:'Retry loading saved export requests'})).toHaveCount(0);
    await page.evaluate(()=>window.finishOld()); await expect(page.getByRole('alert')).toHaveCount(0);
    assert.equal(await page.evaluate(()=>window.writes),0);
  } finally {await page.close();}
});

test("changing proof during account verification does not create an export for either proof", async () => {
  const page = await fixture();
  try {
    const request = { bookId: book, editionId: other, channel: "kdp", renderJobId: other, preflightJobId: other };
    await page.evaluate(request => {
      window.fail = 0;
      window.mount(request.bookId, request);
    }, request);
    const create = page.getByRole("button", { name: "Create retailer package" });
    await expect(create).toBeEnabled();
    await page.evaluate(() => {
      window.fetch = () => new Promise(resolve => {
        window.finishCheck = () => resolve({ ok: true, json: async () => ({ user: { id: window.actor } }) });
      });
    });
    await create.click();
    await expect.poll(() => page.evaluate(() => typeof window.finishCheck)).toBe("function");
    await page.evaluate(request => {
      window.changeProof(request);
      window.finishCheck();
    }, { ...request, renderJobId: actor });
    await expect(page.getByRole("alert")).toContainText("selected proof or preflight changed");
    await expect(create).toBeEnabled();
    assert.deepEqual(await page.evaluate(() => ({ writes: window.writes, storageKeys: sessionStorage.length })), { writes: 0, storageKeys: 0 });
  } finally {
    await page.close();
  }
});
