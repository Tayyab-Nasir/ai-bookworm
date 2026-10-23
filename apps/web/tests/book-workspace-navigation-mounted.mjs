// Actual header with controlled book transport; no real account, storage or provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const bundle = await build({ stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client";
import {AuthorHeader} from "./apps/web/components/AuthorShell";
const root=createRoot(document.getElementById("root"));
window.mountHeader=(bookId,workspaceId)=>root.render(React.createElement(AuthorHeader,{bookId,workspaceId}));`,
  resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  plugins: [{ name: "header-fixtures", setup(builder) {
    builder.onResolve({ filter: /^(next\/link|next\/navigation|\.\/api|\.\/AccountMenu|\.\.\/lib\/referrals)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ resolveDir: process.cwd(), contents:
      args.path === "./api" ? "export const apiClient=()=>window.bookwormApi;"
      : args.path === "./AccountMenu" ? 'import React from "react"; export const AccountMenu=()=>React.createElement("button",null,"Sign out");'
      : args.path === "../lib/referrals" ? "export const claimPendingReferral=async()=>{};"
      : args.path === "next/navigation" ? "export const usePathname=()=>location.pathname;"
      : 'import React from "react"; export default function Link(props){return React.createElement("a",props);}' }));
  } }],
});
const stylePath = resolve("apps/web/styles/globals.css");
const styles = await postcss([tailwind({base:resolve("apps/web"),optimize:false})]).process(await readFile(stylePath,"utf8"),{from:stylePath});
const artifacts=await mkdtemp(resolve(tmpdir(),"bookworm-book-navigation-"));
const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_TEST_CHANNEL||"msedge"});
test.after(()=>browser.close());
async function fixture(mode="normal",width=1280){
  const page=await browser.newPage({viewport:{width,height:844}});page.setDefaultTimeout(6000);
  await page.route("**/*",route=>route.fulfill({contentType:"text/html",body:'<!doctype html><html lang="en"><body style="background:#050505;color:white"><div id="root"></div></body></html>'}));
  await page.goto(`http://127.0.0.1/books/${A}?ws=${A}`);
  await page.addStyleTag({content:styles.css});
  await page.evaluate(({mode,A,B,WORKSPACE})=>{
    window.mode=mode;window.reads=[];window.release={};
    window.bookwormApi={getBook:async id=>{
      window.reads.push(id);const result={book:{id,workspace_id:id===B?B:WORKSPACE}};
      if(window.mode==="hold")return new Promise(resolve=>{window.release[id]=()=>resolve(result);});
      if(window.mode==="wrong")return {book:{id:B,workspace_id:WORKSPACE}};
      if(window.mode==="error")throw Error("Private transport failure");
      return result;
    }};
  },{mode,A,B,WORKSPACE});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.evaluate(({A})=>window.mountHeader(A,A),{A});
  return page;
}
async function assertLinks(page,workspace,label="Author navigation"){
  const nav=page.getByRole("navigation",{name:label,exact:true});
  for(const [name,path] of [["Dashboard","/dashboard"],["Assets","/assets"],["Workflow","/tasks"],["Billing","/billing"],["Analytics","/analytics"]])
    await expect(nav.getByRole("link",{name,exact:true})).toHaveAttribute("href",`${path}?ws=${workspace}`);
  await expect(nav.getByRole("link",{name:"Community",exact:true})).toHaveAttribute("href","/community");
}
test("direct book links use the authorized book workspace, ignoring URL and caller preferences",async()=>{
  const page=await fixture("hold");try{
    const link=page.getByRole("navigation",{name:"Author navigation",exact:true}).getByRole("link",{name:"Dashboard",exact:true});
    await expect(link).toHaveAttribute("aria-disabled","true");await expect(link).toHaveAttribute("href","#");
    // Exercise the click guard even if a caller bypasses aria-disabled.
    await link.click({force:true});assert.equal(new URL(page.url()).pathname,`/books/${A}`);
    await expect(page.getByRole("button",{name:"Sign out"})).toBeEnabled();
    await page.evaluate(({A})=>window.release[A](),{A});await assertLinks(page,WORKSPACE);
    await expect(page.getByRole("link",{name:"New book",exact:true})).toHaveAttribute("href",`/books/new?ws=${WORKSPACE}`);
    assert.deepEqual(await page.evaluate(()=>window.reads),[A]);
    await page.screenshot({path:resolve(artifacts,"book-navigation-desktop.png"),fullPage:true});
  }finally{await page.close();}
});
test("book replacement hides old workspace links and discards late prior-book responses",async()=>{
  const page=await fixture("hold");try{
    await page.evaluate(({B})=>window.mountHeader(B),{B});
    await expect(page.getByRole("link",{name:"New book",exact:true})).toHaveAttribute("href","#");
    await page.waitForFunction(({B})=>typeof window.release[B]==="function",{B});
    await page.evaluate(({B})=>window.release[B](),{B});await assertLinks(page,B);
    await page.evaluate(({A})=>window.release[A](),{A});await page.evaluate(()=>new Promise(requestAnimationFrame));
    await assertLinks(page,B);
  }finally{await page.close();}
});
test("failed or foreign book identity never enables unscoped navigation; explicit reload recovers",async()=>{
  for(const mode of ["error","wrong"]){
    const page=await fixture(mode);try{
      await expect(page.getByRole("button",{name:"Reload navigation",exact:true})).toBeVisible();
      await expect(page.getByRole("link",{name:"Choose workspace",exact:true})).toHaveAttribute("href","/dashboard");
      await expect(page.getByRole("link",{name:"New book",exact:true})).toHaveAttribute("href","#");
      assert(!await page.getByRole("status").innerText().then(text=>text.includes("Private transport")));
      await page.evaluate(()=>{window.mode="normal";});await page.getByRole("button",{name:"Reload navigation",exact:true}).click();
      await assertLinks(page,WORKSPACE);assert.equal((await page.evaluate(()=>window.reads)).length,2);
    }finally{await page.close();}
  }
});
test("mobile menu retains the canonical workspace and keyboard dismissal",async()=>{
  const page=await fixture("normal",390);try{
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.getByRole("button",{name:"Open author navigation"}).click();
    await assertLinks(page,WORKSPACE,"Author mobile navigation");
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:resolve(artifacts,"book-navigation-mobile.png"),fullPage:true});
    await page.keyboard.press("Escape");await expect(page.getByRole("navigation",{name:"Author mobile navigation"})).toHaveCount(0);
  }finally{await page.close();}
});
console.log(`Book navigation artifacts: ${artifacts}`);
