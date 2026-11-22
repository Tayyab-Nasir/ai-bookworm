import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const bundle = await build({
  stdin: {
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { AuthCard } from "./apps/web/components/AuthCard";
      const root = createRoot(document.getElementById("root"));
      window.mount = (mode) => root.render(React.createElement(AuthCard, {
        mode, headline: "Account", subtext: "Account access",
        primaryLabel: mode === "signup" ? "Create account" : "Sign in",
        altPrompt: "", altLabel: "", altHref: "/"
      }));
    `,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  outdir: ".auth-test-bundle",
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  plugins: [{
    name: "mock-next-link",
    setup(builder) {
      builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
      builder.onLoad({ filter: /^link$/, namespace: "fixture" }, () => ({
        contents: "import React from 'react'; export default function Link(props) { return React.createElement('a', props); }",
        resolveDir: process.cwd(),
      }));
    },
  }],
});
const script = bundle.outputFiles.find(file => file.path.endsWith(".js")).text;
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_TEST_CHANNEL || "msedge" });
test.after(() => browser.close());

for (const mode of ["login", "signup"]) {
  for (const invalid of ["html", "null", "array", "invalid-message", "invalid-error", "invalid-redirect", "unsafe-redirect", "empty-success"]) {
    test(`${mode} shows a retryable error for ${invalid} authentication response`, async () => {
      const page = await browser.newPage();
      try {
        await page.route("**/*", route => route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><div id='root'></div>",
        }));
        await page.goto("http://127.0.0.1/fixture");
        await page.addScriptTag({ content: script });
        await page.evaluate(({ mode, invalid }) => {
          window.calls = 0;
          window.fetch = async () => {
            window.calls++;
            if (window.calls === 1) {
              const replies = {
                html: "<html>Gateway error</html>",
                null: "null",
                array: "[]",
                "invalid-message": JSON.stringify({ message: { unexpected: true } }),
                "invalid-error": JSON.stringify({ error: { message: { unexpected: true } } }),
                "invalid-redirect": JSON.stringify({ redirectTo: { unexpected: true } }),
                "unsafe-redirect": JSON.stringify({ redirectTo: "javascript:alert(1)" }),
                "empty-success": "{}",
              };
              const failure = ["html", "array", "invalid-error"].includes(invalid);
              return new Response(replies[invalid], { status: failure ? 502 : 200 });
            }
            return new Response(JSON.stringify({ error: { message: "Please check your credentials." } }), {
              status: 401,
              headers: { "content-type": "application/json" },
            });
          };
          window.mount(mode);
        }, { mode, invalid });
        if (mode === "signup") await page.getByLabel("Name", { exact: true }).fill("Test author");
        await page.getByLabel("Email", { exact: true }).fill("author@example.test");
        await page.getByLabel("Password", { exact: true }).fill("testpassword");
        const button = page.getByRole("button", { name: mode === "signup" ? "Create account" : "Sign in", exact: true });
        await button.click();
        await page.getByText("Authentication is temporarily unavailable. Please try again.", { exact: true }).waitFor();
        assert.equal(await page.getByText("Gateway error", { exact: false }).count(), 0);
        await button.click();
        await page.getByText("Please check your credentials.", { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.calls), 2);
      } finally {
        await page.close();
      }
    });
  }
}

test("Google sign-in retains its retry target after an unreadable response", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><div id='root'></div>",
    }));
    await page.goto("http://127.0.0.1/fixture");
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      window.calls = 0;
      window.fetch = async () => {
        window.calls++;
        if (window.calls === 1) return new Response("<html>Gateway error</html>", { status: 502 });
        return new Response(JSON.stringify({ error: { message: "Google sign-in is unavailable." } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      };
      window.mount("login");
    });
    const button = page.getByRole("button", { name: "Continue with Google" });
    await button.click();
    await page.getByText("Authentication is temporarily unavailable. Please try again.", { exact: true }).waitFor();
    await button.click();
    await page.getByText("Google sign-in is unavailable.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.calls), 2);
  } finally {
    await page.close();
  }
});

test("valid signup confirmation is shown to the author", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><div id='root'></div>",
    }));
    await page.goto("http://127.0.0.1/fixture");
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      window.fetch = async () => new Response(JSON.stringify({ message: "Check your email to confirm your account." }), { status: 200 });
      window.mount("signup");
    });
    await page.getByLabel("Name", { exact: true }).fill("Test author");
    await page.getByLabel("Email", { exact: true }).fill("author@example.test");
    await page.getByLabel("Password", { exact: true }).fill("testpassword");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await page.getByText("Check your email to confirm your account.", { exact: true }).waitFor();
  } finally {
    await page.close();
  }
});

test("valid login redirect navigates to the requested page", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><div id='root'></div>",
    }));
    await page.goto("http://127.0.0.1/fixture");
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      window.fetch = async () => new Response(JSON.stringify({ redirectTo: "/dashboard" }), { status: 200 });
      window.mount("login");
    });
    await page.getByLabel("Email", { exact: true }).fill("author@example.test");
    await page.getByLabel("Password", { exact: true }).fill("testpassword");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("http://127.0.0.1/dashboard");
  } finally {
    await page.close();
  }
});

test("valid Google HTTPS redirect begins navigation", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><div id='root'></div>",
    }));
    await page.goto("http://127.0.0.1/fixture");
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      window.fetch = async () => new Response(JSON.stringify({ redirectTo: "https://oauth.example.test/authorize" }), { status: 200 });
      window.mount("login");
    });
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.waitForURL("https://oauth.example.test/authorize");
  } finally {
    await page.close();
  }
});
