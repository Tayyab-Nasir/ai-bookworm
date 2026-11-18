// Synthetic browser fixture: BFF actor binding and account switch, no live requests.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { resolve } from 'node:path';

const bundle = await build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
  import Directory from './apps/web/components/CommunityDirectory';
  const root = createRoot(document.getElementById('root'));
  window.mountDirectory=()=>root.render(React.createElement(Directory)); window.unmountDirectory=()=>root.render(null);`,
  loader:'tsx', resolveDir:process.cwd() }, bundle:true, write:false, platform:'browser', format:'iife', jsx:'automatic',
  plugins:[{name:'community-fixture',setup(builder){
    builder.onResolve({filter:/^\.\/api$/},()=>({path:'api',namespace:'fixture'}));
    builder.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'fixture'}));
    builder.onLoad({filter:/^api$/,namespace:'fixture'},()=>({contents:'export const apiClient = actor => window.makeApi(actor);'}));
    builder.onLoad({filter:/^link$/,namespace:'fixture'},()=>({contents:'import React from "react"; export default function Link(p) { return React.createElement("a",p); }', resolveDir:process.cwd()}));
  }}] });
const browser = await chromium.launch({headless:true,channel:process.env.BROWSER_TEST_CHANNEL||'msedge'});
after(async()=>browser.close());
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const C='33333333-3333-4333-8333-333333333333';
async function fixture() {
  const page = await browser.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:'<!doctype html><div id="root"></div>'}));
  await page.goto('http://bookworm.test/');
  await page.evaluate(({A,B,C})=>{
    window.actor=A; window.A=A;window.B=B;window.C=C;window.calls=[];window.writes=[];window.gates={}; window.sessionMode='ok';
    window.defer=label=>new Promise((resolve,reject)=>{window.gates[label]={resolve,reject};});
    window.fetch=async url=>{
      if(String(url)!=='/api/auth/session') throw Error('Unexpected network');
      if(window.sessionMode==='held') await window.defer('session');
      if(window.sessionMode==='fail'||!window.actor) return new Response('{}',{status:401});
      return Response.json({user:{id:window.actor}});
    };
    window.apiCache = new Map(); window.makeApi=actor=>{const key=actor||'';if(window.apiCache.has(key))return window.apiCache.get(key);const api=({
      listCommunities:async()=>{window.calls.push({action:'list',expected:actor,actual:window.actor});
        if(actor && actor!==window.actor) throw Error('account changed');
        const current=window.actor; if(window.holdList) await window.defer('list');
        return {communities:[{id:C,name:'Public authors',visibility:'public',description:'public'},
          {id:current===A?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
           name:current===A?'A private circle':'B private circle',visibility:'private',description:'private'}]};},
      joinCommunity:async id=>{window.calls.push({action:'join',expected:actor,actual:window.actor,id});
        if(window.switchAtDispatch) window.actor=window.B;
        if(actor && actor!==window.actor) throw Error('account changed');
        if(window.failJoin===409) throw Error('synthetic 409');
        const existing=window.writes.some(row=>row.actor===window.actor&&row.id===id);
        if(!existing) window.writes.push({actor:window.actor,id});
        if(window.failJoin===500) throw Error('synthetic lost reply');
        if(window.holdJoin) await window.defer('join');
        return window.badReply ? {communityId:'wrong',role:'member'} : {communityId:id,role:'member',alreadyMember:existing};},
    }); window.apiCache.set(key,api); return api;};
  },{A,B,C});
  await page.addScriptTag({content:bundle.outputFiles[0].text}); await page.evaluate(()=>window.mountDirectory());
  return {page,errors};
}

test('silent account switch never joins with another account',async()=>{const {page,errors}=await fixture();try{
  await expect(page.getByRole('button',{name:'Join community'})).toBeEnabled();
  await page.evaluate(()=>{window.actor=window.B;});
  await page.getByRole('button',{name:'Join community'}).click();
  await expect.poll(()=>page.evaluate(()=>window.calls.filter(x=>x.action==='join').length)).toBe(0);
  await expect(page.getByText('A private circle')).toHaveCount(0);
  assert.deepEqual(errors,[]);
}finally{await page.close();}});

test('focus recheck clears private data and joined state for a new actor',async()=>{const {page,errors}=await fixture();try{
  await expect(page.getByText('A private circle')).toBeVisible();
  await page.getByRole('button',{name:'Join community'}).click();
  await expect(page.getByRole('button',{name:'Joined'})).toBeVisible();
  await page.evaluate(()=>{window.actor=window.B;window.sessionMode='held';window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>!!window.gates.session);
  await expect(page.getByText('A private circle')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Joined'})).toHaveCount(0);
  await page.evaluate(()=>{window.sessionMode='ok';window.gates.session.resolve();});
  await expect(page.getByText('B private circle')).toBeVisible();
  await expect(page.getByRole('button',{name:'Join community'})).toBeEnabled();
  assert.deepEqual(errors,[]);
}finally{await page.close();}});
test('late private directory response from A cannot appear in B',async()=>{const {page,errors}=await fixture();try{
  await expect(page.getByText('A private circle')).toBeVisible();
  await page.evaluate(()=>{window.holdList=true;window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>!!window.gates.list);
  await page.evaluate(()=>{window.actor=window.B;window.holdList=false;window.dispatchEvent(new Event('focus'));});
  await expect(page.getByText('B private circle')).toBeVisible();
  await page.evaluate(()=>window.gates.list.resolve());
  await page.waitForTimeout(150);
  await expect(page.getByText('A private circle')).toHaveCount(0);
  await expect(page.getByText('B private circle')).toBeVisible();assert.deepEqual(errors,[]);
}finally{await page.close();}});

test('actor binding rejects account change between preflight and join dispatch',async()=>{const {page,errors}=await fixture();try{
  await expect(page.getByText('A private circle')).toBeVisible();
  await page.evaluate(()=>{window.switchAtDispatch=true;});
  await page.getByRole('button',{name:'Join community'}).click();
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByText('A private circle')).toHaveCount(0);
  assert.deepEqual(await page.evaluate(()=>window.writes),[]);
  assert.equal(await page.evaluate(()=>window.calls.find(x=>x.action==='join').expected),A);
  assert.deepEqual(errors,[]);
}finally{await page.close();}});

test('late join response cannot mark a different account joined',async()=>{const {page,errors}=await fixture();try{
  await expect(page.getByText('A private circle')).toBeVisible();
  await page.evaluate(()=>{window.holdJoin=true;});
  await page.getByRole('button',{name:'Join community'}).click();
  await page.waitForFunction(()=>!!window.gates.join);
  await page.evaluate(()=>{window.actor=window.B;window.dispatchEvent(new Event('focus'));});
  await expect(page.getByText('B private circle')).toBeVisible();
  await expect(page.getByRole('button',{name:'Joining…'})).toBeDisabled();
  await page.evaluate(()=>window.gates.join.resolve());
  await expect(page.getByRole('button',{name:'Join community'})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Joined'})).toHaveCount(0);
  await expect(page.getByText(/You joined/)).toHaveCount(0);
  assert.deepEqual(await page.evaluate(()=>window.writes.map(x=>x.actor)),[A]);assert.deepEqual(errors,[]);
}finally{await page.close();}});

test('an uncertain join is explained to the original actor after revalidation',async()=>{const {page,errors}=await fixture();try{
  await expect(page.getByText('A private circle')).toBeVisible();
  await page.evaluate(()=>{window.holdJoin=true;});
  await page.getByRole('button',{name:'Join community'}).click();await page.waitForFunction(()=>!!window.gates.join);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('A private circle')).toBeVisible();
  await page.evaluate(()=>window.gates.join.resolve());
  await expect(page.getByText(/A previous join may have completed/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Join community'})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Joined'})).toHaveCount(0);assert.deepEqual(errors,[]);
}finally{await page.close();}});

test('failed account verification clears private data until explicit retry',async()=>{const {page,errors}=await fixture();try{
  await expect(page.getByText('A private circle')).toBeVisible();
  await page.evaluate(()=>{window.sessionMode='fail';window.dispatchEvent(new Event('focus'));});
  await expect(page.getByRole('alert')).toContainText('session could not be verified');
  await expect(page.getByText('A private circle')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Join community'})).toHaveCount(0);
  await page.evaluate(()=>{window.sessionMode='ok';});
  await page.getByRole('button',{name:'Refresh communities'}).click();
  await expect(page.getByText('A private circle')).toBeVisible();assert.deepEqual(errors,[]);
}finally{await page.close();}});

test('double join dispatches once while outcome is pending',async()=>{const {page,errors}=await fixture();try{
  await expect(page.getByText('A private circle')).toBeVisible();await page.evaluate(()=>{window.holdJoin=true;});
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='Join community');b.click();b.click();});
  await page.waitForFunction(()=>!!window.gates.join);
  assert.equal(await page.evaluate(()=>window.writes.length),1);
  await page.evaluate(()=>window.gates.join.resolve());await expect(page.getByRole('button',{name:'Joined'})).toBeVisible();
  assert.deepEqual(errors,[]);
}finally{await page.close();}});
test('wrong join receipt is not displayed as membership',async()=>{const {page,errors}=await fixture();try{
  await expect(page.getByText('A private circle')).toBeVisible();await page.evaluate(()=>{window.badReply=true;});
  await page.getByRole('button',{name:'Join community'}).click();
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByRole('button',{name:'Joined'})).toHaveCount(0);
  assert.deepEqual(errors,[]);
}finally{await page.close();}});

test('unmounted directory ignores a late private response',async()=>{const {page,errors}=await fixture();try{
  await expect(page.getByText('A private circle')).toBeVisible();
  await page.evaluate(()=>{window.holdList=true;window.dispatchEvent(new Event('focus'));});await page.waitForFunction(()=>!!window.gates.list);
  await page.evaluate(()=>{window.unmountDirectory();window.gates.list.resolve();});
  await page.waitForTimeout(150);await expect(page.getByText('A private circle')).toHaveCount(0);assert.deepEqual(errors,[]);
}finally{await page.close();}});

test('same-actor recheck hides joined until verification then preserves it',async()=>{const {page,errors}=await fixture();try{
  await expect(page.getByText('A private circle')).toBeVisible();await page.getByRole('button',{name:'Join community'}).click();
  await expect(page.getByRole('button',{name:'Joined'})).toBeVisible();
  await page.evaluate(()=>{window.sessionMode='held';window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>!!window.gates.session);
  await expect(page.getByText('A private circle')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Joined'})).toHaveCount(0);
  await page.evaluate(()=>{window.sessionMode='ok';window.gates.session.resolve();});
  await expect(page.getByText('A private circle')).toBeVisible();
  await expect(page.getByRole('button',{name:'Joined'})).toBeVisible();assert.deepEqual(errors,[]);
}finally{await page.close();}});
for(const status of [409,500]) test(`join ${status} stays unconfirmed and retry checks original account`,async()=>{const {page,errors}=await fixture();try{
  await expect(page.getByText('A private circle')).toBeVisible();await page.evaluate(status=>{window.failJoin=status;},status);
  await page.getByRole('button',{name:'Join community'}).click();
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByRole('button',{name:'Joined'})).toHaveCount(0);
  assert.equal(await page.evaluate(()=>window.writes.length),status===500?1:0);
  await page.evaluate(()=>{window.failJoin=null;});await page.getByRole('button',{name:'Refresh communities'}).click();
  await expect(page.getByText(/A previous join may have completed/)).toBeVisible();
  await page.getByRole('button',{name:'Join community'}).click();
  await expect(page.getByRole('button',{name:'Joined'})).toBeVisible();
  assert.equal(await page.evaluate(()=>window.writes.length),1);
  if(status===500) await expect(page.getByText(/already belong/)).toBeVisible();
  assert.deepEqual(errors,[]);
}finally{await page.close();}});