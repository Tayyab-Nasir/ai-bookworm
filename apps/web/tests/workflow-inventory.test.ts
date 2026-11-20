import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const inventory = readFileSync(resolve(root, "docs/WEB_STATE_MACHINES.md"), "utf8");
const anchors = new Set(Array.from(inventory.matchAll(/`([^`\r\n]+)`/g), match => match[1]));

test("the workflow inventory indexes each Next.js page and route handler", () => {
  const entryPointTable = inventory.split("## Web entry points")[1]?.split("\n## ")[0];
  assert(entryPointTable, "Restore the web entry point table in docs/WEB_STATE_MACHINES.md");
  const directory = "apps/web/app";
  const files = readdirSync(resolve(root, directory), { recursive: true, encoding: "utf8" });
  const entryPoints = files.filter(file => /(?:^|[/\\])(?:page|route)\.[jt]sx?$/.test(file))
    .map(file => `${directory}/${file.replaceAll(sep, "/")}`);
  assert(entryPoints.length > 0);
  const undocumented = entryPoints.filter(file => !entryPointTable.includes(`\`${file}\``));
  assert.deepEqual(undocumented, [], "Map new pages and handlers in the web entry point table");
});

test("the workflow inventory indexes registered API routes and shared-module registrars", () => {
  const appPath = "services/api/src/app.ts";
  const app = ts.createSourceFile(appPath, readFileSync(resolve(root, appPath), "utf8"), ts.ScriptTarget.Latest, true);
  const imported = new Map<string, string>();
  for (const statement of app.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const path = statement.moduleSpecifier.text;
    const names = statement.importClause?.namedBindings;
    if (!path.startsWith("./routes/") || !names || !ts.isNamedImports(names)) continue;
    for (const name of names.elements) imported.set(name.name.text, `services/api/src/${path.slice(2).replace(/\.js$/, ".ts")}`);
  }

  const registered = new Map<string, Set<string>>();
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const path = imported.get(name);
      if (path) {
        const names = registered.get(path) ?? new Set<string>();
        names.add(name);
        registered.set(path, names);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(app);
  assert(registered.has("services/api/src/routes/health.ts"));
  const undocumented: string[] = [];
  for (const [path, names] of registered) {
    if (!anchors.has(path)) undocumented.push(path);
    if (names.size > 1) {
      for (const name of names) if (!anchors.has(name)) undocumented.push(`${path} (${name})`);
    }
  }
  assert.deepEqual(undocumented, [], "Map each route module and shared-module registrar to its workflow");
});

test("the worker inventory matches launcher role names, entry points and modes", () => {
  const { workers } = JSON.parse(execFileSync(process.execPath, ["workers/run.mjs", "--list"], { cwd: root, encoding: "utf8" }));
  const table = inventory.split("## Worker roles")[1]?.split("\n## ")[0];
  assert(table, "Restore the worker role table in docs/WEB_STATE_MACHINES.md");
  const rows = Array.from(table.matchAll(/^\| `([^`]+)` \| ([^|]+) \|/gm), ([, role, mode]) => [
    role,
    Array.from(mode.matchAll(/`([^`]+)`/g), match => match[1]),
  ] as const);
  const documented = Object.fromEntries(rows);
  assert.equal(new Set(rows.map(([role]) => role)).size, rows.length, "Each role has one inventory row");
  assert.deepEqual(documented, workers, "Update the worker role table when the launcher changes");
});

test("the workflow inventory source and test anchors exist", () => {
  const paths = [...anchors].filter(anchor => /^(apps|docs|packages|services|scripts|supabase|tests|workers)\/\S+\.(tsx?|mjs|py|sql|md|json)$/.test(anchor));
  assert(paths.length > 0);
  assert.deepEqual(paths.filter(path => !existsSync(resolve(root, path))), [], "Correct moved or removed source anchors");
});
