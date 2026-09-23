"""Real ClamAV + Bookworm HTTP acceptance. Harmless fixture, no customer files."""
import base64
import hashlib
import json
import subprocess
import time
import uuid

TOKEN = "bookworm-disposable-scanner-token-acceptance-only"
DRIVER = """
import json,sys,urllib.request,urllib.error
v=json.load(sys.stdin)
h={'Content-Type':'application/json'}
if v['token'] is not None: h['Authorization']='Bearer '+v['token']
req=urllib.request.Request('http://127.0.0.1:8004'+v['path'],headers=h,
    data=None if v['body'] is None else json.dumps(v['body']).encode())
try: res=urllib.request.urlopen(req,timeout=20)
except urllib.error.HTTPError as e: res=e
print(json.dumps({'status':res.status,'body':json.load(res)}))
"""


def docker(*args, data=None):
    result = subprocess.run(["docker", *args], input=data, text=True, capture_output=True, timeout=120)
    if result.returncode:
        raise RuntimeError(result.stderr[:2000])
    return result.stdout.strip()


def main():
    network = "bookworm-scan-test-" + uuid.uuid4().hex
    containers = []
    docker("network", "create", "--internal", network)
    try:
        engine = docker("run", "-d", "--network", network, "--network-alias", "clamd",
            "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--memory", "4g", "--pids-limit", "128", "bookworm-ci-clamd")
        containers.append(engine)
        scanner = docker("run", "-d", "--network", network, "--read-only",
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--memory", "256m", "--pids-limit", "64",
            "-e", f"SCANNING_SERVICE_TOKEN={TOKEN}", "-e", "CLAMD_HOST=clamd",
            "-e", "SCANNING_MAX_FILE_BYTES=4096", "bookworm-ci-scanner")
        containers.append(scanner)

        def request(path, body=None, token=TOKEN):
            return json.loads(docker("exec", "-i", scanner, "python", "-c", DRIVER,
                data=json.dumps({"path": path, "body": body, "token": token})))

        def wait_ready():
            for _ in range(120):
                try:
                    result = request("/ready")
                    if result["status"] == 200:
                        assert result["body"]["engine"]["databaseVersion"].isdigit()
                        return result["body"]["engine"]
                except (RuntimeError, ValueError):
                    pass
                time.sleep(1)
            raise AssertionError("ClamAV readiness failed: " + docker("logs", engine)[-2000:])

        print("PASS real engine ready: " + json.dumps(wait_ready()), flush=True)
        clean = b"A harmless Bookworm manuscript fixture."
        detected = bytes(range(256)) * 4 + b"Bookworm native scanner acceptance fixture"

        def envelope(content):
            return {"contentBase64": base64.b64encode(content).decode(),
                    "sha256": hashlib.sha256(content).hexdigest(), "mimeType": "application/octet-stream"}

        for token in (None, "wrong", "wrong-é"):
            assert request("/v1/scan", envelope(clean), token)["status"] == 401
        for content, expected in ((clean, "clean"), (detected, "infected")):
            result = request("/v1/scan", envelope(content))
            assert result["status"] == 200, result
            body = result["body"]
            assert body["verdict"] == expected, body
            assert body["sha256"] == hashlib.sha256(content).hexdigest()
            assert body["sizeBytes"] == len(content)
            if expected == "infected":
                assert body["signature"].startswith("Bookworm.NativeFixture")
            print(f"PASS real INSTREAM verdict: {expected}", flush=True)
        assert request("/v1/scan", {**envelope(clean), "sha256": "0" * 64})["status"] == 422
        assert request("/v1/scan", envelope(b"x" * 4097))["status"] == 413
        docker("stop", "--time", "5", engine)
        assert request("/health")["status"] == 200
        assert request("/ready")["status"] == 503
        unavailable = request("/v1/scan", envelope(clean))
        assert unavailable["status"] == 503 and "verdict" not in unavailable["body"]
        print("PASS engine outage never returns clean", flush=True)
        docker("start", engine)
        wait_ready()
        recovered = request("/v1/scan", envelope(clean))
        assert recovered["status"] == 200 and recovered["body"]["verdict"] == "clean"
        print("PASS engine restart recovers scanning", flush=True)
    finally:
        for container in reversed(containers):
            # Exact disposable IDs only; include their anonymous volumes.
            docker("rm", "-f", "-v", container)
        docker("network", "rm", network)


if __name__ == "__main__":
    main()
