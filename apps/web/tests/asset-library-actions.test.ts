import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import ts from "typescript";

const workspace = "11111111-1111-4111-8111-111111111111";
const otherWorkspace = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const file = { id: assetId, workspace_id: workspace, name: "My draft.pdf", storage_path: `workspaces/${workspace}/assets/${assetId}/v2/draft.pdf`, mime_type: "application/pdf", size_bytes: 2400, checksum: "a".repeat(64), current_version_number: 2, status: "draft" };
const version = { id: "version-2", asset_id: assetId, storage_path: file.storage_path, version_number: 2, checksum: file.checksum, mime_type: file.mime_type, size_bytes: file.size_bytes, scan_status: "clean", detected_mime_type: file.mime_type, created_at: "2026-10-13T00:00:00Z" };
const signed = (path = file.storage_path) => ({ url: `https://storage.example/storage/v1/object/sign/book-assets/${path}?token=fixture-token`, expiresIn: 300 });
const settle = () => setImmediate();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function control(tree: any, label: string) {
  return nodes(tree).find(node => node.props?.children === label || node.props?.["aria-label"] === label);
}

// Run the real component callbacks against isolated API fixtures. No server,
// credential, native Storage request or file download is involved.
function harness(overrides: Record<string, (...args: any[]) => any> = {}, account = false) {
  const states: any[] = []; const refs: any[] = []; const effects: (() => any)[] = []; const callbacks: any[] = [];
  let stateIndex = 0; let refIndex = 0; let now = 1000;
  const timers: (() => void)[] = [];
  const assigned: string[] = [];
  const values = new Map<string, string>();
  const window = {
    location: { href: `https://app.example/assets?ws=${workspace}`, search: `?ws=${workspace}`, assign(value: string) { assigned.push(value); } },
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) },
    history: { replaceState(_state: unknown, _title: string, next: URL) { window.location.href = next.href; window.location.search = next.search; } },
    setTimeout(fn: () => void) { timers.push(fn); return timers.length; }, clearTimeout() {},
  };
  const api = {
    listWorkspaces: async () => ({ workspaces: [{ id: workspace, name: "Studio" }, { id: otherWorkspace, name: "Other" }] }),
    listAssets: async () => ({ assets: [file] }), listFolders: async () => ({ folders: [] }), listBooks: async () => ({ books: [] }),
    listAssetVersions: async () => ({ versions: [version] }), getAssetUsage: async () => ({ links: [] }),
    getAssetDownloadUrl: async () => signed(), getAssetAccess: async () => ({ canEdit: true }),
    listImageGenerationJobs: async () => ({ jobs: [] }), adminAccess: async () => ({ admin: false }), ...overrides,
  };
  const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const selection: Record<string, any> = {};
  vm.runInNewContext(compile(readFileSync("apps/web/lib/workspace-selection.ts", "utf8")), { exports: selection, window, URL });
  const jsx = (type: unknown, props: any, key?: string) => ({ type, props, key });
  const react = {
    useState(initial: any) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], (value: any) => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
    useRef(initial: any) { const index = refIndex++; return refs[index] ?? (refs[index] = { current: initial }); },
    useCallback(fn: any) { callbacks.push(fn); return fn; }, useEffect(fn: () => any) { effects.push(fn); }, Suspense: "Suspense",
  };
  const require = (name: string): any => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "next/navigation") return { useSearchParams: () => new URLSearchParams(window.location.search) };
    if (name === "next/link") return { default: "Link" };
    if (name.endsWith("/api")) return { apiClient: () => api };
    if (name.endsWith("/AuthorShell")) return { AuthorHeader: "AuthorHeader", AuthorPage: "AuthorPage" };
    if (name.endsWith("/AssetBrowser")) return { default: "AssetBrowser" };
    if (name.endsWith("/ImageQuoteStudio")) return { default: "ImageQuoteStudio" };
    if (name.endsWith("/workspace-selection")) return selection;
    throw new Error(`Unexpected test import: ${name}`);
  };
  class Clock extends Date { static now() { return now; } }
  const exports: Record<string, any> = {};
  const path = account ? "apps/web/components/AccountMenu.tsx" : "apps/web/app/assets/page.tsx";
  const source = readFileSync(path, "utf8") + (account ? "" : "\nexport { AssetsPageInner, verifiedDownloadVersion, verifiedDownloadLink };");
  vm.runInNewContext(compile(source), { exports, require, window, URL, URLSearchParams, Date: Clock, fetch: async () => ({ ok: true, json: async () => ({ user: { email: "author@example.test" } }) }) });
  const render = () => { stateIndex = 0; refIndex = 0; effects.length = 0; callbacks.length = 0; return account ? exports.AccountMenu() : exports.AssetsPageInner(); };
  const initialize = async () => {
    render(); effects.find(fn => fn.toString().includes("api.listWorkspaces"))!(); await settle();
    render(); await callbacks.find(fn => fn.toString().includes("api.listFolders"))!();
    return render();
  };
  return { render, initialize, callbacks, effects, api, timers, assigned, exports, advance(ms: number) { now += ms; } };
}

test("current asset download accepts supported original file types and verified generated audio/packages", () => {
  const h = harness();
  for (const mime of ["text/plain", "text/markdown", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/epub+zip", "image/png", "image/jpeg", "image/webp", "image/gif", "audio/mpeg", "application/zip"]) {
    assert.equal(h.exports.verifiedDownloadVersion({ ...file, mime_type: mime }, [{ ...version, mime_type: mime, detected_mime_type: mime }]).version_number, 2);
  }
  assert.equal(h.exports.verifiedDownloadVersion({ ...file, mime_type: "audio/mpeg" }, [{ ...version, mime_type: "audio/mpeg", detected_mime_type: null, scan_status: "trusted_generated" }]).version_number, 2);
});

test("original file validation rejects foreign identities, changed bytes/types and quarantined or ambiguous versions", () => {
  const { exports } = harness();
  for (const patch of [{ asset_id: "foreign" }, { storage_path: "foreign" }, { checksum: "b".repeat(64) }, { version_number: 1 }, { version_number: 1.5 }, { mime_type: "text/html" }, { size_bytes: 1 }, { scan_status: "pending" }, { scan_status: "infected" }, { scan_status: "error" }, { detected_mime_type: "image/png" }]) {
    assert.throws(() => exports.verifiedDownloadVersion(file, [{ ...version, ...patch }]));
  }
  assert.throws(() => exports.verifiedDownloadVersion(file, [version, version]));
  assert.throws(() => exports.verifiedDownloadVersion({ ...file, deleted_at: "2026-10-13" }, [version]));
  assert.throws(() => exports.verifiedDownloadVersion({ ...file, mime_type: "application/octet-stream" }, [version]));
});

test("private link verification pins the exact stored file, rejects unsafe links and binds the filename", () => {
  const { exports } = harness();
  const link = exports.verifiedDownloadLink(signed(), file);
  assert.equal(new URL(link.url).searchParams.get("download"), file.name);
  for (const value of [{ ...signed(), expiresIn: 0 }, { ...signed(), expiresIn: 301 }, { ...signed(), expiresIn: 1.5 }, { ...signed(), url: "javascript:alert(1)" }, signed("foreign/file.pdf"), { ...signed(), url: signed().url.replace("https:", "http:") }, { ...signed(), url: signed().url.replace("?token=fixture-token", "") }, { ...signed(), url: `${signed().url}&token=second` }, { ...signed(), url: `${signed().url}#fragment` }]) {
    assert.throws(() => exports.verifiedDownloadLink(value, file));
  }
});

test("PDF preparation revalidates the current version and provides a separate download click without downloading", async () => {
  const requests: any[] = [];
  const h = harness({ getAssetDownloadUrl: async (...args: any[]) => { requests.push(args); return signed(); } });
  let tree = await h.initialize();
  await nodes(tree).find(node => node.type === "AssetBrowser").props.onOpen(file); tree = h.render();
  assert.equal(requests.length, 0, "opening a source document does not prepare or download it");
  await control(tree, "Prepare download").props.onClick(); await settle(); tree = h.render();
  assert.deepEqual(requests, [[assetId, 2]]);
  const link = nodes(tree).find(node => node.type === "a" && node.props.download === file.name);
  assert(link); assert.equal(new URL(link.props.href).searchParams.get("download"), file.name);
  assert.equal(h.assigned.length, 0);
});

test("download preparation is single-flight and late signed replies are discarded after workspace replacement", async () => {
  const reply = deferred<any>(); let calls = 0;
  const h = harness({ getAssetDownloadUrl: () => { calls++; return reply.promise; } });
  let tree = await h.initialize(); await nodes(tree).find(node => node.type === "AssetBrowser").props.onOpen(file); tree = h.render();
  const prepare = control(tree, "Prepare download").props.onClick;
  prepare(); prepare(); await settle(); assert.equal(calls, 1);
  nodes(h.render()).find(node => node.type === "select").props.onChange({ target: { value: otherWorkspace } });
  reply.resolve(signed()); await settle();
  assert(!nodes(h.render()).some(node => node.type === "a" && node.props.download));
  assert(!nodes(h.render()).some(node => node.props?.role === "dialog"));
});

test("changed current file never requests a download link and ambiguous failures remain retryable", async () => {
  let changed = false; let calls = 0;
  const h = harness({ listAssets: async () => ({ assets: [{ ...file, checksum: changed ? "b".repeat(64) : file.checksum }] }), getAssetDownloadUrl: async () => { calls++; if (calls === 1) throw new Error("Download link reply could not be confirmed."); return signed(); } });
  let tree = await h.initialize(); await nodes(tree).find(node => node.type === "AssetBrowser").props.onOpen(file); tree = h.render();
  changed = true; control(tree, "Prepare download").props.onClick(); await settle();
  assert.equal(calls, 0); assert(nodes(h.render()).some(node => String(node.props?.children).includes("This file changed")));
  changed = false; control(h.render(), "Prepare download").props.onClick(); await settle(); assert.equal(calls, 1);
  assert(!nodes(h.render()).some(node => node.type === "a" && node.props.download));
  control(h.render(), "Prepare download").props.onClick(); await settle(); assert.equal(calls, 2);
  assert(nodes(h.render()).some(node => node.type === "a" && node.props.download));
});

test("closed and reopened details reject retained preparation callbacks and expired links fence the click", async () => {
  let calls = 0; const h = harness({ getAssetDownloadUrl: async () => { calls++; return signed(); } });
  let tree = await h.initialize(); await nodes(tree).find(node => node.type === "AssetBrowser").props.onOpen(file); tree = h.render();
  const stalePrepare = control(tree, "Prepare download").props.onClick;
  control(tree, "Close asset details").props.onClick();
  await nodes(h.render()).find(node => node.type === "AssetBrowser").props.onOpen(file);
  stalePrepare(); await settle(); assert.equal(calls, 0);
  control(h.render(), "Prepare download").props.onClick(); await settle();
  const link = nodes(h.render()).find(node => node.type === "a" && node.props.download); assert(link);
  h.advance(300001); let prevented = false;
  link.props.onClick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert(!nodes(h.render()).some(node => node.type === "a" && node.props.download));
});

test("retained download clicks cannot navigate or clear a newer link after reopening the same file", async () => {
  const h = harness(); let tree = await h.initialize();
  await nodes(tree).find(node => node.type === "AssetBrowser").props.onOpen(file);
  control(h.render(), "Prepare download").props.onClick(); await settle();
  const staleLink = nodes(h.render()).find(node => node.type === "a" && node.props.download); assert(staleLink);
  control(h.render(), "Close asset details").props.onClick();
  await nodes(h.render()).find(node => node.type === "AssetBrowser").props.onOpen(file);
  control(h.render(), "Prepare download").props.onClick(); await settle();
  let prevented = false; staleLink.props.onClick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert(nodes(h.render()).some(node => node.type === "a" && node.props.download), "stale click must not clear the current link");
  assert(!nodes(h.render()).some(node => node.props?.role === "alert"));
});

test("Refresh library explicitly reloads scoped data and closes an old file dialog", async () => {
  let reads = 0; const h = harness({ listAssets: async () => { reads++; return { assets: [file] }; } });
  let tree = await h.initialize(); await nodes(tree).find(node => node.type === "AssetBrowser").props.onOpen(file); tree = h.render();
  const refresh = control(tree, "Refresh library"); assert.equal(refresh.type, "button");
  refresh.props.onClick(); await settle(); assert.equal(reads, 2);
  assert(!nodes(h.render()).some(node => node.props?.role === "dialog"));
});

test("account settings remains an accessible mobile link and preserves sign-out behavior", async () => {
  const h = harness({}, true); let tree = h.render();
  const link = control(tree, "Account settings and support"); assert(link);
  assert.equal(link.type, "Link"); assert.equal(link.props.href, "/settings/data-rights");
  assert(!link.props.className.split(/\s+/).includes("hidden"));
  await control(tree, "Sign out").props.onClick(); await settle();
  assert.deepEqual(h.assigned, ["/login"]);
});
