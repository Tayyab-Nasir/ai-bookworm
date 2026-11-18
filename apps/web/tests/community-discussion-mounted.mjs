import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";

const origin = "https://bookworm.test";
const communityId = "30000000-0000-4000-8000-000000000001";
const accountA = "10000000-0000-4000-8000-000000000001";
const accountB = "20000000-0000-4000-8000-000000000001";
const reportId = "40000000-0000-4000-8000-000000000001";
const bundle = await build({
  stdin: {
    contents: `import React from "react";
      import { createRoot } from "react-dom/client";
      import Page from "./apps/web/app/community/[id]/page";
      createRoot(document.getElementById("root")).render(React.createElement(Page));`,
    loader: "tsx", resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  plugins: [{
    name: "discussion-navigation",
    setup(builder) {
      builder.onResolve({ filter: /^(next\/link|next\/navigation|.*\/AuthorShell)$/ }, args => ({ path: args.path, namespace: "navigation" }));
      builder.onLoad({ filter: /.*/, namespace: "navigation" }, args => ({
        contents: args.path === "next/link" ? 'import React from "react"; export default props => React.createElement("a", props);'
          : args.path === "next/navigation" ? `export const useParams = () => ({ id: "${communityId}" });`
          : "export const AuthorHeader = () => null;",
        resolveDir: process.cwd(),
      }));
    },
  }],
});
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
after(async () => browser.close());

async function fixture(run) {
  const page = await browser.newPage();
  const errors = [];
  const pending = new Map();
  const calls = [];
  const writes = [];
  const reports = [{ id: reportId, entity_type: "post", entity_id: "post-a", reason: "Private moderation report", status: "open" }];
  const members = new Map([[accountA, "moderator"], [accountB, "member"]]);
  const postsByActor = new Map([
    [accountA, [{ id: "post-a", author_id: accountA, community_id: communityId, body: "Discussion for account A", status: "published", created_at: "2026-11-18T00:00:00Z" }]],
    [accountB, [{ id: "post-b", author_id: accountB, community_id: communityId, body: "Discussion for account B", status: "published", created_at: "2026-11-18T00:00:00Z" }]],
  ]);
  let actor = accountA;
  let rejectNextPost = false;
  let rejectNextDiscussion = false;
  let switchOnDispatch = false;
  let deniedDispatches = 0;
  function hold(kind) {
    const gate = Promise.withResolvers();
    const started = Promise.withResolvers();
    pending.set(kind, { gate, started });
    return { started: started.promise, finish: gate.resolve };
  }
  async function delayReply(kind) {
    const hold = pending.get(kind);
    if (!hold) return;
    pending.delete(kind);
    hold.started.resolve();
    await hold.gate.promise;
  }
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    const path = url.pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    if (path === "/api/auth/session") {
      await delayReply("session");
      return actor ? route.fulfill({ json: { user: { id: actor } } }) : route.fulfill({ status: 401, json: {} });
    }
    const method = request.method();
    const expected = request.headers()["x-bookworm-actor"];
    if (switchOnDispatch && method === "POST") { actor = accountB; switchOnDispatch = false; }
    const owner = actor;
    calls.push({ method, path, owner, expected });
    if (expected && expected !== owner) {
      deniedDispatches++;
      return route.fulfill({ status: 409, json: { error: { message: "Your account changed." } } });
    }
    if (path === "/api/backend/v1/communities/" + communityId + "/posts") {
      const posts = postsByActor.get(owner);
      const role = members.get(owner);
      if (method === "GET") {
        if (rejectNextDiscussion) {
          rejectNextDiscussion = false;
          return route.fulfill({ status: 503, json: { error: { message: "Discussion refresh is unavailable." } } });
        }
        const payload = { posts: [...posts], role };
        await delayReply("posts");
        return route.fulfill({ json: payload });
      }
      if (rejectNextPost) {
        rejectNextPost = false;
        return route.fulfill({ status: 422, json: { error: { message: "Post was rejected." } } });
      }
      const created = { ...posts[0], id: "new-post", body: request.postDataJSON().body };
      await delayReply("commit");
      writes.push({ kind: "post", actor: owner, body: created.body });
      posts.unshift(created);
      await delayReply("write");
      return route.fulfill({ status: 201, json: created });
    }
    if (path.endsWith("/comments")) {
      const postId = path.split("/").at(-2);
      const comment = { id: "comment", author_id: owner, post_id: postId,
        body: method === "GET" ? "Reply from account A view" : request.postDataJSON().body };
      if (method === "POST") writes.push({ kind: "reply", actor: owner, body: comment.body });
      await delayReply("comments");
      return route.fulfill({ json: method === "GET" ? { comments: [comment] } : comment });
    }
    if (path.endsWith("/reactions")) {
      writes.push({ kind: "reaction", actor: owner });
      return route.fulfill({ json: { postId: "post-a", kind: "like", active: true } });
    }
    if (path.endsWith("/reports")) {
      writes.push({ kind: "report", actor: owner, body: request.postDataJSON().reason });
      return route.fulfill({ status: 201, json: { id: reportId } });
    }
    if (path.endsWith("/moderation/queue")) {
      const payload = { reports: members.get(owner) === "moderator" ? [...reports] : [], limit: 50, offset: 0, hasMore: false };
      await delayReply("reports");
      return route.fulfill({ json: payload });
    }
    if (path.endsWith("/" + reportId + "/dismiss")) {
      writes.push({ kind: "dismiss", actor: owner });
      reports.splice(0);
      return route.fulfill({ json: { reportId, status: "dismissed", action: "dismiss", alreadyResolved: false } });
    }
    return route.fulfill({ status: 404, json: { error: { message: "Unexpected fixture route." } } });
  });
  try {
    await page.goto(origin);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await expect(page.getByText("Discussion for account A")).toBeVisible();
    await run({
      page, hold, calls, writes, members,
      changeAccount: (destination = accountB) => { actor = destination; },
      switchAtDispatch: () => { switchOnDispatch = true; },
      rejectPost: () => { rejectNextPost = true; },
      rejectDiscussion: () => { rejectNextDiscussion = true; },
      deniedAtDispatch: () => deniedDispatches,
      focus: () => page.evaluate(() => window.dispatchEvent(new Event("focus"))),
    });
    assert.deepEqual(errors, []);
  } finally {
    for (const operation of pending.values()) operation.gate.resolve();
    await page.close();
  }
}

test("a draft from a silently switched account never becomes another author's post", async () => {
  await fixture(async ({ page, changeAccount, writes }) => {
    const draft = page.getByLabel("Post text");
    await draft.fill("Private draft from A");
    changeAccount();
    await page.getByRole("button", { name: "Post", exact: true }).click();
    const published = page.getByRole("status").filter({ hasText: "Post published." });
    await expect(page.getByText("Discussion for account B").or(published)).toBeVisible();
    assert.deepEqual(writes, []);
    await expect(page.getByText("Discussion for account B")).toBeVisible();
    await expect(page.getByText("Discussion for account A")).toHaveCount(0);
    await expect(draft).toHaveValue("");
  });
});

test("sent action remains bound to its original actor if the cookie changes at dispatch", async () => {
  await fixture(async ({ page, switchAtDispatch, deniedAtDispatch, calls, writes }) => {
    await page.getByLabel("Post text").fill("Private draft from A");
    switchAtDispatch();
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByText("Discussion for account B")).toBeVisible();
    assert.equal(deniedAtDispatch(), 1);
    assert.equal(calls.find(call => call.method === "POST")?.expected, accountA);
    assert.deepEqual(writes, []);
  });
});

test("foreground check hides moderation data and keeps a draft for the same verified account", async () => {
  await fixture(async ({ page, members, focus, hold }) => {
    await page.getByLabel("Post text").fill("Same account draft");
    await page.getByRole("button", { name: "Moderation Queue" }).click();
    await expect(page.getByText(/Private moderation report/)).toBeVisible();
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(page.getByRole("region", { name: "Review moderation decision" })).toBeVisible();
    const session = hold("session");
    await focus();
    try {
      await session.started;
      await expect(page.getByText(/Private moderation report/)).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Review moderation decision" })).toHaveCount(0);
      await expect(page.getByLabel("Post text")).toHaveCount(0);
      members.set(accountA, "member");
    } finally { session.finish(); }
    await expect(page.getByLabel("Post text")).toHaveValue("Same account draft");
    await expect(page.getByRole("button", { name: "Moderation Queue" })).toHaveCount(0);
  });
});

test("a pending moderation read stays hidden while the replacement account can post", async () => {
  await fixture(async ({ page, changeAccount, focus, hold, calls, writes }) => {
    const delayed = hold("reports");
    await page.getByRole("button", { name: "Moderation Queue" }).click();
    try {
      await delayed.started;
      changeAccount();
      await focus();
      await expect(page.getByText("Discussion for account B")).toBeVisible();
      await page.getByLabel("Post text").fill("Post from the replacement account");
      await page.getByRole("button", { name: "Post", exact: true }).click();
      await expect(page.getByText("Post from the replacement account", { exact: true })).toBeVisible();
    } finally { delayed.finish(); }
    await expect(page.getByRole("button", { name: "Refresh discussion" })).toBeEnabled();
    await expect(page.getByText(/Private moderation report/)).toHaveCount(0);
    assert.equal(calls.find(call => call.path.endsWith("/moderation/queue"))?.expected, accountA);
    assert.deepEqual(writes, [{ kind: "post", actor: accountB, body: "Post from the replacement account" }]);
  });
});

test("a delayed discussion refresh stays out of another account's view", async () => {
  await fixture(async ({ page, changeAccount, focus, hold }) => {
    const delayed = hold("posts");
    await focus();
    try {
      await delayed.started;
      changeAccount();
      await focus();
      await expect(page.getByText("Discussion for account B")).toBeVisible();
    } finally { delayed.finish(); }
    await expect(page.getByText("Discussion for account A")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Moderation Queue" })).toHaveCount(0);
  });
});

test("a confirmed post result from the original account stays out of the new account's view", async () => {
  await fixture(async ({ page, changeAccount, hold, writes }) => {
    const delayed = hold("write");
    await page.getByLabel("Post text").fill("Accepted by A only");
    await page.getByRole("button", { name: "Post", exact: true }).click();
    try {
      await delayed.started;
      changeAccount();
    } finally { delayed.finish(); }
    await expect(page.getByText("Discussion for account B")).toBeVisible();
    await expect(page.getByText("Accepted by A only")).toHaveCount(0);
    await expect(page.getByText("Post published.")).toHaveCount(0);
    assert.deepEqual(writes, [{ kind: "post", actor: accountA, body: "Accepted by A only" }]);
  });
});

test("ordinary posting preserves a rejected draft and clears it after confirmed success", async () => {
  await fixture(async ({ page, calls, rejectPost, writes }) => {
    const draft = page.getByLabel("Post text");
    const submit = page.getByRole("button", { name: "Post", exact: true });
    await draft.fill("Draft before rejection");
    rejectPost();
    await submit.click();
    await expect(page.getByRole("alert")).toContainText("Post was rejected.");
    await expect(draft).toHaveValue("Draft before rejection");
    await submit.click();
    await expect(page.getByRole("status").filter({ hasText: "Post published." })).toBeVisible();
    await expect(draft).toHaveValue("");
    assert.deepEqual(writes, [{ kind: "post", actor: accountA, body: "Draft before rejection" }]);
    assert.ok(calls.every(call => call.expected === accountA));
  });
});

test("a same-account foreground check preserves an in-flight post confirmation", async () => {
  await fixture(async ({ page, hold, focus, writes }) => {
    const delayed = hold("commit");
    const draft = page.getByLabel("Post text");
    await draft.fill("Saved while checking the account");
    await page.getByRole("button", { name: "Post", exact: true }).click();
    try {
      await delayed.started;
      await focus();
      await expect(draft).toBeDisabled();
      await expect(draft).toHaveValue("Saved while checking the account");
    } finally { delayed.finish(); }
    await expect(page.getByRole("status").filter({ hasText: "Post published." })).toBeVisible();
    await expect(page.getByText("Saved while checking the account", { exact: true })).toBeVisible();
    await expect(draft).toHaveValue("");
    assert.deepEqual(writes, [{ kind: "post", actor: accountA, body: "Saved while checking the account" }]);
  });
});

test("moderation refresh reloads the queue and announces a confirmed decision", async () => {
  await fixture(async ({ page, calls, writes }) => {
    await page.getByRole("button", { name: "Moderation Queue" }).click();
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.getByRole("button", { name: "Confirm dismissal", exact: true }).click();
    await expect(page.getByText("No open reports.")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Report dismissed." })).toBeVisible();
    assert.deepEqual(writes, [{ kind: "dismiss", actor: accountA }]);
    assert.equal(calls.filter(call => call.path.endsWith("/moderation/queue")).length, 2);
    assert.ok(calls.every(call => call.expected === accountA));
  });
});

test("a failed refresh keeps the confirmed moderation outcome", async () => {
  await fixture(async ({ page, rejectDiscussion, writes }) => {
    await page.getByRole("button", { name: "Moderation Queue" }).click();
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    rejectDiscussion();
    await page.getByRole("button", { name: "Confirm dismissal", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Discussion refresh is unavailable.");
    await expect(page.getByRole("status").filter({ hasText: "Report dismissed." })).toBeVisible();
    await expect(page.getByText("No posts yet")).toHaveCount(0);
    assert.deepEqual(writes, [{ kind: "dismiss", actor: accountA }]);
  });
});

test("comments, replies, reactions and reports use the current scoped API", async () => {
  await fixture(async ({ page, calls, writes }) => {
    const card = page.getByRole("article").filter({ hasText: "Discussion for account A" });
    await card.getByRole("button", { name: "Comments", exact: true }).click();
    await expect(card.getByText("Reply from account A view")).toBeVisible();
    await card.getByLabel("Comment text").fill("Reply from this author");
    await card.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(card.getByText("Reply from this author")).toBeVisible();
    await card.getByRole("button", { name: "like", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "like reaction added." })).toBeVisible();
    await card.getByRole("button", { name: "Report", exact: true }).click();
    await card.getByLabel("Report reason").fill("Check this discussion");
    await card.getByRole("button", { name: "Send report" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Report sent for moderation." })).toBeVisible();
    assert.deepEqual(writes, [
      { kind: "reply", actor: accountA, body: "Reply from this author" },
      { kind: "reaction", actor: accountA },
      { kind: "report", actor: accountA, body: "Check this discussion" },
    ]);
    assert.ok(calls.every(call => call.expected === accountA));
  });
});
