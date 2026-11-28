/** Disposable local PostgreSQL 16 catalog smoke; no app/hosted DB is accessed.
 * Set BOOKWORM_CATALOG_PG_BIN to the exact PostgreSQL bin directory to opt in.
 * The randomly credentialed, loopback-only cluster is stopped in finally.
 * Its synthetic data directory is retained under the OS temp directory.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { customerAiCatalogSnapshotSql as sql } from "../../services/api/src/lib/customer-ai-catalog-snapshot.ts";

const bin = process.env.BOOKWORM_CATALOG_PG_BIN;
const enabled = typeof bin === "string" && bin.length > 0;
const extension = process.platform === "win32" ? ".exe" : "";
const command = (name) => join(resolve(bin), name + extension);
const cleanEnv = Object.fromEntries(["PATH","SystemRoot","WINDIR","TEMP","TMP","USERPROFILE"].filter(k => process.env[k]).map(k => [k,process.env[k]]));

function run(binary, args, env, input) {
  const result = spawnSync(binary, args, { input, env, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${binary} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
// On Windows postgres can inherit pg_ctl's pipe handles. Use a real file for
// control output so a successfully started server cannot keep spawnSync open.
function control(args, logFile, allowNotRunning = false) {
  const fd = openSync(logFile,"a");
  try {
    const result = spawnSync(command("pg_ctl"),args,{env:cleanEnv,stdio:["ignore",fd,fd],timeout:30000,windowsHide:true});
    if (result.error || (result.status !== 0 && !(allowNotRunning && result.status === 3)))
      throw new Error(`Disposable PostgreSQL control failed: ${result.error?.message ?? result.status}`);
    return result.status;
  } finally { closeSync(fd); }
}
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",resolve); });
  const port = server.address().port;
  await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test("native PG16 captures SET-only grants and security catalog drift", { skip: !enabled, timeout: 120000 }, async () => {
  for (const name of ["initdb","pg_ctl","psql"]) assert(existsSync(command(name)), `PostgreSQL binary ${name} missing`);
  const base = mkdtempSync(join(tmpdir(),"bookworm-customer-catalog-native-"));
  const data = join(base,"data"), log = join(base,"postgres.log"), pwfile = join(base,"synthetic-password");
  const password = randomBytes(24).toString("base64url");
  writeFileSync(pwfile,password+"\n",{flag:"wx",mode:0o600});
  const port = await unusedPort();
  let mayHaveStarted = false;
  try {
    run(command("initdb"),["-D",data,"-U","bookworm_catalog_ci","--no-locale","--encoding=UTF8",
      "--auth-host=scram-sha-256","--auth-local=scram-sha-256","--pwfile",pwfile],cleanEnv);
    unlinkSync(pwfile);
    mayHaveStarted = true;
    control(["-D",data,"-l",log,"-o",`-h 127.0.0.1 -p ${port}`,"-w","start"],join(base,"control.log"));
    const env = {...cleanEnv,PGHOST:"127.0.0.1",PGPORT:String(port),PGUSER:"bookworm_catalog_ci",
      PGPASSWORD:password,PGDATABASE:"postgres",PGCONNECT_TIMEOUT:"5",PGSSLMODE:"disable",
      PGOPTIONS:"-c statement_timeout=15000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=20000"};
    const query = text => run(command("psql"),["-X","-qAt","-v","ON_ERROR_STOP=1"],env,text);
    assert.match(query("SHOW server_version_num;"),/^16\d{4}$/u,"this native test specifically verifies PostgreSQL 16");
    query(`
      CREATE ROLE fixture_owner;
      CREATE ROLE fixture_login NOINHERIT;
      CREATE ROLE fixture_delegate NOINHERIT;
      GRANT fixture_delegate TO fixture_login WITH INHERIT FALSE, SET TRUE;
      CREATE SCHEMA fixture_catalog AUTHORIZATION fixture_owner;
      CREATE TYPE fixture_catalog.access_level AS ENUM ('synthetic-private-default','other');
      REVOKE ALL ON TYPE fixture_catalog.access_level FROM PUBLIC;
      CREATE DOMAIN fixture_catalog.label AS text DEFAULT 'synthetic-private-default' CONSTRAINT label_nonempty CHECK (length(VALUE)>0);
      CREATE TABLE fixture_catalog.items(id integer NOT NULL, content text DEFAULT 'synthetic-private-default');
      ALTER TABLE fixture_catalog.items ENABLE ROW LEVEL SECURITY;
      CREATE POLICY fixture_policy ON fixture_catalog.items FOR SELECT TO fixture_login USING (id > 10);
      CREATE FUNCTION fixture_catalog.can_use(p_id integer) RETURNS boolean LANGUAGE sql
        SECURITY DEFINER SET search_path=pg_catalog SET application_name='synthetic-private-default' AS 'SELECT p_id > 10';
      CREATE FUNCTION fixture_catalog.guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
      CREATE TRIGGER fixture_guard BEFORE UPDATE ON fixture_catalog.items FOR EACH ROW EXECUTE FUNCTION fixture_catalog.guard();
      REVOKE ALL ON FUNCTION fixture_catalog.can_use(integer) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION fixture_catalog.can_use(integer) TO fixture_delegate;
      GRANT SELECT(id) ON fixture_catalog.items TO fixture_login;
    `);
    const session = "SET LOCAL search_path=pg_catalog; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO, YMD'; SET LOCAL quote_all_identifiers=off;";
    const snapshot = () => JSON.parse(query(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; ${session} ${sql} COMMIT;`));
    const baseSnapshot = snapshot();
    assert.equal(baseSnapshot.postgresMajor,16);
    assert.deepEqual(snapshot(),baseSnapshot);
    assert(!JSON.stringify(baseSnapshot).includes("synthetic-private-default"));
    if (process.env.BOOKWORM_SYNTHETIC_CATALOG_OUTPUT) {
      const target = resolve(process.env.BOOKWORM_SYNTHETIC_CATALOG_OUTPUT), path = relative(resolve(tmpdir()),target);
      assert(path && path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
      writeFileSync(target,JSON.stringify(baseSnapshot)+"\n",{flag:"wx",mode:0o600});
      console.log(JSON.stringify({syntheticCatalogFixture:target}));
    }
    const member = baseSnapshot.memberships.find(row => row.role === "fixture_delegate" && row.member === "fixture_login");
    assert.deepEqual({admin:member.admin,inherit:member.inherit,set:member.set},{admin:false,inherit:false,set:true});
    const mutate = statement => JSON.parse(query(`BEGIN ISOLATION LEVEL REPEATABLE READ; ${session} ${statement}; ${sql} ROLLBACK;`));
    for (const [label,statement] of [
      ["role SET and ADMIN","GRANT fixture_delegate TO fixture_login WITH INHERIT FALSE, SET FALSE, ADMIN TRUE"],
      ["RLS","ALTER TABLE fixture_catalog.items DISABLE ROW LEVEL SECURITY"],
      ["column ACL","GRANT UPDATE(content) ON fixture_catalog.items TO fixture_login"],
      ["default ACL","ALTER DEFAULT PRIVILEGES FOR ROLE fixture_owner GRANT SELECT ON TABLES TO fixture_login"],
      ["database ACL","GRANT CONNECT ON DATABASE postgres TO fixture_login"],
      ["database settings","ALTER DATABASE postgres SET search_path=fixture_catalog"],
      ["extension","CREATE EXTENSION citext SCHEMA fixture_catalog"],
      ["type ACL","GRANT USAGE ON TYPE fixture_catalog.access_level TO fixture_login"],
      ["enum value","ALTER TYPE fixture_catalog.access_level ADD VALUE 'third'"],
      ["domain default","ALTER DOMAIN fixture_catalog.label SET DEFAULT 'other'"],
      ["domain constraint","ALTER DOMAIN fixture_catalog.label DROP CONSTRAINT label_nonempty"],
      ["function body","CREATE OR REPLACE FUNCTION fixture_catalog.can_use(p_id integer) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT true'"],
      ["function owner","ALTER FUNCTION fixture_catalog.can_use(integer) OWNER TO fixture_owner"],
      ["function ACL","GRANT EXECUTE ON FUNCTION fixture_catalog.can_use(integer) TO PUBLIC"],
      ["policy","ALTER POLICY fixture_policy ON fixture_catalog.items USING (true)"],
      ["trigger","ALTER TABLE fixture_catalog.items DISABLE TRIGGER fixture_guard"],
      ["constraint","ALTER TABLE fixture_catalog.items ADD CONSTRAINT fixture_check CHECK (id >= 0)"],
      ["index","CREATE INDEX fixture_index ON fixture_catalog.items(id)"],
    ]) assert.notDeepEqual(mutate(statement),baseSnapshot,`${label} drift must change the actual PostgreSQL snapshot`);
    assert.deepEqual(snapshot(),baseSnapshot,"all synthetic mutations were rolled back");
    const settings = (statement) => {
      const raw = JSON.parse(query(`BEGIN; ${statement}; SELECT to_jsonb(s.setconfig) FROM pg_catalog.pg_db_role_setting s
        JOIN pg_catalog.pg_roles r ON r.oid=s.setrole WHERE r.rolname='fixture_login' AND s.setdatabase=0; ROLLBACK;`));
      const value = mutate(statement).roles.find(row => row.name === "fixture_login");
      return { naive:raw.join("\n"), digest:value.settings[0].settingsSha256 };
    };
    const one = settings("ALTER ROLE fixture_login SET application_name TO 'alpha\nclient_min_messages=warning'");
    const two = settings("ALTER ROLE fixture_login SET application_name TO 'alpha'; ALTER ROLE fixture_login SET client_min_messages TO 'warning'");
    assert.equal(one.naive,two.naive,"negative control must demonstrate delimiter ambiguity");
    assert.notEqual(one.digest,two.digest,"native settings digest must preserve array boundaries");
    console.log(JSON.stringify({nativeCatalogCluster:base,postgresMajor:16}));
  } finally {
    if (existsSync(pwfile)) unlinkSync(pwfile);
    if (mayHaveStarted && control(["-D",data,"status"],join(base,"control.log"),true) === 0)
      control(["-D",data,"-m","fast","-w","stop"],join(base,"control.log"));
  }
});
