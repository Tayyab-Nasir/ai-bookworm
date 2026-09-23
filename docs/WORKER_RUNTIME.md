# Worker runtime

The Next.js app can run on Vercel. These nine persistent queue consumers need
a separate host with Node.js 22, private service connectivity and server-side
credentials. The repository now includes a shared allowlisted launcher and a
systemd worker template for Linux. Installing these files does not configure
the API, Python services, Supabase, pricing or alerts.

## Inspect without processing jobs

From the repository root:

```sh
node workers/run.mjs --list
node workers/run.mjs --check
npm run test:worker-launcher
```

The first two commands require no application credentials and do not import
queue consumers. `--check` checks entrypoint presence, not service health.
The test suite also imports every worker under a secret-free production
environment and verifies configuration refusal before any network work.

## Worker roles

| Role | Work processed |
| --- | --- |
| document | Manuscript imports |
| publishing | Edition rendering, validation and export packages |
| ai | Paid authoring/review jobs |
| audiobook | Paid chapter narration |
| audiobook-export | Private Google Play archives; no generation charge |
| translation-quotes | Translation quote preparation |
| translation | Accepted funded translation jobs |
| blueprint-quotes | Story Blueprint quote preparation |
| blueprint | Accepted funded Blueprint proposals |

`npm run worker -- <role> [--once]` starts real processing. It may call OpenAI
and consume paid usage for queued work. Translation and Blueprint execution
are always in quoted mode; arbitrary paths and mode overrides are refused.

## Linux installation and activation

Prepare a reviewed checkout and `npm ci --include=dev` at `/opt/bookworm`.
The `tsx` runtime is currently in workspace development dependencies; do not
omit them. Use a dedicated non-login `bookworm` account and group. Source and
dependencies should be readable by that account and writable only by the
release operator. The template expects Node at `/usr/bin/node`; adjust that
absolute path for the chosen host before validation.

Store server credentials in `/etc/bookworm/workers.env`, owned by root with
mode 0600. The system service manager reads it before dropping privileges.
Never add it to Git or Obsidian. Use literal `KEY=value` entries; systemd does
not perform shell-style variable expansion in this file. Set `NODE_ENV=production`
and do not override the per-worker `TMPDIR` supplied by the unit. Configure the
common `@bookworm/config` requirements and private service URLs/tokens described
in `docs/operations.md`, including the approved provider and pricing setup.

After runtime/migration acceptance and authorization to start processing:

```sh
sudo install -m 0644 ops/systemd/bookworm-worker@.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/bookworm-workers.target /etc/systemd/system/
sudo systemctl daemon-reload
# Start a reviewed role first; this begins real queue processing.
sudo systemctl start bookworm-worker@document.service
sudo systemctl status bookworm-worker@document.service
# Enable/start the entire fleet only when every dependency and paid path is ready.
sudo systemctl enable --now bookworm-workers.target
```

The template runs without root, drops capabilities, makes the system filesystem
read-only and provides private mode-0700 state directories at
`/var/lib/bookworm-<role>`. Those directories are writable scratch storage;
use encrypted disks with enough free space for the 3.75 GiB archive cap plus
assembly overhead. State directories survive restarts. Crash-left temporary
files need operator reconciliation; no broad automatic deletion is installed.

Workers stop claiming new jobs on SIGTERM and finish their current operation.
systemd allows six minutes before killing remaining processes; interrupted
leases can subsequently expire and be reclaimed. SIGKILL, power-loss and real
host recovery acceptance are still required. Failures restart after five
seconds, with a five-starts-per-minute limit for repeated startup failures.
Workers themselves back off dependency errors; a running process does not
prove that useful jobs are completing.

## Observe, stop and update

```sh
sudo journalctl -u 'bookworm-worker@*' --since '15 minutes ago'
sudo systemctl stop bookworm-workers.target
sudo systemctl restart bookworm-worker@audiobook-export.service
```

Logs use the existing workers' sanitized result/error summaries. Restrict log
access because job IDs are still operational metadata. Before updating source,
stop the fleet and confirm all instances stopped, install the reviewed release
and dependencies, then start the approved roles. Monitor queue age, expired
leases, terminal failures, scratch disk capacity and provider settlement
separately; no monitoring or paging destination is installed by these units.

CI validates service syntax and all nine launcher entrypoints on Linux without
starting system services or supplying credentials. Host permissions, network,
secret storage, worker supervision/recovery, backup and alerts still require
acceptance on the deployment host. The service settings follow the official
[systemd service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
and [execution environment](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
documentation.
