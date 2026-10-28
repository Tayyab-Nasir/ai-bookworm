"""Supervised loopback service proof. Only fixed synthetic credentials/transports."""
import json
import os
import queue
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_customer_database import DB_KEY
from test_customer_dispatch import KEY, fixture, sign

TOKEN = "synthetic-private-service-token"
SCRIPT = Path(__file__).with_name("customer_private_synthetic_server.py")


class SyntheticServer:
    def __init__(self):
        allowed = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATHEXT", "COMSPEC", "USERPROFILE"}
        env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
        env.update(PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1")
        self.child = subprocess.Popen([sys.executable, "-u", str(SCRIPT)], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", env=env)
        self.lines, self.transcript = queue.Queue(), []
        def read():
            for line in self.child.stdout:
                self.lines.put(line)
        threading.Thread(target=read, daemon=True).start()
        try:
            started = self.event("started")
            assert started["host"] == "127.0.0.1" and 0 < started["port"] <= 65535
            self.url = f"http://127.0.0.1:{started['port']}"
        except Exception:
            self.cleanup()
            raise

    def event(self, expected):
        line = self.lines.get(timeout=12); self.transcript.append(line)
        result = json.loads(line)
        assert result["event"] == expected
        return result

    def send(self, value):
        self.child.stdin.write(value + "\n"); self.child.stdin.flush()

    def stop(self):
        self.send("stop"); self.child.stdin.close()
        summary = self.event("stopped")
        assert self.child.wait(timeout=12) == 0
        errors = self.child.stderr.read()
        assert errors == ""
        output = "".join(self.transcript) + errors
        for secret in (TOKEN, KEY, DB_KEY, "inherited-secret-tripwire"):
            assert secret not in output
        return summary

    def cleanup(self):
        if self.child.poll() is None:
            try:
                self.send("release"); self.send("stop"); self.child.stdin.close()
                self.child.wait(timeout=12)
            except (OSError, subprocess.TimeoutExpired):
                if os.name == "nt":
                    subprocess.run([str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "taskkill.exe"),
                        "/PID", str(self.child.pid), "/T", "/F"], capture_output=True, timeout=5, check=False)
                else:
                    self.child.kill()
                self.child.wait(timeout=5)


@pytest.fixture
def service(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "inherited-secret-tripwire")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "inherited-secret-tripwire")
    server = SyntheticServer()
    try:
        yield server
    finally:
        server.cleanup()


def test_authenticated_loopback_signed_replay_and_sanitized_shutdown(service):
    scope, request = fixture(); body = sign(scope, request)
    with httpx.Client(base_url=service.url, timeout=5, trust_env=False) as client:
        assert client.get("/health").status_code == 404
        assert client.get("/openapi.json").status_code == 404
        assert client.post("/v1/internal/customer-text/dispatch", content=body,
                           headers={"content-type": "application/json"}).status_code == 401
        headers = {"content-type": "application/json", "x-service-token": TOKEN}
        first = client.post("/v1/internal/customer-text/dispatch", content=body, headers=headers)
        assert service.event("provider-started") == {"event": "provider-started"}
        again = client.post("/v1/internal/customer-text/dispatch", content=body, headers=headers)
        assert first.status_code == again.status_code == 201 and first.json() == again.json()
        assert first.json()["usage"]["estimatedCostUsd"] is None
        assert KEY not in first.text and DB_KEY not in first.text
    assert service.stop() == {"event": "stopped", "providerCalls": 1, "receiptCount": 1}


def test_stop_drains_inflight_synthetic_dispatch_before_service_exit(service):
    scope, request = fixture(); body = sign(scope, request)
    service.send("block"); service.event("blocked")
    with ThreadPoolExecutor(max_workers=1) as pool:
        def dispatch():
            with httpx.Client(base_url=service.url, timeout=10, trust_env=False) as client:
                return client.post("/v1/internal/customer-text/dispatch", content=body,
                    headers={"content-type": "application/json", "x-service-token": TOKEN})
        pending = pool.submit(dispatch)
        service.event("provider-started")
        service.send("stop")
        assert not pending.done() and service.child.poll() is None
        service.send("release"); service.child.stdin.close()
        assert pending.result(timeout=10).status_code == 201
        assert service.event("stopped") == {"event": "stopped", "providerCalls": 1, "receiptCount": 1}
        assert service.child.wait(timeout=12) == 0
        assert service.child.stderr.read() == ""
        assert all(secret not in "".join(service.transcript) for secret in (TOKEN, KEY, DB_KEY, "inherited-secret-tripwire"))


def test_synthetic_server_rejects_arguments_or_inherited_provider_credentials(monkeypatch):
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATHEXT", "COMSPEC", "USERPROFILE"}
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    env.update(PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1")
    for args, extra in [(["unexpected"], {}), ([], {"OPENAI_API_KEY": "inherited-secret-tripwire"})]:
        result = subprocess.run([sys.executable, "-u", str(SCRIPT), *args], input="", text=True,
            encoding="utf-8", env={**env, **extra}, capture_output=True, timeout=12, check=False)
        assert result.returncode != 0
        assert json.loads(result.stdout) == {"event": "synthetic-server-failed"}
        assert result.stderr == "" and "inherited-secret-tripwire" not in result.stdout
