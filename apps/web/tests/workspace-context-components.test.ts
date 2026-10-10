import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import * as readerHelpers from "../lib/epub-reader";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const available = [A, B].map((id, index) => ({ id, name: `Workspace ${index}`, organization_id: `org-${id}` }));
const asset = (id: string, workspaceId: string) => ({ id, workspace_id: workspaceId, name: id, mime_type: "image/png", size_bytes: 68, checksum: "a".repeat(64) });
const overview = (id: string) => ({ workspace: { id, role: "owner" }, books: [], summary: {}, usage: { usage: {}, creditBalance: 0, entitlements: { plan: { name: "private" }, entitlements: {} } }, recentJobs: [], activity: [], sales: { status: "not_connected" } });
const settle = async () => { await setImmediate(); };
function deferred<T>() {
  let resolveValue!: (value: T) => void; let rejectValue!: (reason: Error) => void;
  const promise = new Promise<T>((resolve, reject) => { resolveValue = resolve; rejectValue = reject; });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

// Execute the real component callbacks without a server, browser, credentials,
// React renderer, or filesystem writes. This is deliberately not native acceptance.
function harness(path: string, api: Record<string, (...args: any[]) => any>, options: { inner?: string; query?: string; remembered?: string; blockedStorage?: boolean; props?: object; trackDependencies?: boolean } = {}) {
  const states: any[] = []; const refs: { current: any }[] = []; const effects: (() => any)[] = []; const callbacks: ((...args: any[]) => any)[] = [];
  let stateCursor = 0; let refCursor = 0; let memoCursor = 0; let effectCursor = 0;
  const memos: { dependencies: unknown[]; value: any }[] = [];
  const effectStates: { dependencies: unknown[]; cleanup?: () => void }[] = [];
  const same = (left: unknown[] | undefined, right: unknown[] | undefined) => !!left && !!right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const memo = (fn: () => any, dependencies: unknown[] = []) => {
    if (!options.trackDependencies) return fn();
    const index = memoCursor++; if (!same(memos[index]?.dependencies, dependencies)) memos[index] = { dependencies, value: fn() };
    return memos[index].value;
  };
  const values = new Map<string, string>();
  const assigned: string[] = [];
  if (options.remembered) values.set("bookworm:workspaceId", options.remembered);
  const url = new URL(`http://fixture.local/${options.query ?? ""}`);
  const window = { location: { href: url.href, search: url.search, origin: url.origin, assign(value: string) { assigned.push(value); } }, history: { replaceState(_state: unknown, _unused: string, value: URL) { window.location.href = value.href; window.location.search = value.search; } }, localStorage: {
    getItem(key: string) { if (options.blockedStorage) throw new Error("Storage blocked"); return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (options.blockedStorage) throw new Error("Storage blocked"); values.set(key, value); },
    removeItem(key: string) { if (options.blockedStorage) throw new Error("Storage blocked"); values.delete(key); },
  }, sessionStorage: { getItem: () => null } };
  const jsx = (type: unknown, props: any, key?: string | number) => ({ type, props, key: key === undefined ? null : String(key) });
  const react = {
    useState(initial: any) { const index = stateCursor++; if (!(index in states)) states[index] = initial; return [states[index], (value: any) => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
    useRef(initial: any) { const index = refCursor++; return refs[index] ?? (refs[index] = { current: initial }); },
    useCallback(fn: (...args: any[]) => any, dependencies?: unknown[]) { const callback = memo(() => fn, dependencies); callbacks.push(callback); return callback; },
    useEffect(fn: () => any, dependencies?: unknown[]) {
      if (!options.trackDependencies) { effects.push(fn); return; }
      const index = effectCursor++;
      if (!same(effectStates[index]?.dependencies, dependencies)) effects.push(() => {
        effectStates[index]?.cleanup?.(); const cleanup = fn(); effectStates[index] = { dependencies: dependencies ?? [], cleanup }; return cleanup;
      });
    }, useMemo: memo, useId: () => "fixture-reader", Suspense: "Suspense",
  };
  const helperExports = {};
  const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compile(readFileSync(resolve("apps/web/lib/workspace-selection.ts"), "utf8")), { exports: helperExports, window, URL });
  const pure = (file: string) => { const exports = {}; vm.runInNewContext(compile(readFileSync(resolve(file), "utf8")), { exports }); return exports; };
  const artwork = pure("apps/web/lib/approved-artwork.ts"); const csv = pure("apps/web/lib/sales-csv.ts");
  const exports: Record<string, any> = {};
  const require = (name: string): any => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "next/link") return { default: "Link" };
    if (name === "next/navigation") return { useSearchParams: () => new URLSearchParams(window.location.search), useRouter: () => ({ push() {} }), usePathname: () => new URL(window.location.href).pathname };
    if (name.endsWith("/workspace-selection")) return helperExports;
    if (name.endsWith("/api")) return { apiClient: () => api };
    if (name.endsWith("/AuthorShell")) return { AuthorHeader: "Header", AuthorPage: "Page" };
    for (const component of ["AuthorDashboard", "BillingCenter", "CollaborationCenter", "BookSetupClient"]) {
      if (name.endsWith(`/${component}`)) return { default: component };
    }
    if (name.endsWith("/AccountMenu")) return { AccountMenu: "AccountMenu" };
    if (name.endsWith("/referrals")) return { claimPendingReferral: async () => {} };
    if (name.endsWith("/AssetBrowser")) return { default: "AssetBrowser" };
    if (name.endsWith("/ImageQuoteStudio")) return { default: "ImageQuoteStudio" };
    if (["ChapterAudioDownload", "NarrationQuoteStudio", "SavedEpubReader"].some(component => name.endsWith(`/${component}`))) return { default: name.split("/").at(-1) };
    if (name.endsWith("/publishing-edition-form")) return pure("apps/web/lib/publishing-edition-form.ts");
    if (name.endsWith("/epub-reader")) return readerHelpers;
    if (name.endsWith("/approved-artwork")) return artwork;
    if (name.endsWith("/manuscript-setup")) return { readSetupCheckpoint: () => null, setupKey: () => "fixture" };
    if (name.endsWith("/sales-csv")) return csv;
    if (name.endsWith("/sales-analytics")) return {};
    if (name === "@bookworm/api-client") return { ApiClientError: class extends Error {} };
    throw new Error(`Unexpected audit import: ${name}`);
  };
  const source = readFileSync(resolve(path), "utf8") + (options.inner ? `\nexport { ${options.inner} as auditInner };` : "");
  let key = 0;
  vm.runInNewContext(compile(source), { exports, require, window, URL, URLSearchParams, crypto: { randomUUID: () => `fixture-request-${++key}` }, navigator: { clipboard: { writeText: api.copyInvitation ?? (async () => {}) } }, fetch: async () => ({ ok: true, json: async () => ({ user: { id: "fixture-user", displayName: "Fixture author" } }) }) }, { filename: path });
  const render = () => { stateCursor = 0; refCursor = 0; memoCursor = 0; effectCursor = 0; effects.length = 0; callbacks.length = 0; return (options.inner ? exports.auditInner : exports.default)(options.props ?? {}); };
  return { render, states, refs, effects, callbacks, values, window, assigned, setProps(value: object) { options.props = value; } };
}

function nodes(tree: any): any[] {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function props(tree: any, type: string) { return nodes(tree).find(node => node.type === type)?.props; }

test("Assets is blank before membership validation and restores B on bare navigation", async () => {
  const h = harness("apps/web/app/assets/page.tsx", { listWorkspaces: async () => ({ workspaces: available }) }, { inner: "AssetsPageInner", remembered: B });
  h.render(); assert.equal(h.states[0], "");
  h.effects.find(fn => fn.toString().includes("api.listWorkspaces"))!(); await settle();
  assert.equal(h.states[0], B); assert.equal(h.values.get("bookworm:workspaceId"), B);
  const tree = h.render();
  assert.equal(props(tree, "AssetBrowser").permissions.edit, false, "data and access must align before mutations");
  props(tree, "select").onChange({ target: { value: A } });
  assert.equal(h.states[0], A); assert.equal(h.values.get("bookworm:workspaceId"), A);
  assert.equal(new URL(h.window.location.href).searchParams.get("ws"), A, "refresh preserves the manual selection");
});

test("Assets workspace-scoped sibling keys are unique, stable, and remount independently on selection change", async () => {
  const h = harness("apps/web/app/assets/page.tsx", { listWorkspaces: async () => ({ workspaces: available }) }, { inner: "AssetsPageInner", remembered: B });
  h.render(); h.effects.find(fn => fn.toString().includes("api.listWorkspaces"))!(); await settle();
  const identities = (tree: any, workspaceId: string) => {
    const siblings = nodes(tree).find(node => Array.isArray(node.props?.children)
      && node.props.children.some((child: any) => child?.type === "ImageQuoteStudio"))!.props.children;
    const keyed = siblings.filter((node: any) => node && node.key !== null && node.key !== undefined);
    assert.equal(new Set(keyed.map((node: any) => node.key)).size, keyed.length, "sibling keys must not collide across component types");
    const studio = siblings.filter((node: any) => node?.type === "ImageQuoteStudio");
    const browser = siblings.filter((node: any) => node?.type === "AssetBrowser");
    assert.equal(studio.length, 1); assert.equal(browser.length, 1);
    assert.equal(studio[0].key, `image-quote:${workspaceId}`);
    assert.equal(browser[0].key, `asset-browser:${workspaceId}`);
    return [studio[0].key, browser[0].key];
  };
  const tree = h.render(); const before = identities(tree, B);
  assert.deepEqual(identities(h.render(), B), before, "ordinary current-workspace renders retain both identities");
  props(tree, "select").onChange({ target: { value: A } });
  const after = identities(h.render(), A);
  assert.notEqual(after[0], before[0]); assert.notEqual(after[1], before[1]);
  assert.equal(props(h.render(), "Header").workspaceId, A);
});

test("Assets rejects a foreign explicit ID without scoped reads", async () => {
  let scoped = 0;
  const h = harness("apps/web/app/assets/page.tsx", { listWorkspaces: async () => ({ workspaces: available }), getAssetAccess: async () => { scoped++; }, listImageGenerationJobs: async () => { scoped++; } }, { inner: "AssetsPageInner", query: "?ws=foreign", remembered: B });
  h.render(); for (const effect of h.effects) if (/api\.(listWorkspaces|getAssetAccess|listImageGenerationJobs)/.test(effect.toString())) effect();
  await settle(); assert.equal(h.states[0], ""); assert.equal(scoped, 0);
  const tree = h.render(); assert(nodes(tree).some(node => node.props?.role === "alert"));
});

test("late A asset/folder/book results cannot replace B, and stale callbacks make no reads", async () => {
  const pending = new Map<string, ReturnType<typeof deferred<any>>>(); let calls = 0;
  const request = (kind: string, id: string) => { calls++; const d = deferred<any>(); pending.set(kind + id, d); return d.promise; };
  const h = harness("apps/web/app/assets/page.tsx", { listWorkspaces: async () => ({ workspaces: available }), listFolders: (id: string) => request("folders", id), listAssets: (id: string) => request("assets", id), listBooks: (id: string) => request("books", id) }, { inner: "AssetsPageInner", remembered: A });
  h.render(); h.effects.find(fn => fn.toString().includes("api.listWorkspaces"))!(); await settle();
  let tree = h.render(); const loadA = h.callbacks.find(fn => fn.toString().includes("api.listFolders"))!; const old = loadA();
  props(tree, "select").onChange({ target: { value: B } }); tree = h.render();
  const fresh = h.callbacks.find(fn => fn.toString().includes("api.listFolders"))!();
  for (const kind of ["folders", "assets", "books"]) pending.get(kind + B)!.resolve({ [kind]: [kind === "assets" ? asset("asset-b", B) : { id: "fixture-b", workspace_id: B }] });
  await fresh;
  for (const kind of ["folders", "assets", "books"]) pending.get(kind + A)!.resolve({ [kind]: [kind === "assets" ? asset("asset-a", A) : { id: "fixture-a", workspace_id: A }] });
  await old; tree = h.render();
  assert.equal(props(tree, "AssetBrowser").assets[0].workspace_id, B);
  assert.equal(props(tree, "AssetBrowser").folders[0].workspace_id, B);
  assert.equal(props(tree, "ImageQuoteStudio").books[0].workspace_id, B);
  const count = calls; await loadA(); assert.equal(calls, count, "old workspace callback must not even request A");
});

test("late asset detail and error responses cannot reopen another workspace", async () => {
  const detail = deferred<any>();
  const h = harness("apps/web/app/assets/page.tsx", { listWorkspaces: async () => ({ workspaces: available }), listFolders: async () => ({ folders: [] }), listAssets: async (id: string) => ({ assets: [asset("asset-a", id)] }), listBooks: async () => ({ books: [] }), listAssetVersions: () => detail.promise, getAssetUsage: async () => ({ links: [] }), getAssetDownloadUrl: async () => ({ url: "fixture-private-preview" }) }, { inner: "AssetsPageInner", remembered: A });
  h.render(); h.effects.find(fn => fn.toString().includes("api.listWorkspaces"))!(); await settle();
  h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listFolders"))!();
  let tree = h.render(); props(tree, "AssetBrowser").onOpen(asset("asset-a", A));
  tree = h.render(); assert(nodes(tree).some(node => node.props?.role === "dialog"));
  props(tree, "select").onChange({ target: { value: B } }); detail.reject(new Error("stale private detail error")); await settle();
  tree = h.render(); assert(!nodes(tree).some(node => node.props?.role === "dialog")); assert(!nodes(tree).some(node => node.props?.role === "alert"));
  assert.equal(props(tree, "AssetBrowser").assets.length, 0);
});

test("late detail results after closing the dialog are ignored", async () => {
  const detail = deferred<any>();
  const h = harness("apps/web/app/assets/page.tsx", { listWorkspaces: async () => ({ workspaces: available }), listFolders: async () => ({ folders: [] }), listAssets: async (id: string) => ({ assets: [asset("asset-a", id)] }), listBooks: async () => ({ books: [] }), listAssetVersions: () => detail.promise, getAssetUsage: async () => ({ links: [] }), getAssetDownloadUrl: async () => ({ url: "fixture-private-preview" }) }, { inner: "AssetsPageInner", remembered: A });
  h.render(); h.effects.find(fn => fn.toString().includes("api.listWorkspaces"))!(); await settle(); h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listFolders"))!();
  props(h.render(), "AssetBrowser").onOpen(asset("asset-a", A));
  const tree = h.render(); nodes(tree).find(node => node.props?.["aria-label"] === "Close asset details").props.onClick();
  detail.resolve({ versions: [{ id: "stale-version" }] }); await settle();
  assert(!nodes(h.render()).some(node => node.props?.role === "dialog"));
  assert(!h.states.some(value => Array.isArray(value) && value.some(item => item.id === "stale-version")));
  assert(!h.states.includes("fixture-private-preview"));
});

test("Assets requires matching data and access, and ignores old mutation callbacks", async () => {
  let writes = 0;
  const h = harness("apps/web/app/assets/page.tsx", { listWorkspaces: async () => ({ workspaces: available }), getAssetAccess: async () => ({ canEdit: true }), listFolders: async () => ({ folders: [] }), listAssets: async (id: string) => ({ assets: [asset("asset-a", id)] }), listBooks: async () => ({ books: [] }), deleteAsset: async () => { writes++; } }, { inner: "AssetsPageInner", remembered: A });
  h.render(); h.effects.find(fn => fn.toString().includes("api.listWorkspaces"))!(); await settle();
  h.render(); h.effects.find(fn => fn.toString().includes("api.getAssetAccess"))!(); await settle();
  assert.equal(props(h.render(), "AssetBrowser").permissions.edit, false, "access alone is insufficient");
  await h.callbacks.find(fn => fn.toString().includes("api.listFolders"))!();
  const tree = h.render(); assert.equal(props(tree, "AssetBrowser").permissions.edit, true);
  const oldDelete = props(tree, "AssetBrowser").onDelete;
  props(tree, "select").onChange({ target: { value: B } });
  await oldDelete("asset-a"); assert.equal(writes, 0);
  assert.equal(props(h.render(), "AssetBrowser").permissions.edit, false);
});

test("late failed library reads cannot overwrite B's successful view or error state", async () => {
  const oldFolders = deferred<any>();
  const h = harness("apps/web/app/assets/page.tsx", { listWorkspaces: async () => ({ workspaces: available }), listFolders: (id: string) => id === A ? oldFolders.promise : Promise.resolve({ folders: [] }), listAssets: async (id: string) => ({ assets: [asset(`asset-${id}`, id)] }), listBooks: async () => ({ books: [] }) }, { inner: "AssetsPageInner", remembered: A });
  h.render(); h.effects.find(fn => fn.toString().includes("api.listWorkspaces"))!(); await settle();
  let tree = h.render(); const stale = h.callbacks.find(fn => fn.toString().includes("api.listFolders"))!();
  props(tree, "select").onChange({ target: { value: B } }); h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listFolders"))!();
  oldFolders.reject(new Error("stale A failure")); await stale; tree = h.render();
  assert.equal(props(tree, "AssetBrowser").assets[0].workspace_id, B);
  assert(!nodes(tree).some(node => node.props?.role === "alert"));
});

async function rejectedCollaboration() {
  const reads: string[] = [];
  const h = harness("apps/web/components/CollaborationCenter.tsx", {
    listWorkspaces: async () => ({ workspaces: [available[0]] }),
    listMembers: async (workspace: string) => { reads.push(workspace); return { members: [{ user_id: "fixture-user", workspace_id: workspace, role: "owner", status: "active" }], profiles: [] }; },
    listTasks: async (workspace: string) => { reads.push(workspace); return { tasks: [] }; },
    listActivity: async (workspace: string) => { reads.push(workspace); return { events: [] }; },
  }, { query: "?ws=foreign", blockedStorage: true, props: { view: "tasks" } });
  h.render(); h.effects.find(fn => fn.toString().includes("api.listWorkspaces"))!(); await settle();
  return { h, reads };
}

test("Collaboration rejects an explicit ID without falsely displaying its sole authorized workspace", async () => {
  const { h, reads } = await rejectedCollaboration();
  const tree = h.render(); const select = props(tree, "select");
  assert.equal(select.value, ""); assert.equal(props(tree, "Header").workspaceId, undefined);
  assert.deepEqual(reads, []); assert(nodes(tree).some(node => node.props?.role === "alert"));
  const placeholder = nodes({ props: select }).find(node => node.type === "option" && node.props.value === "");
  assert(placeholder, "empty validated scope needs a real select option instead of native first-option fallback");
  assert.equal(placeholder.props.disabled, true);
});

test("Collaboration single-workspace recovery preserves the verified session and restores owner permissions", async () => {
  const { h, reads } = await rejectedCollaboration();
  assert.deepEqual(reads, []); assert.equal(props(h.render(), "Header").workspaceId, undefined);
  props(h.render(), "select").onChange({ target: { value: A } });
  h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listMembers"))!();
  const tree = h.render();
  assert.deepEqual(reads, [A, A, A]); assert.equal(props(tree, "select").value, A);
  assert.equal(props(tree, "Header").workspaceId, A); assert.equal(new URL(h.window.location.href).searchParams.get("ws"), A);
  assert(!nodes(tree).some(node => node.props?.role === "alert"));
  assert(nodes(tree).some(node => node.type === "span" && node.props.children === "owner"), "the verified session must match the recovered active membership");
  assert(nodes(tree).some(node => node.type === "form" && node.props.onSubmit?.toString().includes("create-task")), "the recovered owner retains task-edit permissions");
});

test("Collaboration's current rejected-scope picker can recover after an empty load without another render", async () => {
  const { h, reads } = await rejectedCollaboration();
  const tree = h.render(); const select = props(tree, "select");
  assert.equal(select.value, ""); assert.equal(props(tree, "Header").workspaceId, undefined);
  assert.equal(await h.callbacks.find(fn => fn.toString().includes("api.listMembers"))!(), false);
  assert.deepEqual(reads, []);
  // React can bail out of the empty load's setLoading(false). Invoke the same
  // real selector closure: do not manufacture a render after its ref increment.
  select.onChange({ target: { value: A } });
  assert.equal(h.states[1], A, "read generations must not invalidate a still-current membership picker");
  assert.equal(new URL(h.window.location.href).searchParams.get("ws"), A);
  h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listMembers"))!();
  assert.deepEqual(reads, [A, A, A]); assert.equal(props(h.render(), "Header").workspaceId, A);
  assert(!nodes(h.render()).some(node => node.props?.role === "alert"));
});

for (const boundary of ["workspace", "view", "unmount"] as const) test(`Collaboration rejects a retained picker after ${boundary} replacement`, async () => {
  const { h, cleanup, replace } = await deferredCollaboration("task");
  const old = props(h.render(), "select");
  if (boundary === "unmount") cleanup(); else await replace(boundary);
  const before = snapshot(h); const href = h.window.location.href;
  old.onChange({ target: { value: boundary === "workspace" ? A : B } });
  assert.equal(snapshot(h), before); assert.equal(h.window.location.href, href, "old logical scope cannot rewrite the current workspace URL");
});

const collaborationActions = ["task", "book", "invite", "artwork-request", "artwork-reject", "artwork-approve"] as const;
type CollaborationAction = typeof collaborationActions[number];
const event = () => ({ preventDefault() {} });
function snapshot(h: ReturnType<typeof harness>) {
  return JSON.stringify({ states: h.states, preferences: [...h.values], maps: h.refs.filter(ref => Object.prototype.toString.call(ref.current) === "[object Map]").map(ref => [...ref.current]) });
}
function prepareCollaboration(h: ReturnType<typeof harness>, action: CollaborationAction, workspace: string) {
  let tree = h.render();
  const change = (predicate: (node: any) => boolean, value: string) => { const node = nodes(tree).find(predicate); assert(node, `Missing ${action} field`); node.props.onChange({ target: { value } }); tree = h.render(); };
  if (action === "task") {
    change(node => node.props?.placeholder === "Review chapter opening", `Task ${workspace}`);
    change(node => node.props?.placeholder === "Optional context", `Context ${workspace}`);
  } else if (action === "invite") change(node => node.props?.type === "email", `synthetic-${workspace}@example.invalid`);
  else if (action === "book") {
    change(node => node.type === "select" && nodes(node).some(option => option.props?.value === `book:${workspace}-book`), `book:${workspace}-book`);
    change(node => node.props?.placeholder === "What should the reviewer check?", `Book note ${workspace}`);
  } else if (action === "artwork-request") {
    change(node => node.props?.["aria-label"] === "Artwork", `${workspace}-request`);
    change(node => node.props?.["aria-label"] === "Assigned reviewer", "fixture-reviewer");
    change(node => String(node.props?.placeholder).startsWith("Check the character details"), `Artwork note ${workspace}`);
  } else change(node => String(node.props?.placeholder).startsWith("Explain what needs to change"), `Revision ${workspace}`);
  const key = { task: "create-task", book: 'perform("request-approval"', invite: 'perform("invite"', "artwork-request": "request-artwork-approval" }[action as "task" | "book" | "invite" | "artwork-request"];
  if (key) {
    const form = nodes(tree).find(node => node.type === "form" && node.props.onSubmit?.toString().includes(key)); assert(form);
    return () => form.props.onSubmit(event());
  }
  const button = nodes(tree).find(node => node.type === "button" && node.props.children === (action === "artwork-reject" ? "Request a revision" : "Approve version")); assert(button);
  return () => button.props.onClick();
}
async function deferredCollaboration(action: CollaborationAction) {
  const reads: string[] = []; const requests: { payload: any; result: ReturnType<typeof deferred<any>> }[] = [];
  const copies: { value: string; result: ReturnType<typeof deferred<void>> }[] = [];
  let heldActivity: ReturnType<typeof deferred<any>> | null = null;
  const create = (...payload: any[]) => { const result = deferred<any>(); requests.push({ payload, result }); return result.promise; };
  const view = action === "task" ? "tasks" : action === "invite" ? "team" : "approvals";
  const read = (workspace: string) => { reads.push(workspace); };
  const h = harness("apps/web/components/CollaborationCenter.tsx", {
    listWorkspaces: async () => ({ workspaces: available }),
    listMembers: async (workspace: string) => { read(workspace); return { members: [{ user_id: "fixture-user", role: "owner", status: "active" }, { user_id: "fixture-reviewer", role: "reviewer", status: "active" }], profiles: [] }; },
    listTasks: async (workspace: string) => { read(workspace); return { tasks: [] }; },
    listActivity: async (workspace: string) => { read(workspace); const pending = heldActivity; heldActivity = null; return pending ? pending.promise : { events: [] }; },
    listInvitations: async (workspace: string) => { read(workspace); return { invitations: [] }; },
    listBooks: async (workspace: string) => { read(workspace); return { books: [{ id: `${workspace}-book`, title: `Book ${workspace}` }] }; },
    listAssets: async (workspace: string) => { read(workspace); return { assets: [{ ...asset(`${workspace}-request`, workspace), status: "draft", requires_approval: true, current_version_number: 1, current_scan_status: "clean" }] }; },
    listApprovals: async (workspace: string) => { read(workspace); return { approvals: [{ id: `${workspace}-approval`, entity_type: "asset", entity_id: `${workspace}-pending`, entity_version_number: 1, status: "pending", reviewer_id: "fixture-user", requested_by: "fixture-reviewer", created_at: "2026-01-01" }] }; },
    createTask: create, createApproval: create, inviteMember: create, resolveApproval: create,
    copyInvitation: (value: string) => { const result = deferred<void>(); copies.push({ value, result }); return result.promise; },
  }, { query: `?ws=${A}`, props: { view } });
  h.render(); h.effects.find(fn => fn.toString().includes("api.listWorkspaces"))!(); await settle();
  h.render(); const cleanup = h.effects.find(fn => fn.toString().includes("void load()"))!(); await settle();
  const replace = async (boundary: "workspace" | "view") => {
    if (boundary === "workspace") props(h.render(), "select").onChange({ target: { value: B } });
    else h.setProps({ view: view === "tasks" ? "team" : "tasks" });
    h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listMembers"))!();
  };
  return { h, reads, requests, copies, cleanup, replace, holdNextActivity() { heldActivity = deferred<any>(); return heldActivity; }, response: { acceptanceUrl: "http://fixture.local/synthetic-invitation" } };
}

for (const boundary of ["workspace", "view", "unmount"] as const) for (const outcome of ["success", "error"] as const) test(`Collaboration invitation copy ignores late ${outcome} after ${boundary}`, async () => {
  const { h, requests, copies, cleanup, replace, response } = await deferredCollaboration("invite");
  prepareCollaboration(h, "invite", A)(); requests[0].result.resolve(response); await settle();
  const copy = nodes(h.render()).find(node => node.type === "button" && node.props.children === "Copy link"); assert(copy); copy.props.onClick(); assert.equal(copies.length, 1); assert.equal(copies[0].value, response.acceptanceUrl);
  if (boundary === "unmount") cleanup(); else await replace(boundary);
  const before = snapshot(h); if (outcome === "success") copies[0].result.resolve(); else copies[0].result.reject(new Error("Synthetic stale clipboard failure"));
  await settle(); assert.equal(snapshot(h), before); copy.props.onClick(); assert.equal(copies.length, 1, "retained old copy callback must not expose an old invitation to the clipboard");
});
test("Collaboration invitation copy retains ordinary success and error notices", async () => {
  const { h, requests, copies, response } = await deferredCollaboration("invite");
  prepareCollaboration(h, "invite", A)(); requests[0].result.resolve(response); await settle();
  const copy = () => nodes(h.render()).find(node => node.type === "button" && node.props.children === "Copy link").props.onClick();
  copy(); copies[0].result.resolve(); await settle(); assert.equal(h.states[15], "Invitation link copied.");
  copy(); copies[1].result.reject(new Error("Synthetic clipboard failure")); await settle(); assert.equal(h.states[14], "Copy failed. Select and copy the link manually.");
});
test("Collaboration replacement during an accepted action's own reload ignores old reads and finalization", async () => {
  const { h, requests, reads, replace, holdNextActivity, response } = await deferredCollaboration("invite");
  prepareCollaboration(h, "invite", A)(); const read = holdNextActivity(); requests[0].result.resolve(response); await settle();
  await replace("workspace"); prepareCollaboration(h, "invite", B)(); const before = snapshot(h); const count = reads.length;
  read.resolve({ events: [{ id: "synthetic-stale-a-activity", event_type: "old_action", actor_id: "fixture-user", created_at: "2026-01-01" }] }); await settle();
  assert.equal(snapshot(h), before); assert.equal(reads.length, count, "old team reload cannot continue with invitation reads after replacement");
  requests[1].result.resolve(response); await settle(); assert.equal(h.states[13], null);
});
for (const action of collaborationActions) {
  for (const boundary of ["workspace", "view", "unmount"] as const) for (const outcome of ["success", "error"] as const) {
    test(`Collaboration ${action} ignores late ${outcome} after ${boundary} replacement`, async () => {
      const { h, reads, requests, cleanup, replace, response } = await deferredCollaboration(action);
      const old = prepareCollaboration(h, action, A); old(); assert.equal(requests.length, 1);
      if (boundary === "unmount") cleanup(); else { await replace(boundary); if (boundary === "workspace") prepareCollaboration(h, action, B); }
      const before = snapshot(h); const readCount = reads.length;
      if (outcome === "success") requests[0].result.resolve(response); else requests[0].result.reject(new Error("Synthetic stale collaboration failure"));
      await settle(); assert.equal(snapshot(h), before, "late completion cannot alter current fields, invitation/retry maps, notices, errors, busy, or workspace preference");
      assert.equal(reads.length, readCount, "an accepted old action must not launch a stale follow-on reload");
      if (boundary !== "unmount") { old(); assert.equal(requests.length, 1, "retained old callbacks cannot dispatch prior-scope mutations"); }
    });
  }
  test(`Collaboration ${action} ownership guards duplicate clicks and preserves retry then ordinary reload completion`, async () => {
    const { h, reads, requests, response } = await deferredCollaboration(action);
    const start = prepareCollaboration(h, action, A); start(); start(); assert.equal(requests.length, 1, "same-render duplicate dispatch is blocked");
    requests[0].result.reject(new Error("Synthetic current failure")); await settle();
    assert(nodes(h.render()).some(node => node.props?.role === "alert")); assert.equal(h.states[13], null);
    prepareCollaboration(h, action, A)(); assert.equal(requests.length, 2);
    if (action === "artwork-request") assert.equal(requests[1].payload[0].idempotencyKey, requests[0].payload[0].idempotencyKey, "explicit uncertain retry preserves its saved request identity");
    if (action === "artwork-reject") assert.equal(requests[1].payload[2], requests[0].payload[2], "explicit uncertain retry preserves the saved rejection note");
    const beforeReads = reads.length; requests[1].result.resolve(response); await settle();
    assert(reads.length > beforeReads, "ordinary accepted current action reloads only its current workspace");
    assert.equal(h.states[13], null, "the action adopts its own reload instead of leaving busy stuck");
    assert(!nodes(h.render()).some(node => node.props?.role === "alert")); assert(nodes(h.render()).some(node => node.props?.role === "status"));
  });
  for (const outcome of ["success", "error"] as const) test(`Collaboration ${action} stale ${outcome} cannot unlock a newer B action`, async () => {
    const { h, reads, requests, replace, response } = await deferredCollaboration(action);
    prepareCollaboration(h, action, A)(); await replace("workspace");
    assert.equal(h.states[13], null, "replacement releases only the old scope's action lock");
    const current = prepareCollaboration(h, action, B); current(); current(); assert.equal(requests.length, 2);
    const before = snapshot(h); const count = reads.length;
    if (outcome === "success") requests[0].result.resolve(response); else requests[0].result.reject(new Error("Synthetic stale A failure"));
    await settle(); assert.equal(snapshot(h), before); assert.equal(reads.length, count); assert.notEqual(h.states[13], null);
    requests[1].result.resolve(response); await settle(); assert.equal(h.states[13], null);
  });
}

async function deferredAnalytics() {
  const requests: { payload: any; result: ReturnType<typeof deferred<any>> }[] = []; const reads: string[] = [];
  let heldOverview: ReturnType<typeof deferred<any>> | null = null;
  const h = harness("apps/web/app/analytics/page.tsx", {
    listWorkspaces: async () => ({ workspaces: available }),
    getDashboardOverview: async (workspace: string) => { reads.push(workspace); const pending = heldOverview; heldOverview = null; return pending ? pending.promise : { ...overview(workspace), books: [{ id: `${workspace}-book`, title: `Book ${workspace}` }] }; },
    listRetailerSalesImports: async (workspace: string) => { reads.push(workspace); return { imports: [], summary: { currencies: [], currency: null, available: true }, analytics: { monthly: [], books: [], sources: [], available: true, windowStart: "2026-01-01", monthCount: 9 } }; },
    importRetailerSales: (payload: any) => { const result = deferred<any>(); requests.push({ payload, result }); return result.promise; },
  }, { inner: "AnalyticsPageInner", query: `?ws=${A}`, blockedStorage: true });
  h.render(); const cleanup = h.effects.find(fn => fn.toString().includes("void load()"))!(); await settle();
  const choose = async (workspace: string) => {
    const tree = h.render(); const file = { name: `synthetic-${workspace}.csv`, text: async () => `date,title,units,royalty,currency\n2026-01-01,Book ${workspace},1,2.00,USD\n` };
    nodes(tree).find(node => node.props?.type === "file").props.onChange({ target: { files: [file] } }); await settle();
    const select = nodes(h.render()).find(node => node.type === "select" && nodes(node).some(option => option.props?.value === `${workspace}-book`)); assert(select); select.props.onChange({ target: { value: `${workspace}-book` } });
    const form = props(h.render(), "form"); return () => form.onSubmit(event());
  };
  const replace = async () => { h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listWorkspaces"))!(B); };
  return { h, requests, reads, cleanup, choose, replace, holdNextOverview() { heldOverview = deferred<any>(); return heldOverview; } };
}
for (const boundary of ["replacement", "unmount"] as const) for (const outcome of ["success", "error"] as const) test(`Analytics ignores late ${outcome} after ${boundary}`, async () => {
  const { h, requests, reads, cleanup, choose, replace } = await deferredAnalytics(); const old = await choose(A); old(); assert.equal(requests.length, 1);
  if (boundary === "unmount") cleanup(); else { await replace(); await choose(B); }
  const before = snapshot(h); const count = reads.length;
  if (outcome === "success") requests[0].result.resolve({ rowCount: 1, duplicate: false }); else requests[0].result.reject(new Error("Synthetic stale import failure"));
  await settle(); assert.equal(snapshot(h), before); assert.equal(reads.length, count);
  if (boundary === "replacement") { old(); assert.equal(requests.length, 1, "retained old submit cannot import A after B is validated"); }
});
for (const outcome of ["success", "error"] as const) test(`Analytics stale ${outcome} cannot clear a newer B import lock`, async () => {
  const { h, requests, reads, choose, replace } = await deferredAnalytics(); (await choose(A))(); await replace();
  assert.equal(h.states[14], false, "workspace replacement releases only the old scope's busy state");
  const current = await choose(B); current(); current(); assert.equal(requests.length, 2); assert.equal(requests[1].payload.workspaceId, B); assert.equal(requests[1].payload.rows[0].bookId, `${B}-book`);
  const before = snapshot(h); const count = reads.length;
  if (outcome === "success") requests[0].result.resolve({ rowCount: 1, duplicate: false }); else requests[0].result.reject(new Error("Synthetic stale A failure"));
  await settle(); assert.equal(snapshot(h), before); assert.equal(reads.length, count); assert.equal(props(h.render(), "form")["aria-busy"], true);
  requests[1].result.resolve({ rowCount: 1, duplicate: false }); await settle(); assert.equal(props(h.render(), "form")["aria-busy"], false); assert(nodes(h.render()).some(node => node.props?.role === "status"));
});
test("Analytics duplicate submit is blocked and ordinary failure/retry completes its own reload", async () => {
  const { h, requests, reads, choose } = await deferredAnalytics(); const start = await choose(A); start(); start(); assert.equal(requests.length, 1);
  requests[0].result.reject(new Error("Synthetic current import failure")); await settle(); assert(nodes(h.render()).some(node => node.props?.role === "alert")); assert.equal(props(h.render(), "form")["aria-busy"], false);
  props(h.render(), "form").onSubmit(event()); assert.equal(requests.length, 2); const count = reads.length;
  requests[1].result.resolve({ rowCount: 1, duplicate: true }); await settle(); assert(reads.length > count); assert.equal(props(h.render(), "form")["aria-busy"], false);
  assert(!nodes(h.render()).some(node => node.props?.role === "alert")); assert.equal(h.states[11], null); assert.equal(h.states[12].length, 0);
  assert(nodes(h.render()).some(node => node.props?.role === "status" && String(node.props.children).includes("already imported")));
});
for (const boundary of ["replacement", "unmount"] as const) for (const outcome of ["success", "error"] as const) test(`Analytics CSV parsing ignores late ${outcome} after ${boundary}`, async () => {
  const { h, choose, cleanup, replace } = await deferredAnalytics(); const text = deferred<string>();
  const oldFile = nodes(h.render()).find(node => node.props?.type === "file").props.onChange;
  oldFile({ target: { files: [{ name: "synthetic-delayed.csv", text: () => text.promise }] } });
  if (boundary === "unmount") cleanup(); else { await replace(); await choose(B); }
  const before = snapshot(h);
  if (outcome === "success") text.resolve("date,title,units,royalty,currency\n2026-01-01,Old A report,1,2.00,USD\n"); else text.reject(new Error("Synthetic stale CSV failure"));
  await settle(); assert.equal(snapshot(h), before);
  oldFile({ target: { files: [] } }); assert.equal(snapshot(h), before, "old file callback cannot reset the current form");
});
test("Analytics replacement during its own receipt reload cannot publish stale totals or unlock B", async () => {
  const { h, requests, choose, replace, holdNextOverview } = await deferredAnalytics(); (await choose(A))();
  const read = holdNextOverview(); requests[0].result.resolve({ rowCount: 1, duplicate: false }); await settle();
  await replace(); (await choose(B))(); const before = snapshot(h);
  read.resolve({ ...overview(A), books: [{ id: "synthetic-stale-a-book", title: "Synthetic stale A" }] }); await settle();
  assert.equal(snapshot(h), before); assert.equal(props(h.render(), "form")["aria-busy"], true);
  requests[1].result.resolve({ rowCount: 1, duplicate: false }); await settle(); assert.equal(props(h.render(), "form")["aria-busy"], false);
});

const callers = [
  { path: "apps/web/components/AuthorDashboard.tsx", callback: true },
  { path: "apps/web/components/BillingCenter.tsx", callback: true },
  { path: "apps/web/components/CollaborationCenter.tsx", props: { view: "tasks" } },
  { path: "apps/web/components/BookSetupClient.tsx" },
  { path: "apps/web/app/analytics/page.tsx", callback: true, inner: "AnalyticsPageInner" },
];
for (const caller of callers) {
  test(`${caller.path} rejects an unavailable explicit workspace without a scoped request`, async () => {
    let scoped = 0;
    const api = { listWorkspaces: async () => ({ workspaces: available }), listPlans: async () => ({ plans: [] }), getDashboardOverview: async () => { scoped++; }, getUsage: async () => { scoped++; }, listMembers: async () => { scoped++; }, getBook: async () => { scoped++; }, listRetailerSalesImports: async () => { scoped++; } };
    const h = harness(caller.path, api, { ...caller, query: "?ws=foreign", remembered: B }); h.render();
    if (caller.callback) await h.callbacks.find(fn => fn.toString().includes("api.listWorkspaces"))!();
    else h.effects.find(fn => fn.toString().includes("api.listWorkspaces"))!();
    await settle(); assert.equal(scoped, 0); assert(nodes(h.render()).some(node => node.props?.role === "alert"));
  });
}

test("Billing continues its authorized usage read when preference storage is blocked", async () => {
  const reads: string[] = [];
  const h = harness("apps/web/components/BillingCenter.tsx", { listWorkspaces: async () => ({ workspaces: available }), listPlans: async () => ({ plans: [] }), getUsage: async (id: string) => { reads.push(id); return overview(B).usage; } }, { query: `?ws=${B}`, blockedStorage: true });
  h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listWorkspaces"))!();
  assert.deepEqual(reads, [`org-${B}`]); assert(!nodes(h.render()).some(node => node.props?.role === "alert"));
});

for (const action of ["checkout", "portal"] as const) {
  test(`Billing ${action} keeps the validated workspace and organization through blocked-storage return navigation`, async () => {
    let payload: any;
    const plan = { id: "fixture-paid-plan", name: "professional", price_cents: 100, billing_period: "monthly", entitlements_json: {} };
    const summary = overview(B).usage;
    const h = harness("apps/web/components/BillingCenter.tsx", {
      listWorkspaces: async () => ({ workspaces: available }), listPlans: async () => ({ plans: [plan] }),
      getUsage: async () => ({ ...summary, entitlements: { ...summary.entitlements, subscription: { status: "active" } } }),
      createBillingCheckout: async (request: any) => { payload = request; return { checkoutUrl: "http://fixture.local/checkout" }; },
      createBillingPortal: async (request: any) => { payload = request; return { portalUrl: "http://fixture.local/portal" }; },
    }, { query: `?ws=${B}`, blockedStorage: true });
    h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listWorkspaces"))!();
    const button = nodes(h.render()).find(node => node.type === "button" && node.props.onClick?.toString().includes(`${action}(`));
    assert(button); assert.equal(button.props.disabled, false);
    button.props.onClick(); await settle();
    assert.equal(payload.organizationId, `org-${B}`);
    if (action === "checkout") assert.equal(payload.planId, plan.id);
    assert.deepEqual(h.assigned, [`http://fixture.local/${action}`], "only the synthetic location stub receives navigation");
    const returns = action === "checkout" ? [[payload.successUrl, "success"], [payload.cancelUrl, "cancelled"]] : [[payload.returnUrl, null]];
    for (const [target, status] of returns) {
      const url = new URL(target);
      assert.equal(url.origin, "http://fixture.local"); assert.equal(url.pathname, "/billing");
      assert.equal(url.searchParams.get("ws"), B); assert.equal(url.searchParams.get("checkout"), status);
      const reads: string[] = [];
      const returned = harness("apps/web/components/BillingCenter.tsx", {
        listWorkspaces: async () => ({ workspaces: available }), listPlans: async () => ({ plans: [] }),
        getUsage: async (organization: string) => { reads.push(organization); return summary; },
      }, { query: url.search, blockedStorage: true });
      returned.render(); await returned.callbacks.find(fn => fn.toString().includes("api.listWorkspaces"))!();
      assert.deepEqual(reads, [`org-${B}`]); assert.equal(props(returned.render(), "Header").workspaceId, B);
    }
  });
}

async function deferredBilling(action: "checkout" | "portal", workspace = A) {
  const plan = { id: "fixture-paid-plan", name: "professional", price_cents: 100, billing_period: "monthly", entitlements_json: {} };
  const requests: { payload: any; result: ReturnType<typeof deferred<any>> }[] = [];
  const create = (payload: any) => { const result = deferred<any>(); requests.push({ payload, result }); return result.promise; };
  const h = harness("apps/web/components/BillingCenter.tsx", {
    listWorkspaces: async () => ({ workspaces: available }), listPlans: async () => ({ plans: [plan] }),
    getUsage: async (organization: string) => {
      const workspaceId = available.find(item => item.organization_id === organization)!.id;
      const summary = overview(workspaceId).usage;
      return { ...summary, entitlements: { ...summary.entitlements, subscription: { status: "active" } } };
    },
    createBillingCheckout: create, createBillingPortal: create,
  }, { query: `?ws=${workspace}`, blockedStorage: true });
  h.render();
  const cleanup = h.effects.find(fn => fn.toString().includes("currentLoad.current"))!();
  await settle();
  const button = () => nodes(h.render()).find(node => node.type === "button" && node.props.onClick?.toString().includes(`${action}(`));
  const response = (suffix: string) => ({ [action === "checkout" ? "checkoutUrl" : "portalUrl"]: `http://fixture.local/${suffix}` });
  return { h, requests, cleanup, button, response };
}

for (const action of ["checkout", "portal"] as const) {
  test(`Billing ${action} current failure remains visible and permits a successful retry`, async () => {
    const { h, requests, button, response } = await deferredBilling(action, B);
    assert.equal(button().props.disabled, false); button().props.onClick();
    assert.equal(button().props.disabled, true);
    requests[0].result.reject(new Error("Synthetic current billing failure")); await settle();
    assert(nodes(h.render()).some(node => node.props?.role === "alert"));
    assert.equal(button().props.disabled, false); assert.deepEqual(h.assigned, []);
    button().props.onClick(); assert.equal(requests.length, 2);
    assert.equal(requests[1].payload.organizationId, `org-${B}`);
    requests[1].result.resolve(response("current-retry")); await settle();
    assert.deepEqual(h.assigned, ["http://fixture.local/current-retry"]);
    assert(!nodes(h.render()).some(node => node.props?.role === "alert"));
    assert.equal(button().props.disabled, true, "the current redirect remains busy until navigation completes");
  });

  for (const boundary of ["unmount", "replacement"] as const) {
    for (const outcome of ["success", "error"] as const) {
      test(`Billing ${action} ignores late ${outcome} after ${boundary}`, async () => {
        const { h, requests, cleanup, button, response } = await deferredBilling(action);
        button().props.onClick(); assert.equal(requests[0].payload.organizationId, `org-${A}`);
        if (boundary === "unmount") cleanup();
        else {
          h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listWorkspaces"))!(B);
          assert.equal(props(h.render(), "Header").workspaceId, B);
        }
        const before = h.states.slice();
        if (outcome === "success") requests[0].result.resolve(response("stale-old-page"));
        else requests[0].result.reject(new Error("Synthetic stale billing failure"));
        await settle();
        assert.deepEqual(h.assigned, [], "a stale completion must not redirect the new page");
        assert.deepEqual(h.states, before, "a stale completion must not update error or busy state");
        if (boundary === "replacement") assert.equal(button().props.disabled, false, "the current workspace is not held busy by the old action");
      });
    }
  }

  test(`Billing ${action} late old failure cannot clear a newer action's busy state`, async () => {
    const { h, requests, button, response } = await deferredBilling(action);
    const oldButton = button(); oldButton.props.onClick();
    h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listWorkspaces"))!(B);
    assert.equal(button().props.disabled, false, "replacement starts a new billing scope");
    oldButton.props.onClick(); assert.equal(requests.length, 1, "retained old callbacks cannot request the prior workspace");
    const currentButton = button(); currentButton.props.onClick(); currentButton.props.onClick();
    assert.equal(requests.length, 2, "the request identity also blocks duplicate same-render actions");
    assert.equal(requests[1].payload.organizationId, `org-${B}`);
    const before = h.states.slice();
    requests[0].result.reject(new Error("Synthetic stale A failure")); await settle();
    assert.deepEqual(h.states, before); assert.equal(button().props.disabled, true); assert.deepEqual(h.assigned, []);
    requests[1].result.resolve(response("current-b-page")); await settle();
    assert.deepEqual(h.assigned, ["http://fixture.local/current-b-page"]);
    assert(!nodes(h.render()).some(node => node.props?.role === "alert"));
  });
}

test("Book setup Back to library preserves only the validated workspace without preference storage", async () => {
  const h = harness("apps/web/components/BookSetupClient.tsx", { listWorkspaces: async () => ({ workspaces: available }) }, { query: `?ws=${B}`, blockedStorage: true });
  const back = (tree: any) => nodes(tree).find(node => node.type === "Link" && String(node.props.children).includes("Back to library"));
  assert.equal(back(h.render()).props.href, "/dashboard", "unvalidated query must not propagate");
  h.effects.find(fn => fn.toString().includes("api.listWorkspaces"))!(); await settle();
  const href = back(h.render()).props.href; assert.equal(href, `/dashboard?ws=${B}`);
  const requested: string[] = [];
  const dashboard = harness("apps/web/components/AuthorDashboard.tsx", {
    listWorkspaces: async () => ({ workspaces: available }),
    getDashboardOverview: async (workspace: string) => { requested.push(workspace); return overview(workspace); },
  }, { query: new URL(href, "http://fixture.local").search, blockedStorage: true });
  dashboard.render(); await dashboard.callbacks.find(fn => fn.toString().includes("api.listWorkspaces"))!();
  assert.deepEqual(requested, [B]); assert.equal(props(dashboard.render(), "Header").workspaceId, B);
});

test("Analytics Back to desk retains its validated workspace on blocked-storage dashboard re-entry", async () => {
  const scopedReads: string[] = [];
  const h = harness("apps/web/app/analytics/page.tsx", {
    listWorkspaces: async () => ({ workspaces: available }),
    getDashboardOverview: async (workspace: string) => { scopedReads.push(workspace); return overview(workspace); },
    listRetailerSalesImports: async (workspace: string) => {
      scopedReads.push(workspace);
      return { imports: [], summary: { currencies: [], currency: null, available: true }, analytics: { monthly: [], books: [], sources: [], available: true, windowStart: "2026-01-01", monthCount: 9 } };
    },
  }, { inner: "AnalyticsPageInner", query: `?ws=${B}`, blockedStorage: true });
  const back = (tree: any) => nodes(tree).find(node => node.type === "Link" && node.props.children === "Back to desk");
  assert.equal(back(h.render()).props.href, "/dashboard", "unvalidated query must not reach the content link");
  await h.callbacks.find(fn => fn.toString().includes("api.listWorkspaces"))!();
  assert.deepEqual(scopedReads, [B, B]);
  const href = back(h.render()).props.href; assert.equal(href, `/dashboard?ws=${B}`);
  const requested: string[] = [];
  const dashboard = harness("apps/web/components/AuthorDashboard.tsx", {
    listWorkspaces: async () => ({ workspaces: available }),
    getDashboardOverview: async (workspace: string) => { requested.push(workspace); return overview(workspace); },
  }, { query: new URL(href, "http://fixture.local").search, blockedStorage: true });
  dashboard.render(); await dashboard.callbacks.find(fn => fn.toString().includes("api.listWorkspaces"))!();
  assert.deepEqual(requested, [B]); assert.equal(props(dashboard.render(), "Header").workspaceId, B);
});

test("validated header links retain B without storage; unscoped community remains unchanged", () => {
  const h = harness("apps/web/components/AuthorShell.tsx", {}, { inner: "AuthorHeader", props: { workspaceId: B }, blockedStorage: true });
  let tree = h.render(); h.states[0] = true; tree = h.render();
  const hrefs = nodes(tree).filter(node => node.type === "Link").map(node => node.props.href);
  for (const path of ["/dashboard", "/assets", "/tasks", "/billing", "/analytics", "/books/new"]) {
    assert(hrefs.includes(`${path}?ws=${B}`), `Missing scoped header link: ${path}`);
    assert(!hrefs.includes(path), `Unscoped header link: ${path}`);
  }
  assert(hrefs.includes("/community")); assert(!hrefs.includes(`/community?ws=${B}`));
});

for (const component of ["AuthorDashboard", "BillingCenter", "CollaborationCenter", "BookSetupClient"]) {
  test(`${component} renders a sibling header with only a validated workspace`, async () => {
    const h = harness(`apps/web/components/${component}.tsx`, {
      listWorkspaces: async () => ({ workspaces: available }),
      listPlans: async () => ({ plans: [] }),
      getDashboardOverview: async () => overview(B),
      getUsage: async () => overview(B).usage,
    }, { query: `?ws=${B}`, blockedStorage: true, props: component === "CollaborationCenter" ? { view: "tasks" } : {} });
    let tree = h.render();
    assert.equal(props(tree, "Header")?.workspaceId, undefined, "unvalidated query must not reach the header");
    const initialize = h.callbacks.find(fn => fn.toString().includes("api.listWorkspaces"))
      ?? h.effects.find(fn => fn.toString().includes("api.listWorkspaces"));
    assert(initialize); await initialize(); await settle();
    tree = h.render();
    assert.equal(tree.type, "Fragment", "header and main must remain siblings");
    assert.equal(tree.props.children[0].type, "Header");
    assert.equal(tree.props.children[0].props.workspaceId, B);
    assert.equal(tree.props.children[1].type, "main");
    assert(!nodes(tree.props.children[1]).some(node => node.type === "Header"));
  });
}

for (const [path, component, view] of [
  ["dashboard", "AuthorDashboard"], ["billing", "BillingCenter"],
  ["tasks", "CollaborationCenter", "tasks"], ["team", "CollaborationCenter", "team"],
  ["approvals", "CollaborationCenter", "approvals"], ["books/new", "BookSetupClient"],
]) {
  test(`${path} wrapper delegates its single header to the validated client component`, () => {
    const h = harness(`apps/web/app/${path}/page.tsx`, {});
    const tree = h.render();
    assert.equal(tree.type, "Page");
    const content = nodes(tree).filter(node => node.type !== "Page");
    assert.equal(content.length, 1, "wrapper must not retain a duplicate, unscoped header");
    assert.equal(content[0].type, component);
    if (view) assert.equal(content[0].props.view, view);
  });
}

const readOnlyAssetNotice = "Read-only access: you can view assets, but cannot upload, generate, or change them.";
const assetPermissionError = "Editing permissions are unavailable. Your files remain viewable; changes are disabled.";
function assetPermissionNode(tree: any, text: string) { return nodes(tree).find(node => node.props?.children === text); }
function assetEditingDisabled(tree: any) {
  assert.equal(assetPermissionNode(tree, "Upload asset")?.props.disabled, true);
  assert.equal(props(tree, "ImageQuoteStudio").canEdit, false);
  assert.equal(props(tree, "AssetBrowser").permissions.edit, false);
}
async function assetPermissionHarness(getAssetAccess: (workspace: string) => Promise<{ canEdit: boolean }>) {
  const h = harness("apps/web/app/assets/page.tsx", {
    listWorkspaces: async () => ({ workspaces: available }), getAssetAccess,
    listFolders: async () => ({ folders: [] }),
    listAssets: async (workspace: string) => ({ assets: [asset(`asset-${workspace}`, workspace)] }),
    listBooks: async () => ({ books: [] }),
  }, { inner: "AssetsPageInner", remembered: A });
  h.render(); h.effects.find(fn => fn.toString().includes("api.listWorkspaces"))!(); await settle();
  h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listFolders"))!();
  return h;
}

test("Assets permission shows pending then read-only access without enabling edits", async () => {
  const pending = deferred<{ canEdit: boolean }>(); const reads: string[] = [];
  const h = await assetPermissionHarness(workspace => { reads.push(workspace); return pending.promise; });
  let tree = h.render(); assetEditingDisabled(tree);
  assert.equal(assetPermissionNode(tree, "Checking edit permissions…")?.props.role, "status");
  assert(!assetPermissionNode(tree, readOnlyAssetNotice), "unknown access must not be presented as a verified viewer role");
  h.effects.find(fn => fn.toString().includes("api.getAssetAccess"))!();
  pending.resolve({ canEdit: false }); await settle(); tree = h.render();
  assert.equal(assetPermissionNode(tree, readOnlyAssetNotice)?.props.role, "status");
  assert(!assetPermissionNode(tree, "Checking edit permissions…"));
  assert(!assetPermissionNode(tree, "Retry permission check"));
  assetEditingDisabled(tree); assert.equal(props(tree, "AssetBrowser").assets[0].workspace_id, A);
  h.render(); assert.deepEqual(reads, [A], "rendering a viewer notice must not repeat permission requests");
});

test("Assets permission failure keeps files viewable and retries only on explicit action", async () => {
  const fresh = deferred<{ canEdit: boolean }>(); const reads: string[] = [];
  const h = await assetPermissionHarness(async workspace => {
    reads.push(workspace);
    if (reads.length === 1) throw new Error("Synthetic permission read failure");
    return fresh.promise;
  });
  h.render(); h.effects.find(fn => fn.toString().includes("api.getAssetAccess"))!(); await settle();
  let tree = h.render(); assetEditingDisabled(tree);
  const notice = assetPermissionNode(tree, assetPermissionError); assert(notice);
  assert(nodes(tree).some(node => node.props?.role === "alert" && nodes(node).includes(notice)));
  assert.equal(props(tree, "AssetBrowser").assets[0].workspace_id, A);
  const retry = assetPermissionNode(tree, "Retry permission check"); assert.equal(retry?.type, "button");
  h.render(); assert.deepEqual(reads, [A], "failure does not automatically retry");
  retry.props.onClick();
  assert.equal(h.states[4], null); assert.equal(h.states[5], false); assert.equal(h.states[6], 1);
  assert.deepEqual(reads, [A], "the button schedules the existing fenced permission effect, not a second direct request");
  tree = h.render(); assetEditingDisabled(tree);
  assert.equal(assetPermissionNode(tree, "Checking edit permissions…")?.props.role, "status");
  assert(!assetPermissionNode(tree, assetPermissionError)); assert(!assetPermissionNode(tree, "Retry permission check"));
  h.effects.find(fn => fn.toString().includes("api.getAssetAccess"))!();
  tree = h.render(); assetEditingDisabled(tree); assert.deepEqual(reads, [A, A]);
  fresh.resolve({ canEdit: true }); await settle(); tree = h.render();
  assert.equal(assetPermissionNode(tree, "Upload asset")?.props.disabled, false);
  assert.equal(props(tree, "ImageQuoteStudio").canEdit, true);
  assert.equal(props(tree, "AssetBrowser").permissions.edit, true);
  assert(!assetPermissionNode(tree, assetPermissionError)); assert(!assetPermissionNode(tree, readOnlyAssetNotice));
  h.render(); assert.deepEqual(reads, [A, A]);
});

for (const outcome of ["success", "error"] as const) test(`Assets permission ignores stale retry and late ${outcome} after workspace replacement`, async () => {
  const stale = deferred<{ canEdit: boolean }>(); const reads: string[] = [];
  const h = await assetPermissionHarness(async workspace => {
    reads.push(workspace);
    if (reads.length === 1) throw new Error("Synthetic initial permission read failure");
    return workspace === A ? stale.promise : { canEdit: false };
  });
  h.render(); h.effects.find(fn => fn.toString().includes("api.getAssetAccess"))!(); await settle();
  const retry = assetPermissionNode(h.render(), "Retry permission check"); assert(retry);
  retry.props.onClick(); h.render(); h.effects.find(fn => fn.toString().includes("api.getAssetAccess"))!();
  props(h.render(), "select").onChange({ target: { value: B } });
  const revision = h.states[6]; retry.props.onClick();
  assert.equal(h.states[6], revision, "a retained A recovery action cannot schedule a B permission refresh");
  assert.deepEqual(reads, [A, A]);
  h.render(); h.effects.find(fn => fn.toString().includes("api.getAssetAccess"))!(); await settle();
  h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listFolders"))!();
  const before = snapshot(h);
  if (outcome === "success") stale.resolve({ canEdit: true }); else stale.reject(new Error("Synthetic stale A permission failure"));
  await settle(); assert.equal(snapshot(h), before);
  const tree = h.render(); assetEditingDisabled(tree);
  assert.equal(assetPermissionNode(tree, readOnlyAssetNotice)?.props.role, "status");
  assert(!assetPermissionNode(tree, assetPermissionError)); assert(!assetPermissionNode(tree, "Retry permission check"));
  assert.equal(props(tree, "AssetBrowser").assets[0].workspace_id, B);
  assert.deepEqual(reads, [A, A, B]);
});

test("Assets permission retained retry cannot cross an A-to-B-to-A scope replacement", async () => {
  const reads: string[] = [];
  const h = await assetPermissionHarness(async workspace => {
    reads.push(workspace);
    if (reads.length === 1) throw new Error("Synthetic initial permission read failure");
    return { canEdit: false };
  });
  h.render(); h.effects.find(fn => fn.toString().includes("api.getAssetAccess"))!(); await settle();
  const retry = assetPermissionNode(h.render(), "Retry permission check"); assert(retry);
  props(h.render(), "select").onChange({ target: { value: B } });
  props(h.render(), "select").onChange({ target: { value: A } });
  const before = snapshot(h); retry.props.onClick();
  assert.equal(snapshot(h), before, "matching workspace ID alone must not revive a recovery callback from an old scope");
  assert.deepEqual(reads, [A]);
  let tree = h.render(); assetEditingDisabled(tree);
  h.effects.find(fn => fn.toString().includes("api.getAssetAccess"))!(); await settle();
  h.render(); await h.callbacks.find(fn => fn.toString().includes("api.listFolders"))!();
  tree = h.render(); assetEditingDisabled(tree);
  assert.equal(assetPermissionNode(tree, readOnlyAssetNotice)?.props.role, "status");
  assert.deepEqual(reads, [A, A]);
});

test("Publishing render refreshes the real saved reader once; unsaved edits preserve its selected older snapshot", async () => {
  const latest = { bookId: B, editionId: A, jobId: "33333333-3333-4333-8333-333333333333", assetId: "55555555-5555-4555-8555-555555555555", version: 1 as const, sha256: "c".repeat(64), sizeBytes: 2000 };
  const older = { ...latest, jobId: "44444444-4444-4444-8444-444444444444", assetId: "66666666-6666-4666-8666-666666666666", sha256: "d".repeat(64) };
  const edition = { id: A, book_id: B, type: "ebook", language: "en", status: "draft", updated_at: "2026-10-10T00:00:00.000Z", edition_metadata_json: { kind: "ebook", flow: "reflowable" } };
  const pendingRender = deferred<any>(); const failedRender = deferred<any>(); let renderCalls = 0; let historyReads = 0; let sectionReads = 0;
  const api = {
    getBook: async () => ({ book: { id: B, workspace_id: A, language: "en", title: "Fixture book" }, role: "owner" }),
    listEditions: async () => ({ editions: [edition] }), listPublishingJobs: async () => ({ jobs: [] }), listChapters: async () => ({ chapters: [] }), listAssets: async () => ({ assets: [] }),
    renderEdition: () => ++renderCalls === 1 ? pendingRender.promise : failedRender.promise,
    listEditionRenders: async () => { historyReads++; return { renders: [latest, older].map((source, index) => ({ jobId: source.jobId, source, createdAt: `2026-10-10T00:0${1 - index}:00.000Z` })) }; },
    readEpubSection: async (_edition: string, jobId: string, index: number, sha: string) => {
      sectionReads++; const source = jobId === latest.jobId ? latest : older; assert.equal(sha, source.sha256);
      return { source, formatVersion: "epub-reader-1.0.0", layout: "reflowable", spine: [{ index: 0, title: "Saved chapter", layout: "reflowable" }], document: { index, title: "Saved chapter", layout: "reflowable", direction: "ltr", html: `<div><p>${jobId === latest.jobId ? "Latest" : "Older"} saved snapshot.</p></div>`, resources: [] }, warnings: [] };
    },
  };
  const parent = harness("apps/web/components/PublishingStudio.tsx", api, { props: { bookId: B } });
  parent.render(); await parent.callbacks.find(fn => fn.toString().includes("api.getBook"))!();
  let parentTree = parent.render(); const initial = props(parentTree, "SavedEpubReader"); assert(initial);
  const child = harness("apps/web/components/SavedEpubReader.tsx", api, { props: initial, trackDependencies: true });
  const syncReader = async () => { child.setProps(props(parent.render(), "SavedEpubReader")); child.render(); for (const effect of [...child.effects]) effect(); await settle(); return child.render(); };
  await syncReader(); assert.equal(historyReads, 1);
  const renderButton = nodes(parentTree).find(node => node.type === "button" && node.props.children === "Render EPUB"); assert(renderButton); renderButton.props.onClick();
  await syncReader(); assert.equal(historyReads, 1, "starting a render is not a completed saved export");
  pendingRender.resolve({ jobId: latest.jobId, status: "succeeded", artifacts: [] }); await settle();
  await syncReader(); parentTree = parent.render(); const completed = props(parentTree, "SavedEpubReader");
  assert.notEqual(completed.refreshKey, initial.refreshKey); assert.equal(historyReads, 2);
  let childTree = await syncReader(); assert.equal(historyReads, 2, "ordinary rerenders must not repeat history GETs");
  nodes(childTree).find(node => node.props?.["aria-label"] === "Saved EPUB export").props.onChange({ target: { value: older.jobId } }); await settle();
  childTree = child.render(); assert.equal(nodes(childTree).find(node => node.props?.["aria-label"] === "Saved EPUB export").props.value, older.jobId);
  const readsBeforeEdit = sectionReads;
  const rerender = nodes(parent.render()).find(node => node.type === "button" && node.props.children === "Render EPUB"); assert(rerender); rerender.props.onClick();
  childTree = await syncReader(); assert.equal(historyReads, 2, "a pending render cannot refresh a selected export"); assert.equal(sectionReads, readsBeforeEdit);
  failedRender.reject(new Error("Synthetic render failure")); await settle();
  childTree = await syncReader(); assert.equal(props(parent.render(), "SavedEpubReader").refreshKey, completed.refreshKey);
  assert.equal(historyReads, 2, "a failed render cannot refresh a selected export"); assert.equal(sectionReads, readsBeforeEdit);
  assert.equal(nodes(childTree).find(node => node.props?.["aria-label"] === "Saved EPUB export").props.value, older.jobId);
  parentTree = parent.render();
  const navigation = nodes(parentTree).find(node => node.type === "select" && nodes(node).some(child => child.type === "option" && child.props.value === "toc+landmarks")); assert(navigation); navigation.props.onChange({ target: { value: "none" } });
  childTree = await syncReader(); const edited = props(parent.render(), "SavedEpubReader");
  assert.equal(historyReads, 2, "unsaved edition edits must not refetch or replace a selected saved export"); assert.equal(sectionReads, readsBeforeEdit);
  assert.equal(edited.refreshKey, completed.refreshKey); assert.equal(edited.dirty, true);
  assert.equal(nodes(childTree).find(node => node.props?.["aria-label"] === "Saved EPUB export").props.value, older.jobId);
  assert.match(nodes(childTree).find(node => node.type === "iframe").props.srcDoc, /Older saved snapshot/);
  assert.equal(nodes(parent.render()).find(node => node.type === "button" && node.props.children === "Create retailer package").props.disabled, true, "proof/package invalidation remains in force");
});
