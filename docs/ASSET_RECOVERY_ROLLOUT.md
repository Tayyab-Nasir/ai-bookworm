# Asset recovery rollout

Asset recovery is staged and disabled by default. Without
`ASSET_LIFECYCLE_ENABLED=true`, existing removal and restore endpoints remain
available, and the web interface does not offer the new recovery workflow.
Do not set this flag on a user-facing service yet.

The additive migration installs a server-managed asset revision and dormant
recovery functions. It does not grant access to those functions or activate
the recovery workflow. Applying it is a database change and must follow the
reviewed migration order and recovery procedure; do not apply it to a live
project without a current, verified database and Storage recovery plan.

Activation also requires a separately reviewed cutover that fences older
writers, grants only the intended RPC permissions and installs the readiness
check. That cutover has not been added as an automatic migration. Before any
activation, verify the exact hosted schema and permissions, stop old writers
and privileged schema changes, and test signed-in PostgREST and private
Storage behavior. Confirm that all API instances use the same setting.

When the feature is enabled but readiness fails, the asset-library interface
remains readable while its guarded write actions are unavailable. This is not
a system-wide write freeze: other workers, application routes, direct database
access and previously issued Storage upload URLs have separate lifecycles.
Readiness probes need deployment-level rate and database statement limits.

Recovery checks file contents when restoring; it cannot guarantee that an
external Storage administrator will not subsequently remove or replace those
bytes. Operation closures are durable: do not remove them while old requests
can still arrive. The prior-review information in this repository and the
shared Obsidian handoff describes local tests, not hosted acceptance.
