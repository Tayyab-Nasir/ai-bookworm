/** Synthetic catalog collection only. Never connects to a hosted database. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { customerAiCatalogSnapshotSql as sql } from "../../services/api/src/lib/customer-ai-catalog-snapshot.ts";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";

const sourceSentinel = "private_source_sentinel_never_emit";
const schema = "catalog_fixture";

test("catalog inventory observes actual roles, grants, definitions and policy drift without exposing function text", async () => {
  const db = new PGlite({ extensions: { citext } });
  try {
    await db.exec("SET search_path=pg_catalog; SET TIME ZONE 'UTC'; SET DateStyle='ISO, YMD'; SET quote_all_identifiers=off");
    await db.exec(`
      CREATE ROLE catalog_fixture_owner;
      CREATE ROLE catalog_fixture_login NOINHERIT;
      CREATE ROLE catalog_fixture_delegate NOINHERIT;
      GRANT catalog_fixture_delegate TO catalog_fixture_login WITH INHERIT FALSE, SET TRUE;
      CREATE SCHEMA catalog_fixture AUTHORIZATION catalog_fixture_owner;
      CREATE TYPE catalog_fixture.access_level AS ENUM ('${sourceSentinel}','other');
      REVOKE ALL ON TYPE catalog_fixture.access_level FROM PUBLIC;
      CREATE DOMAIN catalog_fixture.label AS text DEFAULT '${sourceSentinel}' CONSTRAINT label_nonempty CHECK (length(VALUE)>0);
      CREATE TABLE catalog_fixture.private_data (id integer NOT NULL, secret text DEFAULT '${sourceSentinel}');
      ALTER TABLE catalog_fixture.private_data ENABLE ROW LEVEL SECURITY;
      CREATE POLICY fixture_policy ON catalog_fixture.private_data FOR SELECT TO catalog_fixture_login USING (id > 10);
      CREATE FUNCTION catalog_fixture.authorize(p_id integer) RETURNS boolean
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog SET application_name='${sourceSentinel}' AS 'SELECT p_id > 10';
      CREATE FUNCTION catalog_fixture.guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
      CREATE TRIGGER fixture_guard BEFORE UPDATE ON catalog_fixture.private_data
        FOR EACH ROW EXECUTE FUNCTION catalog_fixture.guard();
      REVOKE ALL ON FUNCTION catalog_fixture.authorize(integer) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION catalog_fixture.authorize(integer) TO catalog_fixture_delegate;
      GRANT SELECT (id) ON catalog_fixture.private_data TO catalog_fixture_login;
    `);
    const snapshot = async () => {
      const result = await db.query(sql);
      assert.equal(result.rows.length, 1);
      return result.rows[0].catalog;
    };
    const base = await snapshot();
    assert.equal(base.catalogFormat, "customer-ai-catalog-v1");
    assert(base.postgresMajor >= 16);
    assert.deepEqual(await snapshot(), base, "an unchanged catalog must serialize identically");
    await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try { assert.deepEqual(await snapshot(), base, "collection must work within a read-only snapshot"); }
    finally { await db.exec("ROLLBACK"); }
    assert(!JSON.stringify(base).includes(sourceSentinel), "function/default expressions must not be emitted as plaintext");
    // Opt-in output is an exclusively created synthetic fixture under the OS
    // temp root; this test never reads real database connection settings.
    if (process.env.BOOKWORM_SYNTHETIC_CATALOG_OUTPUT) {
      const root = resolve(tmpdir()), target = resolve(process.env.BOOKWORM_SYNTHETIC_CATALOG_OUTPUT);
      const path = relative(root, target);
      assert(path && path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
      await writeFile(target, JSON.stringify(base) + "\n", { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ syntheticCatalogFixture: target }));
    }
    const member = base.memberships.find(row => row.role === "catalog_fixture_delegate" && row.member === "catalog_fixture_login");
    assert.deepEqual({ admin: member.admin, inherit: member.inherit, set: member.set }, { admin: false, inherit: false, set: true });
    const relation = base.relations.find(row => row.schema === schema && row.name === "private_data");
    assert.equal(relation.rowSecurity, true);
    assert.equal(relation.columns.find(column => column.name === "id").notNull, true);
    assert.equal(relation.policies[0].name, "fixture_policy");
    assert.equal(relation.triggers[0].name, "fixture_guard");
    const fn = base.functions.find(row => row.schema === schema && row.identity.startsWith("authorize("));
    assert.equal(fn.securityDefiner, true);
    assert.match(fn.definitionSha256, /^[a-f0-9]{64}$/u);
    assert(fn.configSha256.length > 1 && fn.configSha256.every(value => /^[a-f0-9]{64}$/u.test(value)));
    const type = base.types.find(row => row.schema === schema && row.name === "access_level");
    assert.equal(type.kind,"e");
    assert.match(type.enumLabelsSha256,/^[a-f0-9]{64}$/u);
    const domain = base.types.find(row => row.schema === schema && row.name === "label");
    assert.match(domain.defaultSha256,/^[a-f0-9]{64}$/u);
    assert.equal(domain.domainConstraints[0].name,"label_nonempty");

    for (const [label, mutation] of [
      ["row security", "ALTER TABLE catalog_fixture.private_data DISABLE ROW LEVEL SECURITY"],
      ["column grant", "GRANT UPDATE (secret) ON catalog_fixture.private_data TO catalog_fixture_login"],
      ["table grant", "GRANT SELECT ON catalog_fixture.private_data TO catalog_fixture_login"],
      ["role bypass", "ALTER ROLE catalog_fixture_login BYPASSRLS"],
      ["role membership", "GRANT catalog_fixture_delegate TO catalog_fixture_login WITH INHERIT FALSE, SET FALSE, ADMIN TRUE"],
      ["default privileges", "ALTER DEFAULT PRIVILEGES FOR ROLE catalog_fixture_owner GRANT SELECT ON TABLES TO catalog_fixture_login"],
      ["role setting", "ALTER ROLE catalog_fixture_login SET search_path = catalog_fixture"],
      ["database grant", "GRANT CONNECT ON DATABASE postgres TO catalog_fixture_login"],
      ["database setting", "ALTER DATABASE postgres SET search_path = catalog_fixture"],
      ["extension install", "CREATE EXTENSION citext SCHEMA catalog_fixture"],
      ["schema grant", "GRANT CREATE ON SCHEMA catalog_fixture TO catalog_fixture_login"],
      ["type ACL", "GRANT USAGE ON TYPE catalog_fixture.access_level TO catalog_fixture_login"],
      ["enum value", "ALTER TYPE catalog_fixture.access_level ADD VALUE 'third'"],
      ["domain default", "ALTER DOMAIN catalog_fixture.label SET DEFAULT 'other'"],
      ["domain constraint", "ALTER DOMAIN catalog_fixture.label DROP CONSTRAINT label_nonempty"],
      ["function grant", "GRANT EXECUTE ON FUNCTION catalog_fixture.authorize(integer) TO PUBLIC"],
      ["function body", "CREATE OR REPLACE FUNCTION catalog_fixture.authorize(p_id integer) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT true'"],
      ["function owner", "ALTER FUNCTION catalog_fixture.authorize(integer) OWNER TO catalog_fixture_owner"],
      ["search path", "ALTER FUNCTION catalog_fixture.authorize(integer) SET search_path=public"],
      ["policy expression", "ALTER POLICY fixture_policy ON catalog_fixture.private_data USING (true)"],
      ["trigger state", "ALTER TABLE catalog_fixture.private_data DISABLE TRIGGER fixture_guard"],
      ["index definition", "CREATE INDEX fixture_index ON catalog_fixture.private_data (id)"],
      ["constraint definition", "ALTER TABLE catalog_fixture.private_data ADD CONSTRAINT fixture_check CHECK (id >= 0)"],
    ]) {
      await db.exec("BEGIN; SAVEPOINT catalog_drift");
      try {
        await db.exec(mutation);
        const changed = await snapshot();
        assert.notDeepEqual(changed, base, `${label} drift must alter the catalog snapshot`);
        await db.exec("ROLLBACK TO SAVEPOINT catalog_drift");
      } finally { await db.exec("ROLLBACK"); }
      assert.deepEqual(await snapshot(), base, `${label} rollback must restore the snapshot`);
    }
    // Joining array values on a delimiter is ambiguous when an element can
    // itself contain the delimiter. JSON-array hashing preserves boundaries.
    async function roleSettings(statements) {
      await db.exec("BEGIN");
      try {
        await db.exec(statements);
        const result = await db.query(`SELECT s.setconfig FROM pg_catalog.pg_db_role_setting s
          JOIN pg_catalog.pg_roles r ON r.oid=s.setrole WHERE r.rolname='catalog_fixture_login' AND s.setdatabase=0`);
        const settings = result.rows[0].setconfig;
        const observed = (await snapshot()).roles.find(row => row.name === "catalog_fixture_login");
        return { naive: settings.join("\n"), digest: observed.settings[0].settingsSha256 };
      } finally { await db.exec("ROLLBACK"); }
    }
    const oneValue = await roleSettings("ALTER ROLE catalog_fixture_login SET application_name TO 'alpha\nclient_min_messages=warning'");
    const twoValues = await roleSettings("ALTER ROLE catalog_fixture_login SET application_name TO 'alpha'; ALTER ROLE catalog_fixture_login SET client_min_messages TO 'warning'");
    assert.equal(oneValue.naive,twoValues.naive,"negative control must demonstrate the naive delimiter collision");
    assert.notEqual(oneValue.digest,twoValues.digest,"the catalog hash must preserve array element boundaries");
  } finally { await db.close(); }
});
