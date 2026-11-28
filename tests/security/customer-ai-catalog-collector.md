# Customer AI catalog inventory (experimental, unregistered)

This is a **read-only metadata inventory**, not database identity, effective
authorization, safe configuration, a migration attestation, or runtime
readiness. Nothing in this slice enables customer AI, grants an entitlement,
seeds a policy, contacts a provider, or changes a database schema.

Exact comparison with an expected snapshot only detects differences. It does
not decide whether the initial expected snapshot is safe. If a dangerous
grant, owner, role membership, or SQL definition was already included in
the baseline, an unchanged catalog still matches. A separate trusted review
must evaluate effective privileges, all paths for SET ROLE and ADMIN, RLS,
function behavior, and the complete deployed schema. Never manufacture an
`aclVerified` result from a matching catalog or a signed snapshot alone.

The query collects PostgreSQL 16+ catalog metadata: all roles and membership
options; database, default and role-level ACL/settings metadata; extensions;
non-system schemas, types (including domain and enum metadata), relations,
column ACL/default metadata, RLS/policies, constraints, indexes and triggers;
and non-system functions and procedures. Enum labels, expressions, function
bodies, function configuration and settings values are hashed, not emitted
as plaintext. Array settings are hashed as JSON arrays to preserve element
boundaries. Hashes can still reveal guessable values, and object and principal
names can be sensitive: protect snapshots like private operational metadata.

Known omissions include system-schema definitions and extension binary
contents, aggregates and window functions (`prokind` other than f/p),
type input/output and range implementation details, operators, casts,
procedural-language privileges, event triggers, foreign
servers and mappings, all server parameters, storage/object permissions,
unlisted runtime dependencies, function semantics, current data, and future
changes after observation. This inventory does not calculate effective
privilege, attest TLS/cluster/project identity, or prove role ownership and
superuser trust. It also does not prove that a catalog reader, verifier, or
authenticated auditor is uncompromised.

For a separately authorized operator collection, execute the query through a
trusted, independently authenticated PostgreSQL connection inside **one**
`REPEATABLE READ READ ONLY` transaction. Before the query, set a bounded
statement timeout and transaction-local `search_path=pg_catalog`, time zone
`UTC`, `DateStyle='ISO, YMD'`, and `quote_all_identifiers=off`. Reject
anything except exactly one row. PostgreSQL before version 16 returns no row;
the caller must reject it. A verifier must bind the observed major version to
its independently reviewed manifest and must not assume output is portable
across major versions, cluster initialization, automatic object names,
extensions, or unrelated schema changes.

`customer-ai-catalog-collector.test.mjs` uses only an ephemeral PGlite DB.
It exercises actual DDL drift and rollback, SET-only role membership, and a
negative control showing why settings arrays must be hashed as JSON arrays
rather than delimiter-joined strings. Optional
`BOOKWORM_SYNTHETIC_CATALOG_OUTPUT` writes one exclusively created **synthetic**
snapshot under the OS temp directory; it is not a live catalog export.
`customer-ai-catalog-migrations.test.mjs` separately builds the repository's
committed migration history in an in-memory synthetic database. Its CRLF to
LF normalization matches Git's stored migration bytes on a Windows checkout;
it does not assert hosted Supabase catalog identity or permissions.

`customer-ai-catalog-native.test.mjs` is opt-in: set
`BOOKWORM_CATALOG_PG_BIN` to a trusted PostgreSQL 16 binary directory. It
creates a fresh password-protected, loopback-only disposable cluster, strips
application and PG environment variables, exercises real native DDL drift,
and stops that specific cluster in `finally`. It retains synthetic cluster
files under the OS temp directory. No existing database, hosted project, app
credentials, or provider service is used. The optional synthetic snapshot
output variable has the same temp-only, exclusive-create restriction.

The separate `customer-ai-catalog-evidence.ts` comparator is also
unregistered. It checks a canonical, bounded and Ed25519-signed observation
against a separately supplied manifest and a single-use challenge bound to
auditor, key, deployment, project and schema revision. Wall and monotonic
deadlines are checked again after parsing and signature verification. The
verifier holds only the public key; its matching result is
`matched_catalog_observation`, not `aclVerified`, and cannot by itself pass
the customer-AI readiness coordinator. A signature authenticates the
auditor's assertion, not whether that auditor actually queried the intended
database or captured a complete, safe catalog. No trusted project binding,
reviewed manifest or production wiring is provisioned here. Live collector
security, semantic/role analysis, Supabase tests and operator monitoring remain
required before activation.

The separate experimental `customer-ai-catalog-collector.ts` uses an explicit
operator-supplied project-to-endpoint, database, login and physical cluster ID
binding. It launches a SHA-256-pinned `psql` with an allowlisted environment,
TLS `verify-full`, a pinned CA file, GSS encryption disabled, and no retries.
It sends only the fixed, SHA-256-pinned SQL on stdin: the identity query and
catalog query share one repeatable-read, read-only transaction. It validates
the identity, bounded response and constrained login role before signing the
challenge. The binding must be obtained independently through a trusted
control plane; a database-provided ID alone is cloneable and cannot establish
the identity of a Supabase project, especially through a shared pooler. The
collector is not registered in the application and its output cannot enable
runtime, entitlements, or `aclVerified`, even when the inventory matches.

The auditor needs permission to execute `pg_catalog.pg_control_system()` and
inspect its own TLS state in `pg_stat_ssl`; these permissions and the identity
query's availability on hosted Supabase have not been established. Granting
additional rights or deploying a collector requires separate security review.
The single authoritative SQL source is embedded in
`services/api/src/lib/customer-ai-catalog-snapshot.ts`, imported by the
collector, and checked against its pinned digest. The artifact test emits that
module with TypeScript and checks the compiled value and digest. This proves
the module's emitted artifact contains the SQL; it does not prove any actual
deployment bundle includes this currently unregistered collector or module.
The CA and executable files
and every parent directory must be protected against replacement throughout
execution. Hash checks followed by path-based execution have a time-of-check
race and do not defend against a same-user or privileged attacker. The signing
key and transient `PGPASSWORD` must be protected by the host; a child process
environment may be readable by privileged or same-user processes. On Windows,
Node's `SIGKILL` terminates the child using the platform's process semantics;
this is not a job-object supervisor for descendants. If close never arrives,
the bounded fallback reports failure but cannot prove OS-level termination.

The collector times out after at most four seconds and caps output at 2 MiB;
the monotonic deadline is checked after parsing, schema validation,
canonicalization, signing and final serialization, so event-loop blockage
cannot produce a late signed observation. The timeout rejects late work;
it cannot interrupt synchronous JavaScript until that work returns.
The synthetic full-migration catalog is approximately 1 MiB. Actual hosted
catalog size, query latency, contention and scheduling have not been measured,
so the limit may prevent collection. Independent process supervision, secure
key provisioning, complete security-relevant object coverage, effective ACL
and function-semantic review, and hosted staging verification are outstanding.
The optional `customer-ai-catalog-transport-native.test.mjs` exercises only a
disposable local PostgreSQL 16 TLS/SCRAM server with synthetic credentials.

`customer-ai-catalog-full.test.mjs` tests verifier compatibility and the
2 MiB evidence cap on the same full synthetic migration catalog. That fixture
has minimal Supabase auth/storage schemas and cannot establish the size or
compatibility of an actual hosted Supabase catalog.
