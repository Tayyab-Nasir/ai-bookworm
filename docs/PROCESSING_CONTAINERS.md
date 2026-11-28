# Private processing containers

Build from the repository root using `ops/processing.Dockerfile` with target
`document`, `rendering` or `publishing`. All listen on container port 8000.
The build-context allowlist excludes env files, cached jobs, tests and unrelated
project data. Images include Python dependencies, Poppler for fixed-layout
EPUB, the separately licensed bundled FFmpeg, and vendored font notices.

```sh
docker build -f ops/processing.Dockerfile --target rendering -t bookworm-rendering .
```

Configure the role's dedicated service token and matching API/worker URL/token.
Do not put keys in build arguments or images. Run on a private network as the
provided unprivileged UID/GID 65532, with a read-only root, dropped capabilities,
no-new-privileges and writable bounded `/tmp`. Do not expose these services
directly to browsers or public ingress. Local filesystem document imports are
disabled unless explicitly configured; the standard path sends private bytes.

The acceptance workflow builds all three images and starts disposable containers
with no mounts, published ports or external network, 512 MiB memory, 128 PIDs and
256 MiB noexec scratch. It checks missing/wrong credentials, actual text import,
reflowable/fixed EPUB, MP3 assembly, preflight and exact-artifact packaging.
These small-fixture limits are not production capacity recommendations. Large
books need measured memory/scratch budgets, upstream request limits and queue
admission. Health only proves the HTTP process responds, not useful job progress.

Run `python3 scripts/test-processing-containers.py` after building local images
named `bookworm-ci-document`, `bookworm-ci-rendering`, `bookworm-ci-publishing`.
The script removes only the containers it creates; it does not prune images or
volumes. It makes no provider call and does not connect to Supabase or retailers.

Images are built/tested only, not published or deployed by CI. Production needs
reviewed image digests, dependency locks/SBOM/license review, vulnerability checks,
secrets/network configuration and recovery/capacity acceptance. Current base tags
and dependency ranges are not bit-for-bit reproducible release locks.
Workers/API, scanner/ClamAV and persistent stores are separate components.
