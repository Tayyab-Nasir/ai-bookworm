import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const q = value => "'" + String(value).replaceAll("'", "''") + "'";
const j = value => q(JSON.stringify(value)) + '::jsonb';
export async function startGateway(sql, jobId, key) {
  const calls=[];
  const server=createServer(async(req,res)=>{
    const respond=(status,obj)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(obj));};
    try {
      assert.equal(req.headers.apikey,key);assert.equal(req.headers.authorization,'Bearer '+key);
      const url=new URL(req.url,'http://127.0.0.1');const chunks=[];let size=0;
      for await (const chunk of req) {size+=chunk.length;assert(size<=6_010_000);chunks.push(chunk)}
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;
      const run=async statement=>sql(`begin; set local role service_role; set local request.jwt.claims='{"role":"service_role"}'; ${statement} commit;`);
      let value,status=200;calls.push(req.method+' '+url.pathname);
      if(req.method==='POST'&&url.pathname==='/rest/v1/rpc/customer_ai_dispatch_authorized') {
        assert.deepEqual(Object.keys(body),['p_scope']);assert.equal(body.p_scope.jobId,jobId);
        value=JSON.parse(await run(`select to_jsonb(public.customer_ai_dispatch_authorized(${j(body.p_scope)}));`));
      } else if(url.pathname==='/rest/v1/ai_review_service_receipts') {
        assert.equal(url.searchParams.get('select'),'job_id,request_sha256,result_json');
        if(req.method==='POST') {
          assert.equal(body.job_id,jobId);assert.match(body.request_sha256,/^[a-f0-9]{64}$/);assert.deepEqual(Object.keys(body).sort(),['job_id','request_sha256']);
          value=JSON.parse(await run(`with inserted as (insert into public.ai_review_service_receipts(job_id,request_sha256) values(${q(jobId)},${q(body.request_sha256)}) on conflict(job_id) do nothing returning job_id,request_sha256,result_json) select coalesce(json_agg(inserted),'[]'::json) from inserted;`));
          status=value.length?201:409;if(status===409)value={};
        } else if(req.method==='GET') {
          assert.equal(url.searchParams.get('job_id'),'eq.'+jobId);assert.equal(url.searchParams.get('limit'),'2');
          value=JSON.parse(await run(`select coalesce(json_agg(t),'[]'::json) from (select job_id,request_sha256,result_json from public.ai_review_service_receipts where job_id=${q(jobId)} limit 2) t;`));
        } else if(req.method==='PATCH') {
          assert.equal(url.searchParams.get('job_id'),'eq.'+jobId);assert.equal(url.searchParams.get('result_json'),'is.null');assert.deepEqual(Object.keys(body),['result_json']);
          const h=url.searchParams.get('request_sha256');assert.match(h,/^eq\.[a-f0-9]{64}$/);
          value=JSON.parse(await run(`with updated as (update public.ai_review_service_receipts set result_json=${j(body.result_json)} where job_id=${q(jobId)} and request_sha256=${q(h.slice(3))} and result_json is null returning job_id,request_sha256,result_json) select coalesce(json_agg(updated),'[]'::json) from updated;`));
        } else throw Error('unsupported method');
      } else throw Error('unsupported endpoint');
      respond(status,value);
    } catch(err) { console.log('Synthetic database gateway rejected the request.');respond(500,{error:'fixture failed'}); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return {url:`http://127.0.0.1:${server.address().port}`,calls,close:()=>new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections()})};
}
