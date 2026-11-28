import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

test("Google sign-in control has an explicit accessible name and visible keyboard focus", () => {
  const source = readFileSync(resolve("apps/web/components/AuthCard.tsx"), "utf8");

  assert.match(source, /aria-label="Continue with Google"/);
  assert.match(source, /focus-visible:ring-2 focus-visible:ring-white/);
  assert.match(source, /errorAction === "google"[\s\S]*?role="alert"/);
  assert.match(source, />Continue with Google</);
});
