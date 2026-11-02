/**
 * Unregistered, explicitly invoked PostgreSQL catalog collector. TLS endpoint,
 * cluster identifier and role are checked against a separately provisioned
 * operator binding before signing. This authenticates the connection under its
 * trust assumptions; it does not prove catalog completeness, semantics, ACL
 * safety, worker/provider readiness or an entitlement. Never turn its result
 * into aclVerified without an independent review and full readiness design.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, sign, type KeyObject } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { canonicalCustomerCatalogJson, canonicalCustomerCatalogSnapshot } from "./customer-ai-catalog-evidence.js";
import { customerAiCatalogSnapshotSql } from "./customer-ai-catalog-snapshot.js";

const sqlSha256 = "cd8968cbee936d45f1f87abfa6b4084b57fa22dd3fb231ca3a0bd5d72310cff4";
const domain = "bookworm-customer-ai-catalog-evidence-v1";
const unavailable = () => new Error("Customer AI catalog collection is unavailable.");
const bindingValue = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u);
const scopeSchema = z.object({ auditorId: bindingValue, keyId: bindingValue, deploymentId: bindingValue,
  projectRef: bindingValue, schemaRevision: bindingValue }).strict();
const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u).refine(value =>
  Buffer.from(value, "base64url").length === 32 && Buffer.from(value, "base64url").toString("base64url") === value);
const challengeSchema = scopeSchema.extend({ version: z.literal(1), nonce: nonceSchema }).strict();
const hostname = z.string().min(1).max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u)
  .refine(value => !value.includes("..") && value.split(".").every(part => part.length <= 63));
const dbName = z.string().min(1).max(63).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/u);
const endpointSchema = z.object({ host: hostname, port: z.number().int().min(1).max(65535), database: dbName, user: dbName }).strict();
const trustedBindingSchema = endpointSchema.extend({ projectRef: bindingValue,
  systemIdentifier: z.string().regex(/^[1-9][0-9]{0,19}$/u) }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const identitySchema = z.object({
  database: dbName, sessionUser: dbName, currentUser: dbName, systemIdentifier: z.string().regex(/^[1-9][0-9]{0,19}$/u),
  tls: z.literal(true), transactionReadOnly: z.literal("on"), transactionIsolation: z.literal("repeatable read"),
  superuser: z.literal(false), bypassRls: z.literal(false), createRole: z.literal(false), createDb: z.literal(false),
  replication: z.literal(false), canLogin: z.literal(true), hasMembership: z.literal(false),
}).strict();
const outputSchema = z.object({ identity: identitySchema, catalog: z.unknown() }).strict();
type Scope = z.infer<typeof scopeSchema>;
type Endpoint = z.infer<typeof endpointSchema>;
type Binding = z.infer<typeof trustedBindingSchema>;
const bytesLimit = 2 * 1024 * 1024;
const stderrLimit = 16 * 1024;

async function checkedFile(path: string, digest: string, maximum: number, signal: AbortSignal): Promise<void> {
  if (!isAbsolute(path) || !hash.safeParse(digest).success) throw unavailable();
  const info = await new Promise<Awaited<ReturnType<typeof lstat>>>((resolve, reject) => {
    const abort = () => reject(unavailable());
    if (signal.aborted) { reject(unavailable()); return; }
    signal.addEventListener("abort", abort, { once: true });
    lstat(path).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
  signal.throwIfAborted();
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) throw unavailable();
  const bytes = await readFile(path, { signal });
  if (bytes.length !== info.size || createHash("sha256").update(bytes).digest("hex") !== digest) throw unavailable();
}

/** A process is killed on timeout, cancellation, excess output or input failure.
 * Its stderr is bounded and discarded. No command, environment or server error
 * is surfaced. No shell, retry, application credential or ambient PG variable. */
function invokePsql(path: string, env: Record<string, string>, sql: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(unavailable()); return; }
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(path, ["-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1"], {
      env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    }); } catch { reject(unavailable()); return; }
    const stdout: Buffer[] = []; let size = 0, errorSize = 0, failed = false, completed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { signal.removeEventListener("abort", abort); if (killTimer) clearTimeout(killTimer); };
    const finish = (ok: boolean) => {
      if (completed) return;
      completed = true; cleanup();
      if (!ok || failed || signal.aborted) { reject(unavailable()); return; }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    };
    const abort = () => {
      if (completed) return;
      failed = true;
      child.kill("SIGKILL");
      // Do not keep the caller hanging if a broken process does not emit close.
      killTimer ??= setTimeout(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(false); }, 500);
      killTimer.unref();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("error", () => finish(false));
    child.stdin.once("error", abort);
    child.stdout.on("data", (part: Buffer) => {
      size += part.length; if (size > bytesLimit) { abort(); return; } stdout.push(part);
    });
    child.stderr.on("data", (part: Buffer) => { errorSize += part.length; if (errorSize > stderrLimit) abort(); });
    child.once("close", code => finish(code === 0));
    child.stdin.end(sql);
  });
}

/**
 * All configuration is trusted operator input. The endpoint and binding must
 * be supplied separately; binding is an operator-reviewed project-to-cluster
 * map, not something discovered or asserted by the remote database. The CA
 * and psql paths and parent directories must be protected from other users and
 * same-UID processes: file hashes cannot prevent a replace-after-check race.
 * PGPASSWORD exists in the short-lived child environment and can be visible
 * to privileged/same-user processes. Do not use without host isolation.
 */
export async function collectCustomerAiCatalog(config: {
  scope: Scope; binding: Binding; endpoint: Endpoint & { password: string; caPath: string; caSha256: string };
  psqlPath: string; psqlSha256: string; signingKey: KeyObject; timeoutMs?: number;
}, challenge: unknown, signal?: AbortSignal): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const started = performance.now();
    if (!Number.isFinite(started) || started < 0) throw unavailable();
    const scope = scopeSchema.parse(config?.scope), binding = trustedBindingSchema.parse(config?.binding);
    const { password, caPath, caSha256, ...endpointInput } = config?.endpoint ?? {};
    const endpoint = endpointSchema.parse(endpointInput), requested = challengeSchema.parse(challenge);
    if (Object.keys(scope).some(key => scope[key as keyof Scope] !== requested[key as keyof Scope])
      || binding.projectRef !== scope.projectRef || endpoint.host !== binding.host || endpoint.port !== binding.port
      || endpoint.database !== binding.database || endpoint.user !== binding.user
      || typeof password !== "string" || !/^[\x21-\x7e]{16,4096}$/u.test(password)
      || typeof caPath !== "string" || typeof caSha256 !== "string" || typeof config.psqlPath !== "string"
      || !hash.safeParse(config.psqlSha256).success || !config.signingKey || config.signingKey.type !== "private"
      || config.signingKey.asymmetricKeyType !== "ed25519"
      || (signal !== undefined && !(signal instanceof AbortSignal))) throw unavailable();
    const timeoutMs = config.timeoutMs ?? 4000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 4000) throw unavailable();
    timeout = setTimeout(() => controller.abort(), timeoutMs); timeout.unref();
    const deadline = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const checkDeadline = () => {
      deadline.throwIfAborted();
      const now = performance.now();
      if (!Number.isFinite(now) || now < started || now - started >= timeoutMs) throw unavailable();
    };
    checkDeadline();
    await Promise.all([
      checkedFile(config.psqlPath, config.psqlSha256, 64 * 1024 * 1024, deadline),
      checkedFile(caPath, caSha256, 128 * 1024, deadline),
    ]);
    checkDeadline();
    const query = customerAiCatalogSnapshotSql.replace(/\r\n/g, "\n");
    if (createHash("sha256").update(query, "utf8").digest("hex") !== sqlSha256 || /^\s*\\/mu.test(query)) throw unavailable();
    checkDeadline();
    const inner = query.replace(/;\s*$/u, "");
    const statement = `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '3500ms';
SET LOCAL lock_timeout = '1500ms';
SET LOCAL search_path = pg_catalog;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL quote_all_identifiers = off;
SELECT jsonb_build_object('identity', (
  SELECT jsonb_build_object(
    'database',current_database(),'sessionUser',session_user::text,'currentUser',current_user::text,
    'systemIdentifier',(SELECT system_identifier::text FROM pg_catalog.pg_control_system()),
    'tls',(SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()),
    'transactionReadOnly',current_setting('transaction_read_only'),
    'transactionIsolation',current_setting('transaction_isolation'),
    'superuser',r.rolsuper,'bypassRls',r.rolbypassrls,'createRole',r.rolcreaterole,'createDb',r.rolcreatedb,
    'replication',r.rolreplication,'canLogin',r.rolcanlogin,
    'hasMembership',EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid))
  FROM pg_catalog.pg_roles r WHERE r.rolname=session_user
), 'catalog', (SELECT collected.catalog FROM (${inner}) AS collected));
COMMIT;
`;
    const env: Record<string, string> = {};
    for (const variable of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[variable]) env[variable] = process.env[variable]!;
    Object.assign(env, {
      PGHOST: endpoint.host, PGPORT: String(endpoint.port), PGDATABASE: endpoint.database, PGUSER: endpoint.user,
      PGPASSWORD: password, PGSSLMODE: "verify-full", PGSSLROOTCERT: caPath, PGGSSENCMODE: "disable",
      PGCONNECT_TIMEOUT: "3", PGAPPNAME: "bookworm-catalog-auditor", PGCLIENTENCODING: "UTF8",
      PGPASSFILE: process.platform === "win32" ? "NUL" : "/dev/null",
    });
    const raw = await invokePsql(config.psqlPath, env, statement, deadline);
    checkDeadline();
    const decoded: unknown = JSON.parse(raw);
    checkDeadline();
    const output = outputSchema.parse(decoded);
    checkDeadline();
    if (output.identity.database !== binding.database || output.identity.sessionUser !== binding.user
      || output.identity.currentUser !== binding.user || output.identity.systemIdentifier !== binding.systemIdentifier) throw unavailable();
    const catalog = JSON.parse(canonicalCustomerCatalogSnapshot(output.catalog));
    checkDeadline();
    const observedAt = Date.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw unavailable();
    const payload = { ...requested, observedAt, expiresAt: observedAt + 4000, catalog };
    const signed = Buffer.from(domain + "\n" + canonicalCustomerCatalogJson(payload), "utf8");
    checkDeadline();
    const signature = sign(null, signed, config.signingKey).toString("hex");
    checkDeadline();
    const result = canonicalCustomerCatalogJson({ ...payload, signature });
    checkDeadline();
    return result;
  } catch { throw unavailable(); }
  finally { if (timeout) clearTimeout(timeout); controller.abort(); }
}
