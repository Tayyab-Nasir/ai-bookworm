import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { customerAiCatalogSnapshotSql as sql } from "./lib/customer-ai-catalog-snapshot.js";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { canonicalCustomerCatalogJson as canonical, customerAiCatalogEvidenceVerifier } from "./lib/customer-ai-catalog-evidence.js";
import { customerAiReadiness, isCustomerAiReady } from "./lib/customer-ai-readiness.js";

const now = 2_000_000_000_000, keys = generateKeyPairSync("ed25519"), otherKeys = generateKeyPairSync("ed25519");
const scope = { auditorId: "auditor", keyId: "audit-key", deploymentId: "deployment", projectRef: "project", schemaRevision: "revision" };
const hash = "a".repeat(64), other = "b".repeat(64);
function catalog() {
  return {
    catalogFormat: "customer-ai-catalog-v1", postgresMajor: 16,
    roles: [{name:"authenticated",superuser:false,inherit:true,createRole:false,createDb:false,canLogin:false,replication:false,bypassRls:false,connectionLimit:-1,validUntil:null,defaultPrivileges:[],settings:[]},
      {name:"service_role",superuser:false,inherit:true,createRole:false,createDb:false,canLogin:false,replication:false,bypassRls:true,connectionLimit:-1,validUntil:null,defaultPrivileges:[],settings:[]}],
    memberships: [{role:"authenticated",member:"user",grantor:"owner",admin:false,inherit:false,set:true}],
    databases: [{name:"bookworm",owner:"owner",encoding:"UTF8",collation:"C",ctype:"C",localeProvider:"c",template:false,allowConnections:true,connectionLimit:-1,acl:null,allRolesSettingsSha256:null,globalAllRolesSettingsSha256:null}],
    extensions: [{name:"plpgsql",owner:"owner",schema:"pg_catalog",version:"1.0",relocatable:false,configurationRelations:[],conditionSha256:null}],
    schemas: [{name:"public",owner:"owner",acl:["owner=UC/owner"]}],
    types: [{schema:"public",name:"status",owner:"owner",kind:"e",category:"E",notNull:false,acl:null,baseType:null,elementType:null,compositeRelation:null,collation:null,defaultSha256:null,enumLabelsSha256:hash,domainConstraints:[]}],
    relations: [{schema:"public",name:"jobs",kind:"r",owner:"owner",rowSecurity:true,forceRowSecurity:false,options:null,viewSha256:null,acl:["owner=arwdDxt/owner"],constraints:[],indexes:[],
      columns:[{name:"id",position:1,type:"uuid",notNull:true,dropped:false,identity:"",generated:"",acl:null as string[] | null,defaultSha256:null}],
      policies:[{name:"jobs_read",command:"r",permissive:true,roles:["authenticated"],usingSha256:hash,checkSha256:null}],
      triggers:[{name:"guard",enabled:"O",internal:false,function:"public.guard()",definitionSha256:hash}]}],
    functions: [{schema:"public",identity:"claim_customer_ai_job(uuid, integer)",kind:"f",owner:"owner",securityDefiner:true,language:"plpgsql",volatility:"v",parallel:"u",strict:false,leakproof:false,configSha256:[hash],acl:["service_role=X/owner"],definitionSha256:hash}],
  };
}
type FixtureCatalog = ReturnType<typeof catalog>;
function fixture() {
  const clock = { value: now, monotonic: 1000 }, baseline = catalog();
  const verifier = customerAiCatalogEvidenceVerifier({ expected:scope, expectedCatalog:baseline, verificationKey:keys.publicKey, mode:"test", _testClock:()=>({wall:clock.value,monotonic:clock.monotonic}) });
  function signed(challenge: ReturnType<typeof verifier.challenge>, replacement = structuredClone(baseline), mutate: Record<string,unknown> = {}, secret: KeyObject = keys.privateKey) {
    const body = { ...challenge, observedAt:clock.value, expiresAt:clock.value+4000, catalog:replacement, ...mutate };
    const signature = sign(null,Buffer.from("bookworm-customer-ai-catalog-evidence-v1\n"+canonical(body)),secret).toString("hex");
    return canonical({ ...body, signature });
  }
  return {verifier,clock,baseline,signed};
}

test("only a fresh authenticated exact catalog observation matches; no readiness authority is emitted", () => {
  const f=fixture(), challenge=f.verifier.challenge(), result=f.verifier.verify(challenge,f.signed(challenge));
  assert.equal(result.kind,"matched_catalog_observation");
  assert.equal(result.projectRef,scope.projectRef);
  assert.equal("aclVerified" in result,false);
  assert.match(result.catalogSha256,/^[a-f0-9]{64}$/u);
  assert(Object.isFrozen(result));
  assert.throws(()=>f.verifier.verify(challenge,f.signed(challenge)),/unavailable/);
  f.verifier.dispose();
});

test("a matching snapshot alone cannot activate customer AI readiness", async () => {
  const f=fixture(), challenge=f.verifier.challenge(), observation=f.verifier.verify(challenge,f.signed(challenge));
  const expected={deploymentId:scope.deploymentId,projectRef:scope.projectRef,serviceId:"service",keyId:"key",schemaRevision:scope.schemaRevision};
  const gate=customerAiReadiness({expected,now:()=>now,operatorEnabled:()=>true,
    verifyIdentity:async()=>({deploymentId:expected.deploymentId,serviceId:expected.serviceId,keyId:expected.keyId,identityVerified:true,observedAt:now}),
    verifyWorker:async()=>({deploymentId:expected.deploymentId,projectRef:expected.projectRef,serviceId:expected.serviceId,keyId:expected.keyId,kind:"customer_generation",ready:true,observedAt:now,expiresAt:now+4000}),
    verifyDatabase:async()=>observation});
  assert.equal(await isCustomerAiReady(gate),false);
  f.verifier.dispose();
});

test("rejects correctly signed schema, ACL, role and membership drift", () => {
  const changes: ((c:FixtureCatalog)=>void)[] = [
    c=>{c.functions[0].definitionSha256=other;}, c=>{c.functions[0].owner="untrusted";},
    c=>{c.functions[0].securityDefiner=false;}, c=>{c.functions[0].configSha256=[other];},
    c=>{c.functions[0].acl.push("=X/owner");}, c=>{c.functions[0].acl.push("authenticated=X/owner");},
    c=>{c.relations[0].acl.push("authenticated=arwd/owner");},
    c=>{c.relations[0].columns[0].acl=["authenticated=w/owner"];},
    c=>{c.relations[0].rowSecurity=false;}, c=>{c.relations[0].forceRowSecurity=true;},
    c=>{c.relations[0].policies[0].usingSha256=other;}, c=>{c.relations[0].policies[0].roles=["PUBLIC"];},
    c=>{c.relations[0].triggers[0].definitionSha256=other;}, c=>{c.relations[0].triggers[0].enabled="D";},
    c=>{c.roles[0].bypassRls=true;}, c=>{c.roles[0].createRole=true;},
    c=>{c.memberships[0].admin=true;}, c=>{c.memberships[0].inherit=true;}, c=>{c.memberships[0].set=false;},
    c=>{c.memberships.push({role:"service_role",member:"user",grantor:"owner",admin:false,inherit:false,set:true});},
    c=>{c.roles.push({...c.roles[0],name:"unlisted"});}, c=>{c.schemas[0].owner="untrusted";},
    c=>{c.databases[0].owner="untrusted";}, c=>{(c.databases[0] as any).globalAllRolesSettingsSha256=other;},
    c=>{c.extensions[0].version="2.0";}, c=>{c.extensions[0].owner="untrusted";},
    c=>{(c.types[0] as any).acl=["authenticated=U/owner"];}, c=>{c.types[0].enumLabelsSha256=other;},
    c=>{(c.roles[0].defaultPrivileges as any[]).push({schema:null,kind:"f",acl:["=X/owner"]});},
    c=>{(c.roles[0].settings as any[]).push({database:null,settingsSha256:other});},
    c=>{(c.relations[0].constraints as any[]).push({name:"changed",type:"c",validated:true,definitionSha256:hash});},
    c=>{(c.relations[0].indexes as any[]).push({name:"changed",valid:true,ready:true,unique:true,definitionSha256:hash});},
  ];
  for(const change of changes) {
    const f=fixture(), c=structuredClone(f.baseline); change(c); const challenge=f.verifier.challenge();
    assert.throws(()=>f.verifier.verify(challenge,f.signed(challenge,c)),/unavailable/); f.verifier.dispose();
  }
});

test("rejects forged signatures, wrong identities and challenge replay", () => {
  for(const [mutate,secret] of [
    [{auditorId:"other"},keys.privateKey], [{keyId:"other"},keys.privateKey], [{deploymentId:"other"},keys.privateKey], [{projectRef:"other"},keys.privateKey],
    [{schemaRevision:"other"},keys.privateKey], [{nonce:"A".repeat(43)},keys.privateKey], [{},otherKeys.privateKey],
  ] as [Record<string,unknown>,KeyObject][]) {
    const f=fixture(), challenge=f.verifier.challenge();
    assert.throws(()=>f.verifier.verify(challenge,f.signed(challenge,undefined,mutate,secret)),/unavailable/);
    assert.throws(()=>f.verifier.verify(challenge,f.signed(challenge)),/unavailable/);
    f.verifier.dispose();
  }
  const f=fixture(), c=f.verifier.challenge();
  assert.throws(()=>f.verifier.verify({...c},f.signed(c)),/unavailable/);
  f.verifier.dispose();
});

test("rejects stale, future, expired, overlong or pre-challenge evidence", () => {
  for(const mutate of [
    {observedAt:now-1}, {observedAt:now+1}, {expiresAt:now}, {expiresAt:now+5001},
  ]) {
    const f=fixture(), challenge=f.verifier.challenge();
    assert.throws(()=>f.verifier.verify(challenge,f.signed(challenge,undefined,mutate)),/unavailable/); f.verifier.dispose();
  }
  const f=fixture(), challenge=f.verifier.challenge(), raw=f.signed(challenge);
  f.clock.value += 5000; f.clock.monotonic += 5000; assert.throws(()=>f.verifier.verify(challenge,raw),/unavailable/); f.verifier.dispose();
});

test("evidence that expires while being validated is rejected after parsing and hashing", () => {
  let reads=0;
  const verifier=customerAiCatalogEvidenceVerifier({expected:scope,expectedCatalog:catalog(),verificationKey:keys.publicKey,mode:"test",
    _testClock:()=> (++reads <= 2 ? {wall:now,monotonic:1000} : {wall:now+5000,monotonic:6000}) });
  const challenge=verifier.challenge();
  const body={...challenge,observedAt:now,expiresAt:now+4000,catalog:catalog()};
  const signature=sign(null,Buffer.from("bookworm-customer-ai-catalog-evidence-v1\n"+canonical(body)),keys.privateKey).toString("hex");
  assert.throws(()=>verifier.verify(challenge,canonical({...body,signature})),/unavailable/);
  verifier.dispose();
});

test("wall-clock discontinuity fails closed even if the supplied evidence looks fresh", () => {
  const f=fixture(), challenge=f.verifier.challenge(), raw=f.signed(challenge);
  f.clock.value+=2000;
  assert.throws(()=>f.verifier.verify(challenge,raw),/unavailable/);
  f.verifier.dispose();
});

test("rejects noncanonical, duplicate, malformed or unsupported evidence and invalid schemas", () => {
  for (const change of [
    (raw:string)=>" "+raw, (raw:string)=>raw.replace('{','{"version":1,'), (_raw:string)=>"x".repeat(2*1024*1024+1),
  ]) {
    const f=fixture(), challenge=f.verifier.challenge(); assert.throws(()=>f.verifier.verify(challenge,change(f.signed(challenge))),/unavailable/); f.verifier.dispose();
  }
  for (const change of [
    (c:any)=>{delete c.roles[0].bypassRls;}, (c:any)=>{c.roles[0].extra=true;},
    (c:any)=>{c.roles.push({...c.roles[0],superuser:true});}, (c:any)=>{c.postgresMajor=15;},
    (c:any)=>{c.catalogFormat="different";}, (c:any)=>{c.functions=[];},
  ]) {
    const f=fixture(), c:any=structuredClone(f.baseline); change(c); const challenge=f.verifier.challenge();
    assert.throws(()=>f.verifier.verify(challenge,f.signed(challenge,c)),/unavailable/); f.verifier.dispose();
  }
});

test("cancellation, clock rollback, key disposal and mutable inputs cannot bypass checks", () => {
  const f=fixture(), challenge=f.verifier.challenge(), raw=f.signed(challenge);
  const abort=new AbortController(); abort.abort();
  assert.throws(()=>f.verifier.verify(challenge,raw,abort.signal),/unavailable/);
  const next=f.verifier.challenge(); f.clock.value--;
  assert.throws(()=>f.verifier.verify(next,f.signed(next)),/unavailable/);
  f.verifier.dispose(); assert.throws(()=>f.verifier.challenge(),/unavailable/);
  const expected=catalog();
  assert.throws(()=>customerAiCatalogEvidenceVerifier({expected:scope,expectedCatalog:expected,verificationKey:keys.privateKey}),/unavailable/);
  const copy=customerAiCatalogEvidenceVerifier({expected:scope,expectedCatalog:expected,verificationKey:keys.publicKey,mode:"test",_testClock:()=>({wall:now,monotonic:1000})});
  expected.roles[0].superuser=true;
  const c=copy.challenge(), original=catalog(), body={...c,observedAt:now,expiresAt:now+4000,catalog:original};
  const signature=sign(null,Buffer.from("bookworm-customer-ai-catalog-evidence-v1\n"+canonical(body)),keys.privateKey).toString("hex");
  assert.equal(copy.verify(c,canonical({...body,signature})).kind,"matched_catalog_observation"); copy.dispose();
});

test("collector snapshot from a disposable PostgreSQL instance is authenticated and real catalog drift is rejected", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE evidence_user NOINHERIT;
      CREATE SCHEMA evidence_fixture;
      CREATE TABLE evidence_fixture.jobs (id integer NOT NULL);
      ALTER TABLE evidence_fixture.jobs ENABLE ROW LEVEL SECURITY;
      CREATE POLICY jobs_read ON evidence_fixture.jobs FOR SELECT TO evidence_user USING (id > 0);
      CREATE FUNCTION evidence_fixture.guard(integer) RETURNS boolean
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT $1 > 0';`);
    const collect = async () => (await db.query<{catalog: unknown}>(sql)).rows[0].catalog;
    const expected = await collect();
    const verifier = customerAiCatalogEvidenceVerifier({ expected:scope, expectedCatalog:expected, verificationKey:keys.publicKey, mode:"test", _testClock:()=>({wall:now,monotonic:1000}) });
    const signEvidence = (challenge: ReturnType<typeof verifier.challenge>, snapshot: unknown) => {
      const body = {...challenge, observedAt:now, expiresAt:now+4000, catalog:snapshot};
      const signature = sign(null,Buffer.from("bookworm-customer-ai-catalog-evidence-v1\n"+canonical(body)),keys.privateKey).toString("hex");
      return canonical({...body,signature});
    };
    const first = verifier.challenge();
    assert.equal(verifier.verify(first,signEvidence(first,expected)).kind,"matched_catalog_observation");
    await db.exec("ALTER TABLE evidence_fixture.jobs DISABLE ROW LEVEL SECURITY");
    const changed = await collect(), second = verifier.challenge();
    assert.throws(()=>verifier.verify(second,signEvidence(second,changed)),/unavailable/);
    verifier.dispose();
  } finally { await db.close(); }
});
