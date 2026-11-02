// Real asset page, AssetBrowser and account menu with compiled project styles.
// All transports are synthetic and intercepted; no operator cookies or Storage calls.
// Run: node --test apps/web/tests/asset-library-mounted.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const bundle = await build({
  stdin: { contents: `import React from "react"; import { createRoot } from "react-dom/client";
    import Assets from "./apps/web/app/assets/page";
    const root = createRoot(document.getElementById("root"));
    window.renderAssets = () => root.render(React.createElement(Assets));
    window.clearAssets = () => root.render(null);`, loader: "tsx", resolveDir: process.cwd() },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  plugins: [{ name: "asset-library-fixtures", setup(builder) {
    builder.onResolve({ filter: /^@bookworm\/api-client$/ }, args => (args.importer.replaceAll("\\", "/").endsWith("/app/assets/page.tsx") || args.importer.replaceAll("\\", "/").endsWith("/components/ImageQuoteStudio.tsx")) ? {path:"scoped-api",namespace:"fixture"} : undefined);
    builder.onLoad({ filter: /^scoped-api$/, namespace: "fixture" }, () => ({ contents: 'export const createClient = opts => new Proxy(window.api,{get(target,key){const value=target[key];return typeof value === "function" ? (...args) => {if(opts.expectedActor!==window.actor) throw new Error("Account changed");return value(...args)} : value}});' }));
    builder.onResolve({ filter: /(?:^|\/)api$/ }, args => args.importer.replaceAll("\\", "/").startsWith(resolve("apps/web").replaceAll("\\", "/")) ? {path:"api", namespace:"fixture"} : undefined);
    builder.onLoad({ filter: /^api$/, namespace: "fixture" }, () => ({ contents: "export const apiClient = () => window.api;" }));
    builder.onLoad({ filter: /^studio$/, namespace: "fixture" }, () => ({ contents: "export default function ImageQuoteStudio() { return null; }" }));
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
    builder.onLoad({ filter: /^navigation$/, namespace: "fixture" }, () => ({ contents: "export const useSearchParams = () => new URLSearchParams(window.location.search); export const usePathname = () => window.location.pathname;" }));
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
    builder.onLoad({ filter: /^link$/, namespace: "fixture" }, () => ({ resolveDir: process.cwd(), contents: 'import React from "react"; export default function Link(props) { return React.createElement("a", props); }' }));
  } }],
});
const stylePath = resolve("apps/web/styles/globals.css");
const styles = await postcss([tailwind({ base: resolve("apps/web"), optimize: false })]).process(await readFile(stylePath, "utf8"), { from: stylePath });
const instrument = (await readFile("apps/web/app/fonts/instrument-serif-italic.ttf")).toString("base64");
const artifacts = await mkdtemp(resolve(tmpdir(), "bookworm-asset-library-mounted-"));
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
test.after(async () => { await browser.close(); console.log(JSON.stringify({ assetLibraryArtifacts: artifacts })); });

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
async function fixture(width = 1280, admin = false) {
  const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(6000);
  const signedRequests = [];
  await page.context().route("**/*", route => {
    if (route.request().url().includes("/storage/v1/object/sign/")) {
      signedRequests.push(route.request().url());
      return route.fulfill({ status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="My draft.pdf"' }, body: "%PDF-1.4\nSynthetic browser download fixture.\n%%EOF" });
    }
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' });
  });
  await page.goto(`http://127.0.0.1/assets?ws=${A}`);
  await page.addStyleTag({ content: styles.css + `
    @font-face {font-family:BookwormInstrument;src:url(data:font/ttf;base64,${instrument});font-style:italic;font-weight:400;font-display:swap}
    :root {--font-inter:Arial,sans-serif;--font-instrument-serif:BookwormInstrument,serif}
    body {font-family:var(--font-inter);color:white}` });
  await page.evaluate(({ A, B, ASSET, admin }) => {
    window.actor = A; window.calls = []; window.revision = 0; window.gates = {}; window.scanStatus = "clean";
    window.defer = name => new Promise((resolve, reject) => { window.gates[name] = { resolve, reject }; });
    window.file = workspace => ({ id: ASSET, workspace_id: workspace, folder_id: null, name: workspace === A ? (window.revision ? "My revised draft.pdf" : "My draft.pdf") : "Other studio draft.pdf",
      storage_path: `workspaces/${workspace}/assets/${ASSET}/v2/draft.pdf`, mime_type: "application/pdf", size_bytes: 2400, checksum: "a".repeat(64), type: "source_document", status: "draft", current_version_number: 2 });
    window.versionHistory = workspace => ({ versions: [{ id: "version-2", asset_id: ASSET, storage_path: window.file(workspace).storage_path,
      version_number: 2, checksum: "a".repeat(64), mime_type: "application/pdf", size_bytes: 2400, scan_status: window.scanStatus,
      detected_mime_type: "application/pdf", created_at: "2026-10-13T00:00:00Z" }] });
    window.signed = workspace => ({ url: `https://storage.example/storage/v1/object/sign/book-assets/${window.file(workspace).storage_path}?token=fixture-token`, expiresIn: 300 });
    window.selected = A;
    window.fetch = async path => {
      if (path === "/api/auth/session") return Response.json({ user: { id: window.actor, email: "author@example.test" } });
      if (path === "/api/auth/logout") return Response.json({ signedOut: true });
      throw new Error(`Unexpected fixture fetch ${path}`);
    };
    window.api = {
      adminAccess: async () => ({ admin }), claimReferral: async () => ({ claimed: true }),
      listImageQuoteModels: async () => ({ models: [{id:'synthetic',label:'Test image',size:'1024',quality:'standard',maxReferenceImages:0}], purchaseAvailable:true }),
      createImageQuote: async (workspace, body) => { window.calls.push({operation:'quote',actor:window.actor,workspace,body}); return new Promise(()=>{}); },
      listWorkspaces: async () => ({ workspaces: [{ id: A, name: "Author studio" }, { id: B, name: "Other studio" }] }),
      getAssetAccess: async workspace => { window.calls.push({ operation: "access", workspace }); return { canEdit: true }; },
      listFolders: async workspace => { window.calls.push({ operation: "folders", workspace }); return { folders: [] }; },
      listBooks: async workspace => { window.calls.push({ operation: "books", workspace }); return { books: [] }; },
      listAssets: async workspace => { window.calls.push({ operation: "assets", workspace }); window.selected = workspace; return { assets: [window.file(workspace)] }; },
      listImageGenerationJobs: async workspace => { window.calls.push({ operation: "images", workspace }); return { jobs: [] }; },
      listAssetVersions: async () => window.versionHistory(window.selected), getAssetUsage: async () => ({ links: [] }),
      getAssetDownloadUrl: async (asset, version) => {
        window.calls.push({ operation: "download", asset, version });
        if (window.downloadOverride) return window.downloadOverride();
        return window.signed(window.selected);
      },
    };
  }, { A, B, ASSET, admin });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.renderAssets());
  await expect(page.getByRole("button", { name: "Refresh library", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: /^My draft\.pdf/ })).toBeVisible();
  return { page, signedRequests };
}
async function openFile(page, name = /^My draft\.pdf/) {
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Loading file details" })).toHaveCount(0);
}



const prompt = p => p.getByLabel('Describe the scene, characters, mood and visual style');
const consent = p => p.getByLabel(/Save this private prompt/);
test('account switch removes previous image prompt and consent', async () => {const {page}=await fixture();try{
 await expect(page.getByRole('option',{name:/Test image/})).toHaveCount(1);await prompt(page).fill('Account A private illustration prompt');await consent(page).check();
 await page.evaluate(id=>{window.actor=id;window.dispatchEvent(new Event('focus'))},B);
 await expect(prompt(page)).toHaveValue('');await expect(consent(page)).not.toBeChecked();await expect(page.getByRole('button',{name:'Prepare image quote'})).toBeDisabled();
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.operation==='quote').length),0);
}finally{await page.close()}});
test('same-account verification preserves an unsent image prompt and consent', async () => {const {page}=await fixture();try{
 await expect(page.getByRole('option',{name:/Test image/})).toHaveCount(1);await prompt(page).fill('A private unsent illustration prompt');await consent(page).check();
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(prompt(page)).toHaveValue('A private unsent illustration prompt');await expect(consent(page)).toBeChecked();
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.operation==='quote').length),0);
}finally{await page.close()}});
test('silent account change prevents image quote dispatch', async () => {const {page}=await fixture();try{
 await expect(page.getByRole('option',{name:/Test image/})).toHaveCount(1);await prompt(page).fill('Account A private illustration prompt');await consent(page).check();
 await page.evaluate(id=>{window.actor=id},B);await page.getByRole('button',{name:'Prepare image quote'}).click();
 await expect(prompt(page)).toHaveValue('');assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.operation==='quote').length),0);
}finally{await page.close()}});

test('missing job after uncertain image acceptance remains quarantined', async () => {const {page}=await fixture();try{
 await page.evaluate(()=>window.clearAssets());await expect(page.getByText('Illustrations and cover art')).toHaveCount(0);
 await page.evaluate(({A})=>{const quoteId='44444444-4444-4444-8444-444444444444';sessionStorage.setItem(`bookworm.image-quote.v2:${A}:${A}`,JSON.stringify({quoteId,idempotencyKey:'original-request-key',acceptancePending:true}));
 window.api.getImageQuote=async()=>({quote:{id:quoteId,status:'ready',reservedCredits:'8',expiresAt:'2099-01-01T00:00:00Z'}});window.api.getImageQuoteJob=async()=>({quoteId,job:null});window.api.acceptImageQuote=async()=>{window.calls.push({operation:'accept'});};window.renderAssets();},{A});
 await expect(page.getByText('Acceptance is unconfirmed.',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'Accept quote · 8 credits'})).toBeDisabled();
 await page.getByRole('button',{name:'Refresh status'}).click();
 await expect(page.getByText('Acceptance is unconfirmed.',{exact:false})).toBeVisible();
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.operation==='accept').length),0);
 assert.equal(await page.evaluate(({A})=>JSON.parse(sessionStorage.getItem(`bookworm.image-quote.v2:${A}:${A}`)).acceptancePending,{A}),true);
}finally{await page.close()}});

test('legacy image checkpoint is retained and blocks a different account', async () => {const {page}=await fixture();try{
 await page.evaluate(()=>window.clearAssets());await expect(page.getByText('Illustrations and cover art')).toHaveCount(0);
 await page.evaluate(({A,B})=>{window.actor=B;sessionStorage.setItem(`bookworm.image-quote.v1:${A}`,JSON.stringify({idempotencyKey:'legacy-request-key'}));window.renderAssets();},{A,B});
 await expect(page.getByText('An older image request needs manual reconciliation',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'Recover same quote request'})).toBeVisible();
 assert.equal(await page.evaluate(({A})=>sessionStorage.getItem(`bookworm.image-quote.v1:${A}`)!==null,{A}),true);
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.operation==='quote'||x.operation==='accept').length),0);
}finally{await page.close()}});
test('a stale acceptance marker cannot be removed when starting a fresh image', async () => {const {page}=await fixture();try{
 await page.evaluate(()=>window.clearAssets());await expect(page.getByText('Illustrations and cover art')).toHaveCount(0);
 await page.evaluate(({A})=>{const quoteId='44444444-4444-4444-8444-444444444444';sessionStorage.setItem(`bookworm.image-quote.v2:${A}:${A}`,JSON.stringify({quoteId,idempotencyKey:'original-request-key'}));
 window.api.getImageQuote=async()=>({quote:{id:quoteId,status:'expired',reservedCredits:'8',expiresAt:'2020-01-01T00:00:00Z'}});window.api.getImageQuoteJob=async()=>({quoteId,job:null});window.renderAssets();},{A});
 await expect(page.getByRole('button',{name:'Prepare a new quote',exact:true})).toBeVisible();
 await page.evaluate(({A})=>{const k=`bookworm.image-quote.v2:${A}:${A}`,v=JSON.parse(sessionStorage.getItem(k));sessionStorage.setItem(k,JSON.stringify({...v,acceptancePending:true}));},{A});
 await page.getByRole('button',{name:'Prepare a new quote',exact:true}).click();
 await expect(page.getByText('The original image request needs recovery.',{exact:false})).toBeVisible();
 assert.equal(await page.evaluate(({A})=>JSON.parse(sessionStorage.getItem(`bookworm.image-quote.v2:${A}:${A}`)).acceptancePending,{A}),true);
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.operation==='quote'||x.operation==='accept').length),0);
}finally{await page.close()}});

test('A-B-A account switch cannot revive a delayed image quote dispatch', async () => {const {page}=await fixture();try{
 await expect(page.getByRole('option',{name:/Test image/})).toHaveCount(1);await prompt(page).fill('A private illustration for ABA testing');await consent(page).check();
 await page.evaluate(()=>{const original=window.fetch;window.delaySession=true;window.fetch=async path=>{if(path==='/api/auth/session'&&window.delaySession){window.delaySession=false;await window.defer('held-session');}return original(path);};});
 await page.getByRole('button',{name:'Prepare image quote'}).click();await page.waitForFunction(()=>!!window.gates['held-session']);
 await page.evaluate(id=>{window.actor=id;window.dispatchEvent(new Event('focus'))},B);await expect(prompt(page)).toHaveValue('');
 await page.evaluate(id=>{window.actor=id;window.dispatchEvent(new Event('focus'))},A);await expect(page.getByRole('button',{name:'Recover same quote request'})).toBeVisible();
 await page.evaluate(()=>window.gates['held-session'].resolve());await page.waitForTimeout(200);
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.operation==='quote').length),0);
 assert.equal(await page.evaluate(({A})=>sessionStorage.getItem(`bookworm.image-quote.v2:${A}:${A}`)!==null,{A}),true);
}finally{await page.close()}});

test('workspace permission recheck hides retained image draft until access is verified', async () => {const {page}=await fixture();try{
 await expect(page.getByRole('option',{name:/Test image/})).toHaveCount(1);await prompt(page).fill('Private draft awaiting workspace verification');await consent(page).check();
 await page.evaluate(()=>{window.oldAccess=window.api.getAssetAccess;window.api.getAssetAccess=async()=>{throw Error('access revoked')};window.dispatchEvent(new Event('focus'));});
 await expect(page.getByText('Workspace access could not be verified.',{exact:false})).toBeVisible();await expect(prompt(page)).toBeHidden();
 await page.evaluate(()=>{window.api.getAssetAccess=window.oldAccess;});await page.getByRole('button',{name:'Try again'}).click();
 await expect(prompt(page)).toHaveValue('Private draft awaiting workspace verification');await expect(consent(page)).toBeChecked();
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.operation==='quote').length),0);
}finally{await page.close()}});

test('same-account focus revalidation clears paid image consent', async () => {const {page}=await fixture();try{
 await page.evaluate(()=>window.clearAssets());await expect(page.getByText('Illustrations and cover art')).toHaveCount(0);
 await page.evaluate(({A})=>{const quoteId='44444444-4444-4444-8444-444444444444';sessionStorage.setItem(`bookworm.image-quote.v2:${A}:${A}`,JSON.stringify({quoteId,idempotencyKey:'original-request-key'}));
 window.quoteReads=0;window.api.getImageQuote=async()=>{window.quoteReads++;return {quote:{id:quoteId,status:'ready',reservedCredits:'8',expiresAt:'2099-01-01T00:00:00Z'}}};window.api.getImageQuoteJob=async()=>({quoteId,job:null});window.api.acceptImageQuote=async()=>{window.calls.push({operation:'accept'});};window.renderAssets();},{A});
 const paidConsent=page.getByLabel(/I approve sending this saved prompt/);const accept=page.getByRole('button',{name:'Accept quote · 8 credits'});
 await expect(paidConsent).toBeVisible();await paidConsent.check();await expect(accept).toBeEnabled();
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForFunction(()=>window.quoteReads>=2);
 await expect(paidConsent).toBeVisible();await expect(paidConsent).not.toBeChecked();await expect(accept).toBeDisabled();
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.operation==='accept').length),0);
}finally{await page.close()}});
