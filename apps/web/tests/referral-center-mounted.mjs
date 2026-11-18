// Synthetic, mounted browser coverage for account-bound referral data and actions.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const result = await build({
  stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client";
    import ReferralCenter from "./apps/web/components/ReferralCenter.tsx";
    const root = createRoot(document.getElementById("root"));
    window.mount = () => root.render(React.createElement(ReferralCenter));
    window.unmount = () => root.render(null);`, loader: "tsx", resolveDir: process.cwd() },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  plugins: [{ name: "referral-fixture", setup(builder) {
    builder.onResolve({ filter: /^\.\/api$/ }, () => ({ path: "api", namespace: "test" }));
    builder.onLoad({ filter: /^api$/, namespace: "test" }, () => ({ contents: `const clients = new Map(); export const apiClient = actor => { if (!clients.has(actor)) clients.set(actor, {
      getReferralCode: () => window.readReferral('code', actor),
      listReferrals: () => window.readReferral('referrals', actor),
      listCreditLedger: () => window.readReferral('ledger', actor),
      claimReferral: code => window.claimReferral(actor, code)
    }); return clients.get(actor); };` }));
  } }],
});
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
after(async () => browser.close());

async function fixture() {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div>' }));
  await page.goto("http://127.0.0.1/referral-fixture");
  await page.evaluate(() => {
    window.A = "11111111-1111-4111-8111-111111111111";
    window.B = "22222222-2222-4222-8222-222222222222";
    window.account = window.A; window.calls = []; window.gates = {}; window.clipboard = [];
    window.wait = name => new Promise((resolve, reject) => { window.gates[name] = { resolve, reject }; });
    window.fetch = async () => {
      if (window.holdSession) await window.wait("session");
      return Response.json({ user: { id: window.account, email: "author@example.test" } });
    };
    window.readReferral = async (kind, actor) => {
      window.calls.push({ kind, actor });
      const resolvedActor = actor ?? window.account;
      if (window.holdRead && resolvedActor === window.A && kind === "ledger") await window.wait("ledger");
      const label = resolvedActor === window.A ? "A" : "B";
      if (kind === "code") return { code: `bw-${label.toLowerCase()}1111111`, user_id: resolvedActor };
      if (kind === "referrals") return { referrals: [{ id: label, referrer_id: resolvedActor, referred_user_id: `${label}user`, status: "rewarded", created_at: "2026-01-01T00:00:00Z", flagged: false }] };
      return { entries: [], summary: { creditBalance: label === "A" ? 111 : 222, referralCredits: 0, rewardedReferrals: 1 } };
    };
    window.claimReferral = async (actor, code) => {
      actor ??= window.account;
      window.calls.push({ kind: "claim", actor, code });
      if (window.holdClaim) await window.wait("claim");
      if (window.failClaim) throw new Error("Lost response");
      return { referral: { id: "33333333-3333-4333-8333-333333333333", referred_user_id: actor }, alreadyAttributed: false };
    };
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => { window.clipboard.push(value); } }, configurable: true });
  });
  await page.addScriptTag({ content: result.outputFiles[0].text });
  return page;
}

test("account revalidation immediately hides previous private referral data", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.mount());
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-a1111111/);
    await page.getByRole("textbox", { name: "Referral code" }).fill("bw-unsubmitted");
    await page.evaluate(() => { window.account = window.B; window.holdSession = true; window.dispatchEvent(new Event("focus")); });
    await page.waitForFunction(() => !!window.gates.session);
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue("");
    await expect(page.getByText("111", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Referral code" })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Referral code" })).toHaveValue("");
    await page.evaluate(() => { window.holdSession = false; window.gates.session.resolve(); });
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-b1111111/);
    await expect(page.getByText("222", { exact: true })).toBeVisible();
    assert((await page.evaluate(() => window.calls.filter(x => ["code", "ledger", "referrals"].includes(x.kind)))).every(x => x.actor));
  } finally { await page.close(); }
});

test("late old-account history cannot replace new-account data", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { window.holdRead = true; window.mount(); });
    await page.waitForFunction(() => !!window.gates.ledger);
    await page.evaluate(() => { window.account = window.B; window.dispatchEvent(new Event("focus")); });
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-b1111111/);
    await page.evaluate(async () => { window.gates.ledger.resolve(); await new Promise(r => setTimeout(r, 50)); });
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-b1111111/);
    await expect(page.getByText("111", { exact: true })).toHaveCount(0);
  } finally { await page.close(); }
});

test("claim is blocked when the account changes before dispatch", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.mount());
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-a1111111/);
    await page.getByRole("textbox", { name: "Referral code" }).fill("bw-test1234");
    await page.evaluate(() => { window.account = window.B; });
    await page.getByRole("button", { name: "Claim code" }).click();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    assert.equal(await page.evaluate(() => window.calls.filter(x => x.kind === "claim").length), 0);
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-b1111111/);
  } finally { await page.close(); }
});

test("late claim response cannot expose old-account data or success to a new account", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.mount());
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-a1111111/);
    await page.getByRole("textbox", { name: "Referral code" }).fill("bw-test1234");
    await page.evaluate(() => { window.holdClaim = true; });
    await page.getByRole("button", { name: "Claim code" }).click();
    await page.waitForFunction(() => !!window.gates.claim);
    await page.evaluate(() => { window.account = window.B; window.dispatchEvent(new Event("focus")); });
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-b1111111/);
    await page.evaluate(() => window.gates.claim.resolve());
    await expect(page.getByRole("button", { name: "Claim code" })).toBeDisabled();
    await expect(page.getByText("Referral code claimed.")).toHaveCount(0);
    await expect(page.getByText("111", { exact: true })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.calls.filter(x => x.kind === "claim").map(x => x.actor)), [await page.evaluate(() => window.A)]);
    await page.evaluate(() => { window.account = window.A; window.dispatchEvent(new Event("focus")); });
    await expect(page.getByRole("button", { name: "Retry original code" })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Referral code" })).toHaveValue("bw-test1234");
    assert.equal(await page.evaluate(() => window.calls.filter(x => x.kind === "claim").length), 1);
  } finally { await page.close(); }
});

test("copy rechecks the account before writing the clipboard", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.mount());
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-a1111111/);
    await page.evaluate(() => { window.account = window.B; });
    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-b1111111/);
    assert.deepEqual(await page.evaluate(() => window.clipboard), []);
  } finally { await page.close(); }
});

test("an uncertain claim survives remount and retries only its original code", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.mount());
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-a1111111/);
    await page.getByRole("textbox", { name: "Referral code" }).fill("bw-first123");
    await page.evaluate(() => { window.failClaim = true; });
    await page.getByRole("button", { name: "Claim code" }).click();
    await expect(page.getByRole("button", { name: "Retry original code" })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Referral code" })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Referral code" })).toHaveValue("bw-first123");
    await page.evaluate(async () => { window.unmount(); await new Promise(resolve => setTimeout(resolve, 50)); window.failClaim = false; window.mount(); });
    await expect(page.getByRole("button", { name: "Retry original code" })).toBeEnabled();
    await page.getByRole("button", { name: "Retry original code" }).click();
    await expect(page.getByText("Referral code claimed.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Claim code" })).toBeDisabled();
    assert.deepEqual(await page.evaluate(() => window.calls.filter(x => x.kind === "claim").map(x => x.code)), ["bw-first123", "bw-first123"]);
    assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  } finally { await page.close(); }
});

test("blocked recovery storage prevents a new claim before dispatch", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { sessionStorage.setItem(`bookworm:referral-claim:v1:${window.A}`, "not valid json"); window.mount(); });
    await expect(page.getByRole("alert")).toContainText("Referral recovery is unavailable");
    await expect(page.getByRole("button", { name: "Claim code" })).toBeDisabled();
    assert.equal(await page.evaluate(() => window.calls.filter(x => x.kind === "claim").length), 0);
  } finally { await page.close(); }
});

test("referral storage write failure blocks dispatch and reports it", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.mount());
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-a1111111/);
    await page.getByRole("textbox", { name: "Referral code" }).fill("bw-first123");
    await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith("bookworm:referral-claim:")) throw new DOMException("Blocked", "QuotaExceededError"); return original.call(this, key, value); }; });
    await page.getByRole("button", { name: "Claim code" }).click();
    await expect(page.getByRole("alert")).toContainText("No claim was sent");
    assert.equal(await page.evaluate(() => window.calls.filter(x => x.kind === "claim").length), 0);
  } finally { await page.close(); }
});

test("a mismatched referral response fails closed", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const original = window.readReferral;
      window.readReferral = async (kind, actor) => kind === "code" ? { code: "bw-private", user_id: window.B } : original(kind, actor);
      window.mount();
    });
    await expect(page.getByRole("alert")).toContainText("does not match your account");
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Claim code" })).toBeDisabled();
  } finally { await page.close(); }
});

test("double submission sends only one claim", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.mount());
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-a1111111/);
    await page.getByRole("textbox", { name: "Referral code" }).fill("bw-test1234");
    await page.evaluate(() => { window.holdClaim = true; const form = document.querySelector("form"); form.requestSubmit(); form.requestSubmit(); });
    await page.waitForFunction(() => !!window.gates.claim);
    assert.equal(await page.evaluate(() => window.calls.filter(x => x.kind === "claim").length), 1);
    await page.evaluate(() => window.gates.claim.resolve());
    await expect(page.getByText("Referral code claimed.")).toBeVisible();
  } finally { await page.close(); }
});

test("remount during an uncertain claim does not submit it again automatically", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.mount());
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-a1111111/);
    await page.getByRole("textbox", { name: "Referral code" }).fill("bw-first123");
    await page.evaluate(() => { window.holdClaim = true; });
    await page.getByRole("button", { name: "Claim code" }).click();
    await page.waitForFunction(() => !!window.gates.claim);
    await page.evaluate(async () => { window.unmount(); await new Promise(resolve => setTimeout(resolve, 50)); window.mount(); });
    await expect(page.getByRole("button", { name: "Retry original code" })).toBeEnabled();
    assert.equal(await page.evaluate(() => window.calls.filter(x => x.kind === "claim").length), 1);
    await page.evaluate(() => window.gates.claim.resolve());
    await expect(page.getByRole("button", { name: "Retry original code" })).toBeEnabled();
  } finally { await page.close(); }
});

test("an unmatched claim receipt cannot clear the pending claim", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => window.mount());
    await expect(page.getByRole("textbox", { name: "Share URL" })).toHaveValue(/bw-a1111111/);
    await page.getByRole("textbox", { name: "Referral code" }).fill("bw-first123");
    await page.evaluate(() => { window.claimReferral = async (actor, code) => { window.calls.push({ kind: "claim", actor, code }); return { referral: { id: "33333333-3333-4333-8333-333333333333", referred_user_id: window.B } }; }; });
    await page.getByRole("button", { name: "Claim code" }).click();
    await expect(page.getByRole("button", { name: "Retry original code" })).toBeEnabled();
    await expect(page.getByText("Referral code claimed.")).toHaveCount(0);
    assert.equal(await page.evaluate(() => sessionStorage.length), 1);
  } finally { await page.close(); }
});
