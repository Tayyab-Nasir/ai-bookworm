import { test } from "node:test";
import assert from "node:assert/strict";
import { assetLifecycleReady } from "./lib/asset-lifecycle-readiness.js";

test("service-only lifecycle probe accepts only the exact readiness version", async () => {
  for (const [response, expected] of [
    [{data: "asset-lifecycle-v1", error: null}, true],
    [{data: true, error: null}, false],
    [{data: "asset-lifecycle-v2", error: null}, false],
    [{data: "asset-lifecycle-v1", error: {code: "PGRST202"}}, false],
    [{data: null, error: null}, false],
  ] as const) {
    let count = 0;
    const factory = (token?: string, fetcher?: typeof fetch) => {
      count++; assert.equal(token, undefined); assert.equal(typeof fetcher, "function");
      return { rpc: async (name: string) => { assert.equal(name, "asset_lifecycle_readiness"); return response; } };
    };
    assert.equal(await assetLifecycleReady(factory as never), expected);
    assert.equal(count, 1);
  }
  assert.equal(await assetLifecycleReady((() => { throw Error("unavailable"); }) as never), false);
});

test("unresponsive readiness probe fails closed within its deadline", async () => {
  const started = Date.now();
  assert.equal(await assetLifecycleReady((() => ({ rpc: () => new Promise(() => {}) })) as never), false);
  assert.ok(Date.now() - started < 5000);
});
import { createServer } from "node:http";
import { once } from "node:events";

test("timed-out probes abort each underlying HTTP request", async () => {
  let opened = 0, closed = 0;
  const server = createServer((_req, res) => { opened++; res.once("close", () => { closed++; }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    const factory = (_token?: string, fetcher?: typeof fetch) => ({ rpc: async () => {
      const response = await fetcher!(`http://127.0.0.1:${address.port}/rest/v1/rpc/asset_lifecycle_readiness`, {method: "POST"});
      return {data: await response.json(), error: null};
    } });
    const outcomes = await Promise.all(Array.from({length: 3}, () => assetLifecycleReady(factory as never)));
    assert.deepEqual(outcomes, [false, false, false]);
    const until = Date.now() + 2000; while (closed !== 1 && Date.now() < until) await new Promise(r => setTimeout(r, 10));
    assert.equal(opened, 1); assert.equal(closed, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("a transport that ignores abort cannot multiply hung attempts and may recover", async () => {
  let calls=0, settle!: (value: unknown) => void;
  const factory = () => ({rpc: () => { calls++; return calls === 1 ? new Promise(resolve => { settle=resolve; }) : Promise.resolve({data:"asset-lifecycle-v1",error:null}); }});
  assert.deepEqual(await Promise.all(Array.from({length:20}, () => assetLifecycleReady(factory as never))),Array(20).fill(false));
  assert.equal(calls,1);
  assert.equal(await assetLifecycleReady(factory as never),false); assert.equal(calls,1);
  settle({data:"asset-lifecycle-v1",error:null}); await new Promise(r => setTimeout(r,0));
  assert.equal(await assetLifecycleReady(factory as never),true); assert.equal(calls,2);
});
