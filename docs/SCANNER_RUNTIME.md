# Private scanner runtime

`ops/scanning/compose.yaml` is a reviewed deployment template, not an installed
service. Run it on a private Linux Docker host, not Vercel. Do not deploy the
`ops/scanner-test` image or its custom signature.

## Boundaries

- Updater: unprivileged FreshClam daemon, 12 checks/day, persistent signature
  volume, outbound network only. Apply host egress policy for official update
  distribution/DNS; the bridge itself is not an egress allowlist.
- Engine: unprivileged ClamAV, read-only signature mount, internal network,
  SelfCheck every 60 seconds. Reload blocks scanning rather than doubling its
  engine memory. It has no public port, credential or external network.
- Scanner: unprivileged Python service, internal engine and caller networks,
  token mounted as a file, 72-hour freshness gate and readiness health check.
  It has no signature-volume access and publishes no host port.
- Roots are read-only, capabilities dropped, PID/memory/log/tmp limits set.
  Allow at least 7 GiB for these limits plus host/other-service headroom;
  capacity-test real maximum-size documents before enabling uploads.

## Operator preparation (not executed by this document)

1. Review/pin supported image digests and dependencies. Set `CLAMAV_IMAGE` to
   the approved official preloaded ClamAV digest and `SCANNER_IMAGE` to the
   scanner build's approved digest. CI uses a floating ClamAV tag deliberately
   to exercise integration; that is not a production release lock.
2. Create a 32-512 character random credential outside the checkout. Set
   `SCANNER_TOKEN_FILE` to its absolute file path. Make it readable by container
   UID 65532 and restrict host access (for example owned by 65532, mode 0400).
   Compose file secrets are host file mounts, not encrypted secret storage;
   file ownership/mode must be established on the host. Configure the API's
   matching token separately. Never commit, print or paste the credential.
3. Synchronize host clocks; both ClamAV processes use TZ=UTC. Run Compose config
   validation, then one-shot `run --rm updater --stdout` to initialize/update
   the named database volume. A failed update must stop rollout.
4. Start the three services only after rollout approval. Attach only the
   authorized API/worker service to the generated callers network and use
   `http://scanner:8004`. Do not expose unauthenticated clamd port 3310 or attach
   callers to the engine network. An approved private gateway/TLS is required
   for cross-host clients; this template supplies neither public ingress nor TLS.
5. Keep a stable Compose project name so recreation reuses the same volume.
   Never use `down --volumes` on the production project. Back up/restore and
   rehearse host reboot/credential rotation before release. Tokens are read at
   startup: rotate the file and recreate scanner/callers in a coordinated window.

Use `docker compose -p <approved-name> -f ops/scanning/compose.yaml ...` for
each command above. No default image/token is provided; missing values refuse
configuration. A fresh empty volume copies the official image's preloaded
databases. No startup script recursively changes host ownership.

## Monitoring and recovery

Poll `/ready` from the private network every 30 seconds; page after three
consecutive failures, and alert immediately on repeated scan 503s. Track
`engine.databaseDate` and alert before 48 hours; 72 hours is the hard refusal.
`/health` only means the HTTP process is running. Watch updater exits/restarts,
FreshClam download errors, disk/inode usage and engine reload failures. Connect
these signals to the operator's approved alert destination before rollout.

Compose health status does not itself send alerts or restart an unhealthy but
running container. `restart: unless-stopped` recovers exited processes only.
For stale signatures, inspect updater/network/storage/clock health, restore
updates, wait for SelfCheck/reload and verify `/ready` plus a harmless scan.
Do not raise the age limit, change asset verdicts or disable quarantine to clear
an outage. Failed scans must remain unavailable to downstream rendering/AI.

## Acceptance

`scripts/test-scanner-compose.py` uses this exact topology with a disposable
secret and unique project. It validates isolation/configuration, actual clean
scanning, engine-outage refusal, daemon startup and container recreation with
the named signature database retained. Cleanup removes only its own project's
containers/networks/volume. The separate native scanner test proves fixture
detection. Hosted Storage/quarantine, automatic periodic update/reload, alert
delivery, crash/host reboot and capacity remain separate release gates.

References: [ClamAV container guidance](https://docs.clamav.net/manual/Installing/Docker.html)
and [Compose services](https://docs.docker.com/reference/compose-file/services/).
