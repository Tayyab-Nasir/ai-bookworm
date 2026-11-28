import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

const fromHere = createRequire(import.meta.url);
const mixed = "ABCDABCD-ABCD-4ABC-8ABC-ABCDEFABCDEF";
const lower = mixed.toLowerCase();
const pages = ["", "ai/", "memory/", "overview/", "plan/", "publish/", "translate/"];

async function loadPage(subpath: string) {
  const result = await build({
    entryPoints: [resolve(process.cwd(), `apps/web/app/books/[bookId]/${subpath}page.tsx`)],
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime"],
    plugins: [{ name: "route-components", setup(builder) {
      builder.onResolve({ filter: /^(?:\.\.\/)+components\// }, (args) => ({ path: args.path, namespace: "stub" }));
      builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents:
        "export function AuthorPage() {} export function AuthorHeader() {} export default function Component() {}" }));
    } }],
  });
  const module = { exports: {} as { default: (props: unknown) => Promise<{ props: { children: unknown[] } }> } };
  new Function("module", "exports", "require", result.outputFiles[0]!.text)(module, module.exports, fromHere);
  return module.exports.default;
}

test("all book routes pass canonical UUIDs to the actual page components", async () => {
  for (const subpath of pages) {
    const page = await loadPage(subpath);
    const result = await page({ params: Promise.resolve({ bookId: mixed }), searchParams: Promise.resolve({
      chapter: mixed, aiJob: mixed, draftPlan: mixed,
    }) });
    const children = result.props.children as { props: Record<string, unknown>; key: string | null }[];
    assert.equal(children.length, 2, subpath);
    for (const child of children) assert.equal(child.props.bookId, lower, subpath);
    assert.equal(children[1]!.key, lower, subpath);
    if (!subpath) for (const name of ["initialChapterId", "initialAiJobId", "initialDraftPlanItemId"])
      assert.equal(children[1]!.props[name], lower, name);
  }
});

test("non-UUID route values remain unchanged and invalid editor query IDs are ignored", async () => {
  const page = await loadPage("");
  const result = await page({ params: Promise.resolve({ bookId: "Not-A-UUID" }), searchParams: Promise.resolve({
    chapter: "not-an-id", aiJob: [mixed], draftPlan: "invalid",
  }) });
  const children = result.props.children as { props: Record<string, unknown> }[];
  for (const child of children) assert.equal(child.props.bookId, "Not-A-UUID");
  for (const name of ["initialChapterId", "initialAiJobId", "initialDraftPlanItemId"])
    assert.equal(children[1]!.props[name], undefined, name);
});
