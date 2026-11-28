"""Compatibility entry point for the PostgreSQL-leased rendering worker."""

from pathlib import Path
import shutil
import subprocess


def run() -> None:
    """Run render and validation actions through the fenced Node worker."""
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("npm is required to run the publishing worker")
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [npm, "run", "worker:publishing", "--", "--actions=render,validate"],
        cwd=root,
        check=False,
    )
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    run()
