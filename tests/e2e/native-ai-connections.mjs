/** Native auth, HTTP/BFF, encryption writer and PostgreSQL. Synthetic keys only. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect as playwrightExpect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { requireNativeAuthorRunner, localOrigin } from './native-author-files-guard.mjs';
const expect=playwrightExpect.configure({timeout:30_000});

export async function runNativeAiConnections({page,setup,service,webOrigin,apiOrigin,userId,screenshot}) {
 requireNativeAuthorRunner();localOrigin(apiOrigin);localOrigin(webOrigin);
 assert.equal(process.env.NODE_ENV,'production');
 assert(!process.env.AI_CONNECTION_VAULT_KEYRING_JSON,'Native test must not inherit a credential encryption key');
 const synthetic=randomBytes(36).toString('hex');
 process.env.AI_CONNECTION_VAULT_KEYRING_JSON=JSON.stringify({active:'disposable-test',keys:{'disposable-test':randomBytes(32).toString('base64')}});
 const provider=()=>page.getByRole('region',{name:'OpenAI connection',exact:true});
 try {
  await page.goto(`${webOrigin}/settings/ai`);
  await expect(page.getByRole('heading',{name:'AI connections',exact:true})).toBeVisible();
  await expect(provider().getByRole('button',{name:'Add key'})).toBeEnabled();
  await provider().getByRole('button',{name:'Add key'}).click();await page.getByLabel('OpenAI API key',{exact:true}).fill(synthetic);
  await page.getByRole('button',{name:'Save key',exact:true}).click();
  await expect(provider().getByText(`Saved · ending ${synthetic.slice(-4)} · not verified`,{exact:true})).toBeVisible();
  assert.equal(await page.locator('input[type=password]').count(),0);
  assert.equal(await page.evaluate(value=>JSON.stringify({...localStorage,...sessionStorage}).includes(value),synthetic),false);
  const read=async()=>page.evaluate(async actor=>{const response=await fetch('/api/backend/v1/account/ai-connections',{headers:{'x-bookworm-actor':actor}});return{status:response.status,cache:response.headers.get('cache-control'),body:await response.json()}},userId);
  const first=await read();assert.equal(first.status,200);assert.match(first.cache,/no-store/);assert.equal(first.body.generationAvailable,false);
  const connection=first.body.connections.find(row=>row.provider==='openai');assert.equal(connection.revision,1);assert(!JSON.stringify(first).includes(synthetic));
  const saved=await service.from('ai_connections').select('*').eq('id',connection.id).single();assert(!saved.error);assert.equal(saved.data.owner_id,userId);assert(!JSON.stringify(saved.data).includes(synthetic));
  // The private schema is not part of the Data API, even for this service client.
  const secretRead=await service.schema('bookworm_credentials').from('ai_connection_secrets').select('*');assert(secretRead.error);
  const foreign=createClient(setup.url,setup.anonKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const auth=await foreign.auth.signUp({email:`${randomUUID()}@bookworm.local.test`,password:`Bwk-${randomUUID()}!`});assert(!auth.error&&auth.data.session);
  const foreignRows=await foreign.from('ai_connections').select('*');assert(!foreignRows.error);assert.deepEqual(foreignRows.data,[]);
  const direct=await foreign.rpc('mutate_ai_connection',{p_owner_id:userId,p_provider:'openai',p_connection_id:connection.id,p_expected_revision:1,p_operation_id:randomUUID(),p_action:'revoke'});assert(direct.error);
  const foreignResponse=await fetch(`${apiOrigin}/v1/account/ai-connections/openai`,{method:'DELETE',headers:{authorization:`Bearer ${auth.data.session.access_token}`,'x-bookworm-actor':auth.data.user.id,'content-type':'application/json'},body:JSON.stringify({connectionId:connection.id,expectedRevision:1,operationId:randomUUID()})});
  assert.equal(foreignResponse.status,409);await foreignResponse.body.cancel();await foreign.auth.signOut();
  const concurrent=await page.evaluate(async({actor,id,key})=>{
   const responses=await Promise.all([1,2].map(()=>fetch('/api/backend/v1/account/ai-connections/openai',{method:'PUT',headers:{'content-type':'application/json','x-bookworm-actor':actor},body:JSON.stringify({connectionId:id,expectedRevision:1,operationId:crypto.randomUUID(),apiKey:key})})));
   for(const response of responses)await response.body.cancel();return responses.map(response=>response.status).sort();
  },{actor:userId,id:connection.id,key:randomBytes(36).toString('hex')});assert.deepEqual(concurrent,[200,409]);
  await page.getByRole('button',{name:'Reload saved status',exact:true}).click();await expect(provider().getByRole('button',{name:'Replace key'})).toBeEnabled();
  const second=await read();assert.equal(second.body.connections[0].revision,2);
  await page.setViewportSize({width:390,height:844});await screenshot('ai-connections-mobile');
  await page.setViewportSize({width:1280,height:900});await screenshot('ai-connections-desktop');
  await provider().getByRole('button',{name:'Remove key',exact:true}).click();await page.getByRole('button',{name:'Confirm removal'}).click();await expect(provider().getByText('Removed from Bookworm')).toBeVisible();
  const third=await read();assert.equal(third.body.connections[0].revision,3);assert.equal(third.body.connections[0].keySuffix,null);
  const closure=await page.evaluate(async({actor,id,key})=>{
   const intent={connectionId:id,expectedRevision:3,operationId:crypto.randomUUID(),action:'save'};
   const headers={'content-type':'application/json','x-bookworm-actor':actor};
   const response=await fetch('/api/backend/v1/account/ai-connections/openai/close',{method:'POST',headers,body:JSON.stringify(intent)}),receipt=await response.json();
   const {action,...body}=intent;
   const late=await fetch('/api/backend/v1/account/ai-connections/openai',{method:'PUT',headers,body:JSON.stringify({...body,apiKey:key})});await late.body.cancel();
   return{closed:response.status,receipt:receipt.receipt.status,late:late.status};
  },{actor:userId,id:connection.id,key:synthetic});assert.deepEqual(closure,{closed:200,receipt:'closed',late:409});
  console.log('PASS native AI connection save/reload, real concurrent replacement CAS, owner RLS, direct RPC refusal, revocation, closure-before-late-save and responsive UI; zero provider requests');
 } finally {delete process.env.AI_CONNECTION_VAULT_KEYRING_JSON;}
}
