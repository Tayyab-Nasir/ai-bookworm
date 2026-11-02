/**
 * Unregistered catalog-evidence comparison. A match only authenticates the
 * auditor's statement and compares its snapshot to a separately trusted
 * manifest. It does not attest database identity, collection completeness,
 * function semantics, future state, worker/provider readiness or entitlements.
 *
 * No production collector, network listener, environment flag or readiness
 * gate is installed by this module. Never promote a match to aclVerified
 * without independent collector/identity and manifest assurance.
 */
import { createHash, createPublicKey, randomBytes, verify as verifySignature, type KeyObject } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";

const domain = "bookworm-customer-ai-catalog-evidence-v1";
const unavailable = () => new Error("Customer AI catalog evidence is unavailable.");
const binding = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u);
const time = z.number().int().nonnegative().safe();
const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const envelope = z.object({
  version: z.literal(1), auditorId: binding, keyId: binding, deploymentId: binding,
  projectRef: binding, schemaRevision: binding, nonce: nonceSchema,
  observedAt: time, expiresAt: time, catalog: z.unknown(), signature: z.string().regex(/^[a-f0-9]{128}$/u),
}).strict();
const name = z.string().min(1).max(1024);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const acl = z.array(z.string().min(1).max(4096)).max(16384).nullable();
const defaultPrivilege = z.object({ schema: name.nullable(), kind: z.string().length(1),
  acl: z.array(z.string().min(1).max(4096)).max(16384) }).strict();
const roleSetting = z.object({ database: name.nullable(), settingsSha256: digest }).strict();
const role = z.object({
  name, superuser: z.boolean(), inherit: z.boolean(), createRole: z.boolean(), createDb: z.boolean(),
  canLogin: z.boolean(), replication: z.boolean(), bypassRls: z.boolean(),
  connectionLimit: z.number().int().min(-1).max(2_147_483_647), validUntil: z.string().max(100).nullable(),
  defaultPrivileges: z.array(defaultPrivilege).max(16384), settings: z.array(roleSetting).max(16384),
}).strict();
const membership = z.object({ role: name, member: name, grantor: name, admin: z.boolean(), inherit: z.boolean(), set: z.boolean() }).strict();
const database = z.object({
  name, owner: name, encoding: name, collation: name, ctype: name, localeProvider: z.string().length(1),
  template: z.boolean(), allowConnections: z.boolean(), connectionLimit: z.number().int().min(-1).max(2_147_483_647),
  acl, allRolesSettingsSha256: digest.nullable(), globalAllRolesSettingsSha256: digest.nullable(),
}).strict();
const extension = z.object({ name, owner: name, schema: name, version: name, relocatable: z.boolean(),
  configurationRelations: z.array(name).max(16384), conditionSha256: digest.nullable() }).strict();
const schema = z.object({ name, owner: name, acl }).strict();
const domainConstraint = z.object({ name, validated: z.boolean(), definitionSha256: digest }).strict();
const dataType = z.object({ schema: name, name, owner: name, kind: z.string().length(1), category: z.string().length(1),
  notNull: z.boolean(), acl, baseType: name.nullable(), elementType: name.nullable(), compositeRelation: name.nullable(),
  collation: name.nullable(), defaultSha256: digest.nullable(), enumLabelsSha256: digest.nullable(),
  domainConstraints: z.array(domainConstraint).max(16384) }).strict();
const column = z.object({
  name, position: z.number().int().min(1).max(32767), type: name, notNull: z.boolean(), dropped: z.boolean(),
  identity: z.string().max(1), generated: z.string().max(1), acl, defaultSha256: digest.nullable(),
}).strict();
const policy = z.object({ name, command: z.string().length(1), permissive: z.boolean(),
  roles: z.array(name).max(4096), usingSha256: digest.nullable(), checkSha256: digest.nullable() }).strict();
const constraint = z.object({ name, type: z.string().length(1), validated: z.boolean(), definitionSha256: digest }).strict();
const index = z.object({ name, valid: z.boolean(), ready: z.boolean(), unique: z.boolean(), definitionSha256: digest }).strict();
const trigger = z.object({ name, enabled: z.string().length(1), internal: z.boolean(), function: name, definitionSha256: digest }).strict();
const relation = z.object({
  schema: name, name, kind: z.string().length(1), owner: name, rowSecurity: z.boolean(), forceRowSecurity: z.boolean(),
  options: z.array(z.string().max(4096)).max(16384).nullable(), viewSha256: digest.nullable(), acl,
  columns: z.array(column).max(32767), policies: z.array(policy).max(16384),
  constraints: z.array(constraint).max(16384), indexes: z.array(index).max(16384), triggers: z.array(trigger).max(16384),
}).strict();
const routine = z.object({
  schema: name, identity: name, kind: z.string().length(1), owner: name, securityDefiner: z.boolean(), language: name,
  volatility: z.string().length(1), parallel: z.string().length(1), strict: z.boolean(), leakproof: z.boolean(),
  configSha256: z.array(digest).max(128).nullable(), acl, definitionSha256: digest,
}).strict();
const catalogSchema = z.object({
  catalogFormat: z.literal("customer-ai-catalog-v1"), postgresMajor: z.union([z.literal(16), z.literal(17), z.literal(18)]),
  roles: z.array(role).min(1).max(4096), memberships: z.array(membership).max(16384),
  databases: z.array(database).min(1).max(4096), extensions: z.array(extension).max(4096),
  schemas: z.array(schema).min(1).max(4096), types: z.array(dataType).max(16384), relations: z.array(relation).min(1).max(16384),
  functions: z.array(routine).min(1).max(16384),
}).strict();
const scopeSchema = z.object({ auditorId: binding, keyId: binding, deploymentId: binding,
  projectRef: binding, schemaRevision: binding }).strict();
const maxBytes = 2 * 1024 * 1024;
const maxChallenges = 64;

/** Canonical JSON is the wire format; unknown fields, duplicate JSON keys and
 * alternative spellings/whitespace are rejected by canonical round-trip. */
export function canonicalCustomerCatalogJson(value: unknown): string {
  let count = 0;
  function encode(item: unknown, depth: number): string {
    if (++count > 300_000 || depth > 24) throw unavailable();
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) throw unavailable();
      return JSON.stringify(item);
    }
    if (typeof item === "string") {
      if (item.length > 32_768 || Buffer.from(item, "utf8").toString("utf8") !== item) throw unavailable();
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (item.length > 32_768 || Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertySymbols(item).length) throw unavailable();
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.keys(descriptors).length !== item.length + 1) throw unavailable();
      return `[${Array.from({ length: item.length }, (_, index) => {
        const entry = descriptors[String(index)];
        if (!entry || !entry.enumerable || !("value" in entry)) throw unavailable();
        return encode(entry.value, depth + 1);
      }).join(",")}]`;
    }
    if (typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype || Object.getOwnPropertySymbols(item).length) throw unavailable();
    const descriptors = Object.getOwnPropertyDescriptors(item), keys = Object.keys(descriptors).sort();
    if (keys.length > 128) throw unavailable();
    return `{${keys.map(key => {
      const entry = descriptors[key];
      if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key) || ["constructor", "prototype", "__proto__"].includes(key)
        || !entry.enumerable || !("value" in entry)) throw unavailable();
      return `${JSON.stringify(key)}:${encode(entry.value, depth + 1)}`;
    }).join(",")}}`;
  }
  const output = encode(value, 0);
  if (Buffer.byteLength(output, "utf8") > maxBytes) throw unavailable();
  return output;
}

function checkedCatalog(value: unknown): string {
  const parsed = catalogSchema.parse(value);
  const collections: [Record<string, unknown>[], string[]][] = [
    [parsed.roles, ["name"]], [parsed.memberships, ["role", "member", "grantor"]], [parsed.databases, ["name"]], [parsed.extensions, ["name"]],
    [parsed.schemas, ["name"]], [parsed.types, ["schema", "name"]], [parsed.relations, ["schema", "name", "kind"]],
    [parsed.functions, ["schema", "identity", "kind"]],
  ];
  for (const [rows, fields] of collections) {
    const identities = rows.map(row => canonicalCustomerCatalogJson(fields.map(field => {
      const value = row[field];
      if (typeof value !== "string" || !value || value.length > 1024) throw unavailable();
      return value;
    })));
    if (new Set(identities).size !== identities.length) throw unavailable();
  }
  return canonicalCustomerCatalogJson(parsed);
}

/** Validate and canonically encode an inventory without granting readiness. */
export function canonicalCustomerCatalogSnapshot(value: unknown): string {
  try { return checkedCatalog(value); } catch { throw unavailable(); }
}

type Scope = z.infer<typeof scopeSchema>;
type Challenge = Readonly<Scope & { version: 1; nonce: string }>;
type Clock = { wall: number; monotonic: number };
type Pending = { nonce: string; issuedAt: number; issuedMonotonic: number };

export function customerAiCatalogEvidenceVerifier(config: {
  expected: Scope;
  expectedCatalog: unknown;
  verificationKey: KeyObject;
  maxAgeMs?: number;
  mode?: "production" | "test";
  _testClock?: () => Clock;
}) {
  let scope: Scope, catalog: string, key: KeyObject;
  const maxAgeMs = config?.maxAgeMs ?? 5_000;
  try {
    scope = scopeSchema.parse(config?.expected);
    catalog = checkedCatalog(config?.expectedCatalog);
    if (!(config?.verificationKey instanceof Object) || config.verificationKey.type !== "public"
      || config.verificationKey.asymmetricKeyType !== "ed25519"
      || !Number.isInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > 30_000
      || (config.mode !== undefined && !["production", "test"].includes(config.mode))
      || (config._testClock !== undefined && (config.mode !== "test" || typeof config._testClock !== "function"))) throw unavailable();
    key = createPublicKey({ key: config.verificationKey.export({ format: "der", type: "spki" }), format: "der", type: "spki" });
  } catch { throw unavailable(); }
  // Copy both operator inputs so later caller mutation cannot change trust.
  scope = Object.freeze({ ...scope });
  const expectedDigest = createHash("sha256").update(catalog, "utf8").digest("hex");
  const clock = config._testClock ?? (() => ({ wall: Date.now(), monotonic: Math.floor(performance.now()) }));
  const pending = new Map<Challenge, Pending>();
  let disposed = false, lastTime: Clock | undefined;
  function now() {
    const current = clock();
    if (!current || !Number.isSafeInteger(current.wall) || current.wall < 0
      || !Number.isSafeInteger(current.monotonic) || current.monotonic < 0
      || (lastTime && (current.wall < lastTime.wall || current.monotonic < lastTime.monotonic
        || Math.abs((current.wall - lastTime.wall) - (current.monotonic - lastTime.monotonic)) > 1_000))) throw unavailable();
    lastTime = { wall: current.wall, monotonic: current.monotonic };
    return lastTime;
  }
  return {
    challenge(): Challenge {
      if (disposed) throw unavailable();
      const issued = now();
      for (const [item, record] of pending) if (issued.monotonic - record.issuedMonotonic >= maxAgeMs || issued.wall - record.issuedAt >= maxAgeMs) pending.delete(item);
      if (pending.size >= maxChallenges) throw unavailable();
      const nonce = randomBytes(32).toString("base64url");
      const value = Object.freeze({ version: 1 as const, ...scope, nonce });
      pending.set(value, { nonce, issuedAt: issued.wall, issuedMonotonic: issued.monotonic });
      return value;
    },
    verify(challenge: Challenge, raw: string, signal?: AbortSignal) {
      if (disposed || (signal !== undefined && !(signal instanceof AbortSignal))) throw unavailable();
      const saved = pending.get(challenge);
      // Consume before parsing: rejected evidence cannot replay a challenge.
      pending.delete(challenge);
      try {
        const current = now();
        if (!saved || signal?.aborted || typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > maxBytes
          || current.wall - saved.issuedAt >= maxAgeMs || current.monotonic - saved.issuedMonotonic >= maxAgeMs) throw unavailable();
        const decoded: unknown = JSON.parse(raw);
        if (canonicalCustomerCatalogJson(decoded) !== raw) throw unavailable();
        const value = envelope.parse(decoded);
        if (value.nonce !== saved.nonce || value.auditorId !== scope.auditorId || value.keyId !== scope.keyId
          || value.deploymentId !== scope.deploymentId || value.projectRef !== scope.projectRef
          || value.schemaRevision !== scope.schemaRevision || value.observedAt < saved.issuedAt || value.observedAt > current.wall
          || value.expiresAt <= current.wall || value.expiresAt > value.observedAt + maxAgeMs) throw unavailable();
        const { signature, ...payload } = value;
        const signedBytes = Buffer.from(domain + "\n" + canonicalCustomerCatalogJson(payload), "utf8");
        if (!verifySignature(null, signedBytes, key, Buffer.from(signature, "hex"))) throw unavailable();
        const actualCatalog = checkedCatalog(value.catalog);
        const actualDigest = createHash("sha256").update(actualCatalog, "utf8").digest("hex");
        if (actualDigest !== expectedDigest) throw unavailable();
        // Parsing and hashing can be expensive. Recheck after all validation so
        // an observation that expired while being processed is never returned.
        const finished = now();
        if (signal?.aborted || finished.wall >= value.expiresAt || finished.wall - saved.issuedAt >= maxAgeMs
          || finished.monotonic - saved.issuedMonotonic >= maxAgeMs) throw unavailable();
        return Object.freeze({ kind: "matched_catalog_observation" as const, deploymentId: scope.deploymentId,
          projectRef: scope.projectRef, schemaRevision: scope.schemaRevision, auditorId: scope.auditorId,
          observedAt: value.observedAt, expiresAt: value.expiresAt, catalogSha256: actualDigest });
      } catch { throw unavailable(); }
    },
    dispose() { disposed = true; pending.clear(); },
  };
}
