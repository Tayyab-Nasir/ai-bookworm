/** Local synthetic PostgreSQL TLS transport test. Not hosted readiness proof.
 * Opt in with BOOKWORM_CATALOG_PG_BIN. The temporary server is stopped in finally.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { customerAiCatalogEvidenceVerifier } from '../../services/api/src/lib/customer-ai-catalog-evidence.ts';
import { collectCustomerAiCatalog } from '../../services/api/src/lib/customer-ai-catalog-collector.ts';
import { customerAiCatalogSnapshotSql as sql } from '../../services/api/src/lib/customer-ai-catalog-snapshot.ts';

const bin = process.env.BOOKWORM_CATALOG_PG_BIN;
const extension = process.platform === 'win32' ? '.exe' : '';
const command = name => join(resolve(bin), name + extension);
const cleanEnv = Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE'].filter(k => process.env[k]).map(k => [k,process.env[k]]));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function certificate() {
  const {privateKey, publicKey} = generateKeyPairSync('rsa',{modulusLength:2048});
  const der = (tag, bytes) => {
    const n=bytes.length; let length;
    if (n<128) length=Buffer.from([n]);
    else {let hex=n.toString(16); if (hex.length%2) hex='0'+hex; const b=Buffer.from(hex,'hex'); length=Buffer.concat([Buffer.from([0x80|b.length]),b]);}
    return Buffer.concat([Buffer.from([tag]),length,bytes]);
  };
  const seq=(...parts)=>der(0x30,Buffer.concat(parts));
  const algorithm=Buffer.from('300d06092a864886f70d01010b0500','hex');
  const name=seq(der(0x31,seq(Buffer.from('0603550403','hex'),der(0x0c,Buffer.from('localhost')))));
  const time=date=>der(0x17,Buffer.from(date.toISOString().replace(/\D/g,'').slice(2,14)+'Z'));
  const san=seq(der(0x82,Buffer.from('localhost')));
  const basic=seq(Buffer.from('0603551d13','hex'),der(1,Buffer.from([0xff])),der(4,seq(der(1,Buffer.from([0xff])))));
  const extensions=der(0xa3,seq(seq(Buffer.from('0603551d11','hex'),der(4,san)),basic));
  const tbs=seq(der(0xa0,der(2,Buffer.from([2]))),der(2,Buffer.from([1])),algorithm,name,
    seq(time(new Date(Date.now()-60_000)),time(new Date(Date.now()+86_400_000))),name,
    publicKey.export({type:'spki',format:'der'}),extensions);
  const cert=seq(tbs,algorithm,der(3,Buffer.concat([Buffer.from([0]),sign('sha256',tbs,privateKey)])));
  return {key:privateKey.export({type:'pkcs8',format:'pem'}),cert:`-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`};
}
function run(binary,args,env,input) {
  const r=spawnSync(binary,args,{input,env,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,windowsHide:true});
  if (r.error || r.status!==0) throw new Error(`${binary} failed: ${r.error?.message ?? r.stderr}`);
  return r.stdout.trim();
}
function control(args,log,allowNotRunning=false) {
  const fd=openSync(log,'a');
  try {const r=spawnSync(command('pg_ctl'),args,{env:cleanEnv,stdio:['ignore',fd,fd],timeout:30000,windowsHide:true});
    if(r.error || (r.status!==0 && !(allowNotRunning && r.status===3))) throw new Error(`Disposable postgres control failed: ${r.error?.message ?? r.status}`);
    return r.status;
  } finally {closeSync(fd);}
}
async function unusedPort() {
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  return port;
}

test('native PG16 direct TLS evidence transport rejects identity drift and fails closed', {skip:!bin,timeout:120000}, async t=>{
  for(const name of ['initdb','pg_ctl','psql']) assert(existsSync(command(name)),`PostgreSQL binary ${name} missing`);
  const base=mkdtempSync(join(tmpdir(),'bookworm-catalog-tls-'));
  const data=join(base,'data'), log=join(base,'postgres.log'), ctlLog=join(base,'control.log');
  const pwfile=join(base,'synthetic-password'), caPath=join(base,'ca.pem');
  const password=randomBytes(24).toString('base64url');
  writeFileSync(pwfile,password+'\n',{flag:'wx',mode:0o600});
  const port=await unusedPort(); let mayHaveStarted=false;
  try {
    run(command('initdb'),['-D',data,'-U','catalog_admin','--no-locale','--encoding=UTF8','--auth-host=scram-sha-256','--auth-local=scram-sha-256','--pwfile',pwfile],cleanEnv);
    unlinkSync(pwfile);
    const serverCert=certificate(), otherCert=certificate(), otherCa=join(base,'other-ca.pem');
    writeFileSync(join(data,'server.crt'),serverCert.cert,{mode:0o600});
    writeFileSync(join(data,'server.key'),serverCert.key,{mode:0o600});
    writeFileSync(caPath,serverCert.cert,{mode:0o600}); writeFileSync(otherCa,otherCert.cert,{mode:0o600});
    mayHaveStarted=true;
    control(['-D',data,'-l',log,'-o',`-h 127.0.0.1 -p ${port} -c ssl=on -c log_statement=all`,'-w','start'],ctlLog);
    const env={...cleanEnv,PGHOST:'localhost',PGPORT:String(port),PGUSER:'catalog_admin',PGPASSWORD:password,PGDATABASE:'postgres',PGCONNECT_TIMEOUT:'5',PGSSLMODE:'verify-full',PGSSLROOTCERT:caPath};
    const query=(s,e=env)=>run(command('psql'),['-X','-qAt','-w','-v','ON_ERROR_STOP=1'],e,s);
    assert.match(query('SHOW server_version_num;'),/^16\d{4}$/u);
    query(`CREATE ROLE catalog_reader LOGIN PASSWORD '${password}'; CREATE ROLE catalog_alternate LOGIN PASSWORD '${password}'; CREATE ROLE catalog_super LOGIN SUPERUSER PASSWORD '${password}'; CREATE ROLE fixture_group; GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO catalog_reader; CREATE SCHEMA evidence_fixture; CREATE TABLE evidence_fixture.items(id integer NOT NULL); CREATE FUNCTION evidence_fixture.allowed(integer) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT $1 > 0';`);
    const systemIdentifier=query('SELECT system_identifier::text FROM pg_catalog.pg_control_system();');
    assert.match(systemIdentifier,/^\d+$/u);
    const reader={...env,PGUSER:'catalog_reader'};
    const catalog=JSON.parse(query(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=pg_catalog; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO, YMD'; SET LOCAL quote_all_identifiers=off; ${sql} ROLLBACK;`,reader));
    const scope={auditorId:'fixture-auditor',keyId:'fixture-key',deploymentId:'fixture-deployment',projectRef:'fixture-project',schemaRevision:'fixture-schema'};
    const keys=generateKeyPairSync('ed25519');
    const binding={host:'localhost',port,database:'postgres',user:'catalog_reader',projectRef:scope.projectRef,systemIdentifier};
    const config={scope,binding,endpoint:{host:'localhost',port,database:'postgres',user:'catalog_reader',password,caPath,caSha256:sha256(caPath)},psqlPath:command('psql'),psqlSha256:sha256(command('psql')),signingKey:keys.privateKey,timeoutMs:4000};
    const verifier=customerAiCatalogEvidenceVerifier({expected:scope,expectedCatalog:catalog,verificationKey:keys.publicKey,maxAgeMs:10000});
    const collect=(cfg=config,signal)=>collectCustomerAiCatalog(cfg,verifier.challenge(),signal);
    try {
      await t.test('trusted local endpoint produces a signed matching observation',async()=>{
        const challenge=verifier.challenge(); const result=await collectCustomerAiCatalog(config,challenge);
        assert.equal(verifier.verify(challenge,result).kind,'matched_catalog_observation');
      });
      await t.test('untrusted CA and mismatching DNS certificate fail',async()=>{
        await assert.rejects(collect({...config,endpoint:{...config.endpoint,caPath:otherCa,caSha256:sha256(otherCa)}}));
        await assert.rejects(collect({...config,binding:{...binding,host:'127.0.0.1'},endpoint:{...config.endpoint,host:'127.0.0.1'}}));
      });
      await t.test('incorrect cluster, database, login and project fail',async()=>{
        await assert.rejects(collect({...config,binding:{...binding,systemIdentifier:'1'}}));
        await assert.rejects(collect({...config,endpoint:{...config.endpoint,database:'template1'}}));
        await assert.rejects(collect({...config,endpoint:{...config.endpoint,user:'catalog_alternate'}}));
        await assert.rejects(collect({...config,scope:{...scope,projectRef:'wrong-project'}}));
      });
      await t.test('a privileged or member login cannot sign an observation',async()=>{
        await assert.rejects(collect({...config,binding:{...binding,user:'catalog_super'},endpoint:{...config.endpoint,user:'catalog_super'}}));
        query('GRANT fixture_group TO catalog_reader;');
        try {await assert.rejects(collect());} finally {query('REVOKE fixture_group FROM catalog_reader;');}
      });
      await t.test('missing credentials, bad pin and pre-cancel fail',async()=>{
        await assert.rejects(collect({...config,endpoint:{...config.endpoint,password:''}}));
        await assert.rejects(collect({...config,endpoint:{...config.endpoint,caSha256:'0'.repeat(64)}}));
        await assert.rejects(collect({...config,psqlSha256:'0'.repeat(64)}));
        const controller=new AbortController(); controller.abort(); await assert.rejects(collect(config,controller.signal));
      });
      await t.test('server enforced read-only transaction',async()=>{
        const result=spawnSync(command('psql'),['-X','-qAt','-w','-v','ON_ERROR_STOP=1'],{input:'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; CREATE TABLE evidence_fixture.impossible (x integer);',env:reader,encoding:'utf8',timeout:10000,windowsHide:true});
        assert.notEqual(result.status,0); assert.match(result.stderr,/read-only transaction/i);
        assert.match(readFileSync(log,'utf8'),/BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/i,'collector transaction was observed by the synthetic server');
      });
      await t.test('elapsed deadline rejects even when synchronous parsing blocks timer dispatch',async()=>{
        const count=()=>[...readFileSync(log,'utf8').matchAll(/BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/gi)].length;
        const before=count(), originalParse=JSON.parse;
        let blocked=0, tlsConfirmed=false, timerFired=false, timerWasDeferred=false, timer;
        JSON.parse=function(value,...args){
          if(typeof value==='string' && value.includes('"identity"') && value.includes('"catalog"')) {
            const result=originalParse.call(this,value,...args);
            tlsConfirmed=result?.identity?.tls===true; blocked++;
            timer=setTimeout(()=>{timerFired=true;},0);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,4400);
            timerWasDeferred=!timerFired;
            return result;
          }
          return originalParse.call(this,value,...args);
        };
        try {await assert.rejects(collect()); assert.equal(timerFired,false,'collector rejects before delayed timer dispatch');} finally {JSON.parse=originalParse;clearTimeout(timer);}
        assert.equal(blocked,1,'blocked parsing exactly once after receiving real query response');
        assert.equal(tlsConfirmed,true,'the parsed database response reports a TLS session');
        assert.equal(timerWasDeferred,true,'the synchronous stall deferred event-loop timers');
        assert.equal(count(),before+1,'the synthetic server executed this collector query');
      });
      await t.test('in-flight cancellation and timeout close stalled clients',async()=>{
        const sockets=new Set(), unexpectedErrors=[]; let connections=0;
        const blackhole=createServer(socket=>{connections++;sockets.add(socket);socket.on('error',error=>{if(error.code!=='ECONNRESET') unexpectedErrors.push(error);});socket.resume();socket.on('close',()=>sockets.delete(socket));});
        await new Promise((resolve,reject)=>{blackhole.once('error',reject);blackhole.listen(0,'127.0.0.1',resolve);});
        try {
          const stalled={...config,binding:{...binding,port:blackhole.address().port},endpoint:{...config.endpoint,port:blackhole.address().port},timeoutMs:4000};
          const controller=new AbortController();
          let timer;
          const connection=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('TLS client did not connect in time')),3500);blackhole.once('connection',()=>{clearTimeout(timer);resolve();});});
          const canceled=assert.rejects(collect(stalled,controller.signal));
          try {await connection;} finally {clearTimeout(timer);controller.abort();await canceled;}
          const start=Date.now(); await assert.rejects(collect(stalled));
          assert(Date.now()-start<6000,'timeout must be bounded');
          assert.equal(connections,2,'both negative controls actually reached the stalled TLS server');
          await Promise.all([...sockets].map(socket=>new Promise((resolve,reject)=>{
            if(socket.destroyed) return resolve();
            const timer=setTimeout(()=>reject(new Error('collector socket did not close')),1500);
            socket.once('close',()=>{clearTimeout(timer);resolve();});
          })));
          assert.deepEqual(unexpectedErrors,[]);
        } finally {
          for(const socket of sockets) socket.destroy();
          await new Promise((resolve,reject)=>blackhole.close(error=>error?reject(error):resolve()));
        }
      });
    } finally {verifier.dispose();}
  } finally {
    if(existsSync(pwfile)) unlinkSync(pwfile);
    if(mayHaveStarted && control(['-D',data,'status'],ctlLog,true)===0) control(['-D',data,'-m','fast','-w','stop'],ctlLog);
  }
});
