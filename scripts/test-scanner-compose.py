"""Exercise the production-shaped topology using disposable fixtures only."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "bookworm-compose-acceptance-disposable-token"
PROBE = """
import hashlib,json,urllib.request,urllib.error
from pathlib import Path
data=b'Bookworm harmless persistent-volume acceptance.'
token=Path('/run/secrets/scanner_token').read_text().strip()
request=urllib.request.Request('http://127.0.0.1:8004/v1/scan',data=data,
 headers={'Authorization':'Bearer '+token,'Content-Type':'application/octet-stream',
 'X-Content-Sha256':hashlib.sha256(data).hexdigest(),'X-Content-Mime':'text/plain'})
try: response=urllib.request.urlopen(request,timeout=25)
except urllib.error.HTTPError as e: response=e
print(json.dumps({'status':response.status,'body':json.load(response)}))
"""


def main():
    project = "bookworm-runtime-test-" + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix=project) as directory:
        secret = Path(directory) / "token"
        secret.write_text(TOKEN, encoding="utf-8")
        secret.chmod(0o644)  # Disposable CI fixture; production uses restricted ownership.
        env = {**os.environ, "SCANNER_TOKEN_FILE": str(secret)}
        command = ["docker", "compose", "-p", project, "-f", str(ROOT / "ops/scanning/compose.yaml")]

        def compose(*args):
            result = subprocess.run([*command, *args], env=env, capture_output=True, text=True, timeout=300)
            if result.returncode:
                raise AssertionError(result.stderr[-2500:])
            return result.stdout.strip()

        def scan():
            return json.loads(compose("exec", "-T", "scanner", "python", "-c", PROBE))

        def ready():
            for _ in range(90):
                try:
                    result = scan()
                    if result["status"] == 200:
                        assert result["body"]["verdict"] == "clean", result
                        assert result["body"]["sha256"] == hashlib.sha256(
                            b"Bookworm harmless persistent-volume acceptance.").hexdigest()
                        return result["body"]["engine"]
                except (AssertionError, ValueError):
                    pass
                time.sleep(2)
            raise AssertionError("Runtime not ready: " + compose("logs", "--tail", "20"))

        try:
            spec = json.loads(compose("config", "--format", "json"))
            assert TOKEN not in json.dumps(spec)
            assert spec["networks"]["engine"]["internal"]
            assert spec["networks"]["callers"]["internal"]
            for service in spec["services"].values():
                assert not service.get("ports") and service["read_only"]
                assert service["cap_drop"] == ["ALL"]
            # FreshClam seeds/updates only this test project's named volume.
            compose("run", "--rm", "updater", "--stdout")
            compose("up", "-d")
            engine = ready()
            print("PASS production topology with secret file: " + json.dumps(engine), flush=True)
            state = json.loads(compose("ps", "--format", "json", "updater"))
            if isinstance(state, list):
                state = state[0]
            assert state["State"] == "running", state
            compose("stop", "clamd")
            result = scan()
            assert result["status"] == 503 and "verdict" not in result["body"]
            print("PASS production topology engine outage fails closed", flush=True)
            # Remove containers/networks only: named signature volume survives.
            compose("down")
            compose("up", "-d", "clamd", "scanner")
            recovered = ready()
            assert recovered["databaseVersion"] == engine["databaseVersion"]
            assert recovered["databaseDate"] == engine["databaseDate"]
            print("PASS container recreation retains signature database and recovers", flush=True)
        finally:
            # Only the unique disposable project created above; never operator volumes.
            compose("down", "--volumes", "--remove-orphans")


if __name__ == "__main__":
    main()
