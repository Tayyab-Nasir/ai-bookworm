// Real component + typed fetch client in an isolated browser. Synthetic keys,
// deterministic transport only; never real credentials, providers or storage.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const secret='synthetic-key-only-ALFA';
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Connections from './apps/web/components/AiConnections';const root=createRoot(document.getElementById('root'));window.mount=()=>root.render(React.createElement(React.StrictMode,null,React.createElement(Connections)));window.unmount=()=>root.render(null);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/\/AuthorShell$/},args=>args.importer.startsWith(resolve('apps/web'))?{path:'shell',namespace:'fixture'}:undefined);
 b.onLoad({filter:/^shell$/,namespace:'fixture'},()=>({contents:"import React from 'react';export function AuthorPage({children}){return React.createElement('div',null,children)};export function AuthorHeader(){return null}",resolveDir:process.cwd()}));
 b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'fixture'}));b.onLoad({filter:/^link$/,namespace:'fixture'},()=>({contents:"import React from 'react';export default function Link(p){return React.createElement('a',p)}",resolveDir:process.cwd()}));
}}]});
const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_TEST_CHANNEL||'msedge'});
test.after(()=>browser.close());
async function fixture({enabled=true, saved=false}={}){
 const page=await browser.newPage();page.setDefaultTimeout(5000);
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1/fixture');
 await page.evaluate(({A,B,enabled,saved})=>{
  window.actor=A;window.ids={A,B};window.mode='normal';window.calls=[];window.rows={};window.operations={};window.gates={};
  if(saved)window.rows[A]={id:crypto.randomUUID(),provider:'openai',status:'saved',revision:1,keySuffix:'OLDK',lastOperationId:crypto.randomUUID(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  window.fetch=async(url,init={})=>{
   if(url==='/api/auth/session')return Response.json({user:{id:window.actor,email:'synthetic@example.test'}});
   const headers=new Headers(init.headers),actor=headers.get('x-bookworm-actor'),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;
   window.calls.push({url,method,actor,body});
   if(actor!==window.actor)return Response.json({error:{message:'Account changed',code:'conflict',requestId:'fixture'}},{status:409});
   if(method==='GET')return Response.json({viewerId:actor,canSave:enabled,generationAvailable:false,connections:window.rows[actor]?[window.rows[actor]]:[]});
   const provider=url.split('/')[6],opKey=actor+':'+body.operationId;
   if(method==='POST'){
    if(url.endsWith('/close')&&!window.operations[opKey])window.operations[opKey]={...body,provider,status:'closed',revision:null};
    return Response.json({viewerId:actor,receipt:window.operations[opKey]??{...body,provider,status:'not_found',revision:null}});
   }
   if(window.mode==='lost-before')throw new TypeError('Synthetic unavailable transport');
   if(window.mode==='deferred')await new Promise(resolve=>{window.gates.write=resolve});
   if(window.operations[opKey]?.status==='closed')return Response.json({error:{message:'closed',code:'conflict',requestId:'fixture'}},{status:409});
   const row={id:body.connectionId,provider,revision:(body.expectedRevision??0)+1,status:method==='PUT'?'saved':'revoked',keySuffix:method==='PUT'?body.apiKey.slice(-4):null,lastOperationId:body.operationId,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
   window.rows[actor]=row;window.operations[opKey]={connectionId:body.connectionId,operationId:body.operationId,expectedRevision:body.expectedRevision,provider,action:method==='PUT'?'save':'revoke',status:row.status,revision:row.revision};
   if(window.mode==='lost-after')throw new TypeError('Synthetic reply lost');
   return Response.json({viewerId:actor,connection:row});
  };
 },{A,B,enabled,saved});
 await page.addScriptTag({content:bundle.outputFiles[0].text});await page.evaluate(()=>window.mount());
 await expect(page.getByRole('button',{name:'Reload saved status',exact:true})).toBeEnabled();return page;
}
const provider=page=>page.getByRole('region',{name:'OpenAI connection',exact:true});
async function enter(page){await provider(page).getByRole('button',{name:/Add key|Replace key/}).click();await page.getByLabel('OpenAI API key',{exact:true}).fill(secret);}
test('save clears plaintext, binds identity, confirms by read and survives remount without key persistence',async()=>{
 const p=await fixture();try{await enter(p);await p.getByRole('button',{name:'Save key',exact:true}).click();
  await expect(provider(p).getByText('Saved · ending ALFA · not verified',{exact:true})).toBeVisible();
  assert.equal(await p.locator('input[type=password]').count(),0);
  assert.equal(await p.evaluate(()=>window.calls.filter(c=>c.method==='PUT').length),1);
  assert.equal(await p.evaluate(secret=>JSON.stringify({...localStorage,...sessionStorage}).includes(secret),secret),false);
  assert.equal(await p.evaluate(()=>window.calls.find(c=>c.method==='PUT').actor),A);
  await p.evaluate(()=>window.unmount());await p.evaluate(()=>window.mount());await expect(provider(p).getByText(/ending ALFA/)).toBeVisible();
 }finally{await p.close()}
});
test('lost reply recovers completed write without another key submission',async()=>{
 const p=await fixture();try{await p.evaluate(()=>window.mode='lost-after');await enter(p);await p.getByRole('button',{name:'Save key',exact:true}).click();await expect(provider(p).getByText(/ending ALFA/)).toBeVisible();
  await expect(p.getByRole('region',{name:'Unconfirmed connection change'})).toHaveCount(0);assert.equal(await p.evaluate(()=>window.calls.filter(c=>c.method==='PUT').length),1);
 }finally{await p.close()}
});
test('unconfirmed save survives remount, blocks replacement and can be durably closed without key resubmission',async()=>{
 const p=await fixture();try{await p.evaluate(()=>window.mode='lost-before');await enter(p);await p.getByRole('button',{name:'Save key',exact:true}).click();await expect(p.getByRole('region',{name:'Unconfirmed connection change'})).toBeVisible();
  await expect(provider(p).getByRole('button',{name:'Add key'})).toBeDisabled();
  await p.evaluate(()=>window.unmount());await p.evaluate(()=>window.mount());await expect(p.getByRole('region',{name:'Unconfirmed connection change'})).toBeVisible();
  assert.equal(await p.evaluate(secret=>JSON.stringify({...sessionStorage}).includes(secret),secret),false);
  await p.getByRole('button',{name:'Close unresolved change'}).click();await expect(provider(p).getByRole('button',{name:'Add key'})).toBeEnabled();
  assert.equal(await p.evaluate(()=>window.calls.filter(c=>c.method==='PUT').length),1);
 }finally{await p.close()}
});
test('focus account change clears a pasted key and previous masked metadata',async()=>{
 const p=await fixture({saved:true});try{await enter(p);await p.evaluate(()=>{window.actor=window.ids.B;window.dispatchEvent(new Event('focus'))});await expect(provider(p).getByText('No key saved',{exact:true})).toBeVisible();
  await expect(p.locator('input[type=password]')).toHaveCount(0);await expect(provider(p).getByText(/OLDK/)).toHaveCount(0);assert.equal(await p.evaluate(()=>window.calls.filter(c=>c.method==='PUT').length),0);
 }finally{await p.close()}
});
test('a completed old-account save cannot display its key or confirmation in the new account',async()=>{
 const p=await fixture();try{await p.evaluate(()=>window.mode='deferred');await enter(p);await p.getByRole('button',{name:'Save key',exact:true}).click();await p.waitForFunction(()=>!!window.gates.write);
  await p.evaluate(()=>{window.actor=window.ids.B;window.dispatchEvent(new Event('focus'))});await expect(provider(p).getByText('No key saved',{exact:true})).toBeVisible();await p.evaluate(()=>window.gates.write());
  await expect(provider(p).getByRole('button',{name:'Add key'})).toBeEnabled();await expect(provider(p).getByText(/ALFA/)).toHaveCount(0);assert.equal(await p.evaluate(()=>window.rows[window.ids.B]??null),null);
 }finally{await p.close()}
});
test('encryption unavailable disables saves but existing saved keys can be removed',async()=>{
 const p=await fixture({enabled:false,saved:true});try{await expect(provider(p).getByRole('button',{name:'Replace key'})).toBeDisabled();await provider(p).getByRole('button',{name:'Remove key',exact:true}).click();await p.getByRole('button',{name:'Confirm removal'}).click();await expect(provider(p).getByText('Removed from Bookworm')).toBeVisible();
  assert.equal(await p.evaluate(()=>window.calls.filter(c=>c.method==='DELETE').length),1);assert.equal(await p.evaluate(()=>window.calls.filter(c=>c.method==='PUT').length),0);
 }finally{await p.close()}
});
