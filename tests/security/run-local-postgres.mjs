/**
 * Execute the real migrations and SQL assertions in disposable PostgreSQL/WASM.
 * No connection string, .env, network server, or existing database is used.
 * Supabase auth/storage service schemas are minimal fixtures, not those services.
 */
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const db = new PGlite({ extensions: { citext, pgcrypto } });
let currentFile = "local Supabase schema fixture";
try {
  await db.exec(await readFile(join(root, "tests/security/local-supabase-fixture.sql"), "utf8"));
  const migrations = (await readdir(join(root, "supabase/migrations"))).filter((f) => f.endsWith(".sql")).sort();
  for (const file of migrations) {
    currentFile = `supabase/migrations/${file}`;
    // Same atomic migration boundary as the CLI; SQL failures abort the run.
    await db.exec(`begin;\n${await readFile(join(root, currentFile), "utf8")}\ncommit;`);
    console.log(`PASS migration ${file}`);
  }
  const tests = (await readdir(join(root, "tests/security"))).filter((f) => f.endsWith(".test.sql")).sort();
  for (const file of tests) {
    currentFile = `tests/security/${file}`;
    await db.exec(await readFile(join(root, currentFile), "utf8"));
    console.log(`PASS SQL assertions ${file}`);
  }
  console.log(`Executed ${migrations.length} migrations and ${tests.length} SQL assertion files in disposable PostgreSQL.`);
  console.log("Not covered: GoTrue, PostgREST, Storage HTTP, native Supabase configuration, or multi-connection races.");
} catch (error) {
  console.error(`FAIL ${currentFile}: ${error.message}`);
  if (error.detail) console.error(error.detail);
  if (error.where) console.error(error.where);
  process.exitCode = 1;
} finally {
  await db.close();
}
