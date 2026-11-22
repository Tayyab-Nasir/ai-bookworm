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
  for (const invalid of ["html", "null", "array"]) {
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
              const value = invalid === "html" ? "<html>Gateway error</html>" : invalid === "null" ? "null" : "[]";
              return new Response(value, { status: invalid === "null" ? 200 : 502 });
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
