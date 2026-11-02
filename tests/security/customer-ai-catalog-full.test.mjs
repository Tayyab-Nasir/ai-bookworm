/** Real application migrations in disposable PostgreSQL/WASM only. No .env or
 * network database connection. This is a size/compatibility check, not a
 * trusted manifest, semantic proof or Supabase production acceptance. */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { test } from "node:test";
import { canonicalCustomerCatalogJson as canonical, customerAiCatalogEvidenceVerifier } from "../../services/api/src/lib/customer-ai-catalog-evidence.ts";
import { customerAiCatalogSnapshotSql as sql } from "../../services/api/src/lib/customer-ai-catalog-snapshot.ts";

test("full disposable migration catalog fits the verifier and can be compared without enabling readiness", { timeout: 120000 }, async () => {
  const db = new PGlite({ extensions: { citext, pgcrypto } });
  try {
    // Git stores migrations with LF; Windows checkout CRLF changes literal
    // migration bodies that verify their own definition before replacement.
    const lf = value => value.replace(/\r\n/g, "\n");
    await db.exec(lf(await readFile(new URL("./local-supabase-fixture.sql", import.meta.url), "utf8")));
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    const migrations = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
    for (const file of migrations) {
      const body = lf(await readFile(new URL(file, directory), "utf8"));
      await db.exec(`begin;\n${body}\ncommit;`);
    }
    await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=pg_catalog; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO, YMD'; SET LOCAL quote_all_identifiers=off");
    let rows;
    try { rows = (await db.query(sql)).rows; } finally { await db.exec("ROLLBACK"); }
    assert.equal(rows.length, 1);
    const catalog = rows[0].catalog, bytes = Buffer.byteLength(canonical(catalog));
    const authority = catalog.relations.find(item => item.schema === "bookworm_credentials" && item.name === "customer_ai_jobs");
    assert.equal(authority?.rowSecurity, true);
    assert(authority.columns.some(item => item.name === "credential_revision"));
    const prepare = catalog.functions.find(item => item.schema === "public" && item.identity.startsWith("prepare_customer_ai_request("));
    assert.equal(prepare?.securityDefiner, true);
    assert.match(prepare.definitionSha256, /^[a-f0-9]{64}$/u);
    assert(catalog.extensions.some(item => item.name === "pgcrypto"));
    assert(bytes < 2 * 1024 * 1024, "the disposable complete migration catalog exceeded the bounded evidence size");
    const keys = generateKeyPairSync("ed25519"), now = Date.now();
    const expected = { auditorId:"fixture-auditor",keyId:"fixture-key",deploymentId:"fixture-deployment",
      projectRef:"fixture-project",schemaRevision:"fixture-schema" };
    const verifier = customerAiCatalogEvidenceVerifier({ expected, expectedCatalog:catalog, verificationKey:keys.publicKey,
      mode:"test",_testClock:()=>({wall:now,monotonic:1000}) });
    const challenge = verifier.challenge();
    const body = {...challenge,observedAt:now,expiresAt:now+4000,catalog};
    const signature = sign(null,Buffer.from("bookworm-customer-ai-catalog-evidence-v1\n"+canonical(body)),keys.privateKey).toString("hex");
    const evidence = canonical({...body,signature});
    assert(Buffer.byteLength(evidence) < 2 * 1024 * 1024);
    assert.equal(verifier.verify(challenge,evidence).kind,"matched_catalog_observation");
    verifier.dispose();
    console.log(JSON.stringify({fixture:"full-disposable-migrations",migrations:migrations.length,postgresMajor:catalog.postgresMajor,catalogBytes:bytes,evidenceBytes:Buffer.byteLength(evidence)}));
  } finally { await db.close(); }
});
