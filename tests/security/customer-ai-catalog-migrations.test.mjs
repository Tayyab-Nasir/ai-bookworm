/** Apply only local synthetic migrations in an in-memory DB. Never load .env. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { customerAiCatalogSnapshotSql as sql } from "../../services/api/src/lib/customer-ai-catalog-snapshot.ts";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("collector handles the actual committed migration catalog", { timeout: 120000 }, async () => {
  const root = new URL("../../", import.meta.url);
  const db = new PGlite({ extensions: { citext, pgcrypto } });
  try {
    // Git stores these migrations as LF. Windows checkout CRLF changes SQL
    // function body bytes and breaks migrations that guard their own source.
    const canonical = value => value.replace(/\r\n/g,"\n");
    await db.exec(canonical(await readFile(new URL("tests/security/local-supabase-fixture.sql",root),"utf8")));
    const directory = new URL("supabase/migrations/",root);
    const migrations = (await readdir(directory)).filter(name => name.endsWith(".sql")).sort();
    assert(migrations.length >= 100);
    for (const name of migrations) await db.exec(`BEGIN;\n${canonical(await readFile(new URL(name,directory),"utf8"))}\nCOMMIT;`);
    await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=pg_catalog; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO, YMD'; SET LOCAL quote_all_identifiers=off");
    let catalog;
    try {
      const result = await db.query(sql);
      assert.equal(result.rows.length,1);
      catalog = result.rows[0].catalog;
    } finally { await db.exec("ROLLBACK"); }
    assert.equal(catalog.catalogFormat,"customer-ai-catalog-v1");
    assert(catalog.postgresMajor >= 16);
    const protectedTable = catalog.relations.find(item => item.schema === "bookworm_credentials" && item.name === "customer_ai_jobs");
    assert.equal(protectedTable?.rowSecurity,true);
    assert(protectedTable.columns.some(item => item.name === "credential_revision"));
    const request = catalog.functions.find(item => item.schema === "public" && item.identity.startsWith("prepare_customer_ai_request("));
    assert.equal(request?.securityDefiner,true);
    assert.match(request.definitionSha256,/^[a-f0-9]{64}$/u);
    assert(request.configSha256?.every(item => /^[a-f0-9]{64}$/u.test(item)));
    assert(catalog.extensions.some(item => item.name === "pgcrypto"));
    // Counts only: never dump operational catalog metadata into CI logs.
    console.log(JSON.stringify({ syntheticMigrations:migrations.length, roles:catalog.roles.length,
      relations:catalog.relations.length, functions:catalog.functions.length }));
  } finally { await db.close(); }
});
