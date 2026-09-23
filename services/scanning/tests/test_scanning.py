from __future__ import annotations

import base64
import hashlib
from pathlib import Path
import struct
import sys
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient


SCANNING_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCANNING_ROOT))

from scanning_service.clamd import (  # noqa: E402
    ClamdScanner,
    EngineMetadata,
    ScanResult,
    ScannerUnavailable,
)
from scanning_service.config import ConfigurationError, ScannerConfig  # noqa: E402
from scanning_service.main import create_app  # noqa: E402


TOKEN = "scanner-test-token-that-is-at-least-32-characters"
ENGINE = EngineMetadata(name="ClamAV", version="1.4.2", database_version="27888", database_date="2026-09-07T00:00:00Z")


@pytest.fixture(autouse=True)
def fixture_clock(monkeypatch):
    monkeypatch.setattr("scanning_service.clamd._utcnow", lambda: datetime(2026, 9, 7, 1, tzinfo=timezone.utc))


@pytest.mark.parametrize("date", ["Thu Sep 03 00:00:00 2026", "Tue Sep 08 00:00:00 2026",
    "not a date", "Mon Sep 31 00:00:00 2026", "Mon Foo 07 00:00:00 2026"])
def test_bad_database_dates_never_dispatch_file_bytes(date):
    version = FakeSocket(f"ClamAV 1.4.2/27888/{date}\0".encode())
    factory = FakeSocketFactory(version)
    with pytest.raises(ScannerUnavailable):
        ClamdScanner(config(), socket_factory=factory).scan(b"private manuscript")
    assert len(factory.calls) == 1
    assert version.sent == [b"zVERSION\0"]


def test_database_age_boundary_and_readiness(monkeypatch):
    date = b"ClamAV 1.4.2/27888/Fri Sep 04 01:00:00 2026\0"
    engine = ClamdScanner(config(), socket_factory=FakeSocketFactory(FakeSocket(date))).version()
    assert engine.as_dict()["databaseDate"] == "2026-09-04T01:00:00Z"
    monkeypatch.setattr("scanning_service.clamd._utcnow", lambda: datetime(2026, 9, 7, 1, 0, 1, tzinfo=timezone.utc))
    scanner = ClamdScanner(config(), socket_factory=FakeSocketFactory(FakeSocket(b"PONG\0"), FakeSocket(date)))
    with TestClient(create_app(config(), scanner)) as client:
        response = client.get("/ready")
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "scanner_database_stale"
        assert client.get("/health").status_code == 200
    stale = ClamdScanner(config(), socket_factory=FakeSocketFactory(FakeSocket(date)))
    with TestClient(create_app(config(), stale)) as client:
        response = client.post("/v1/scan", headers={**auth(), "Content-Type": "application/octet-stream",
            "X-Content-Sha256": hashlib.sha256(b"fixture").hexdigest(), "X-Content-Mime": "text/plain"}, content=b"fixture")
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "scanner_database_stale"
        assert "verdict" not in response.json()


@pytest.mark.parametrize("value", ["0", "169", "-1", "NaN"])
def test_database_age_configuration_has_no_disabled_or_unbounded_mode(value):
    with pytest.raises(ConfigurationError):
        ScannerConfig.from_env({"SCANNING_SERVICE_TOKEN": TOKEN, "SCANNING_MAX_DATABASE_AGE_HOURS": value})


def test_secret_file_configuration(tmp_path):
    secret = tmp_path / "scanner-token"
    secret.write_text(TOKEN + "\n", encoding="utf-8")
    assert ScannerConfig.from_env({"SCANNING_SERVICE_TOKEN_FILE": str(secret)}).service_token == TOKEN
    with pytest.raises(ConfigurationError, match="only one"):
        ScannerConfig.from_env({"SCANNING_SERVICE_TOKEN_FILE": str(secret), "SCANNING_SERVICE_TOKEN": TOKEN})
    for content in (b"", b"short", b"x" * 2049, b"\xff" * 40, (TOKEN + "\n\n").encode()):
        secret.write_bytes(content)
        with pytest.raises(ConfigurationError):
            ScannerConfig.from_env({"SCANNING_SERVICE_TOKEN_FILE": str(secret)})
    for path in (tmp_path, tmp_path / "missing"):
        with pytest.raises(ConfigurationError, match="could not be read safely"):
            ScannerConfig.from_env({"SCANNING_SERVICE_TOKEN_FILE": str(path)})


def config(**overrides: object) -> ScannerConfig:
    values = {
        "service_token": TOKEN,
        "clamd_host": "clamd.internal",
        "clamd_port": 3310,
        "connect_timeout_seconds": 0.5,
        "read_timeout_seconds": 1.5,
        "max_file_bytes": 128,
        "max_concurrency": 2,
        "chunk_bytes": 4,
    }
    values.update(overrides)
    return ScannerConfig(**values)


class FakeSocket:
    def __init__(self, *responses: bytes) -> None:
        self.responses = list(responses)
        self.sent: list[bytes] = []
        self.timeout: float | None = None
        self.closed = False

    def settimeout(self, value: float) -> None:
        self.timeout = value

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)

    def recv(self, size: int) -> bytes:
        if not self.responses:
            return b""
        response = self.responses.pop(0)
        if len(response) > size:
            self.responses.insert(0, response[size:])
            return response[:size]
        return response

    def close(self) -> None:
        self.closed = True


class FakeSocketFactory:
    def __init__(self, *sockets: FakeSocket) -> None:
        self.sockets = list(sockets)
        self.calls: list[tuple[tuple[str, int], float]] = []

    def __call__(self, address: tuple[str, int], timeout: float) -> FakeSocket:
        self.calls.append((address, timeout))
        if not self.sockets:
            raise TimeoutError("fixture outage")
        return self.sockets.pop(0)


class FakeScanner:
    def __init__(
        self, *, infected: bool = False, fail_scan: bool = False, fail_probe: bool = False
    ) -> None:
        self.infected = infected
        self.fail_scan = fail_scan
        self.fail_probe = fail_probe
        self.scan_calls: list[bytes] = []
        self.probe_calls = 0

    def probe(self) -> EngineMetadata:
        self.probe_calls += 1
        if self.fail_probe:
            raise ScannerUnavailable("fixture details must not leak")
        return ENGINE

    def scan(self, content: bytes) -> ScanResult:
        self.scan_calls.append(content)
        if self.fail_scan:
            raise ScannerUnavailable("fixture details must not leak")
        return ScanResult(
            infected=self.infected,
            signature="Win.Test.EICAR_HDB-1" if self.infected else None,
            engine=ENGINE,
        )


def auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def test_environment_configuration_is_validated_and_destination_is_fixed() -> None:
    loaded = ScannerConfig.from_env(
        {
            "SCANNING_SERVICE_TOKEN": TOKEN,
            "CLAMD_HOST": "CLAMD.INTERNAL",
            "CLAMD_PORT": "3311",
            "SCANNING_MAX_FILE_BYTES": "2048",
        }
    )
    assert loaded.clamd_host == "clamd.internal"
    assert loaded.clamd_port == 3311
    assert loaded.max_file_bytes == 2048

    with pytest.raises(ConfigurationError, match="SCANNING_SERVICE_TOKEN"):
        ScannerConfig.from_env({})
    with pytest.raises(ConfigurationError, match="CLAMD_HOST"):
        ScannerConfig.from_env(
            {"SCANNING_SERVICE_TOKEN": TOKEN, "CLAMD_HOST": "tcp://attacker/clamd"}
        )
    with pytest.raises(ConfigurationError, match="SCANNING_MAX_FILE_BYTES"):
        ScannerConfig.from_env(
            {"SCANNING_SERVICE_TOKEN": TOKEN, "SCANNING_MAX_FILE_BYTES": "999999999"}
        )


def test_clamd_clean_scan_uses_version_and_bounded_instream_frames() -> None:
    version_socket = FakeSocket(b"ClamAV 1.4.2/27888/Sun Sep 07 00:00:00 2026\0")
    scan_socket = FakeSocket(b"stream: ", b"OK\0")
    factory = FakeSocketFactory(version_socket, scan_socket)
    scanner = ClamdScanner(config(), socket_factory=factory)

    result = scanner.scan(b"abcdef")

    assert result == ScanResult(infected=False, signature=None, engine=ENGINE)
    assert factory.calls == [(("clamd.internal", 3310), 0.5)] * 2
    assert version_socket.sent == [b"zVERSION\0"]
    assert scan_socket.sent == [
        b"zINSTREAM\0",
        struct.pack("!I", 4),
        b"abcd",
        struct.pack("!I", 2),
        b"ef",
        struct.pack("!I", 0),
    ]
    assert version_socket.timeout == scan_socket.timeout == 1.5
    assert version_socket.closed and scan_socket.closed


def test_clamd_infected_scan_returns_bounded_signature() -> None:
    scanner = ClamdScanner(
        config(),
        socket_factory=FakeSocketFactory(
            FakeSocket(b"ClamAV 1.4.2/27888/Sun Sep 07 00:00:00 2026\0"),
            FakeSocket(b"stream: Win.Test.EICAR_HDB-1 FOUND\0"),
        ),
    )
    assert scanner.scan(b"fixture") == ScanResult(
        infected=True, signature="Win.Test.EICAR_HDB-1", engine=ENGINE
    )


@pytest.mark.parametrize(
    "response",
    [
        b"stream: scan failed ERROR\0",
        b"stream: MAYBE\0",
        b"stream: OK\0trailing",
        b"stream: OK",
        b"stream: bad\nreply\0",
    ],
)
def test_clamd_untrusted_protocol_replies_fail_closed(response: bytes) -> None:
    scanner = ClamdScanner(
        config(),
        socket_factory=FakeSocketFactory(
            FakeSocket(b"ClamAV 1.4.2/27888/Sun Sep 07 00:00:00 2026\0"),
            FakeSocket(response),
        ),
    )
    with pytest.raises(ScannerUnavailable):
        scanner.scan(b"fixture")


def test_clamd_outage_and_bad_version_fail_closed() -> None:
    with pytest.raises(ScannerUnavailable):
        ClamdScanner(config(), socket_factory=FakeSocketFactory()).scan(b"fixture")
    with pytest.raises(ScannerUnavailable):
        ClamdScanner(
            config(), socket_factory=FakeSocketFactory(FakeSocket(b"unexpected\0"))
        ).scan(b"fixture")


def test_clamd_readiness_requires_ping_and_version() -> None:
    ping = FakeSocket(b"PONG\0")
    version = FakeSocket(b"ClamAV 1.4.2/27888/Sun Sep 07 00:00:00 2026\0")
    scanner = ClamdScanner(config(), socket_factory=FakeSocketFactory(ping, version))
    assert scanner.probe() == ENGINE
    assert ping.sent == [b"zPING\0"]
    assert version.sent == [b"zVERSION\0"]


def test_health_and_readiness_contract() -> None:
    scanner = FakeScanner()
    with TestClient(create_app(config(), scanner)) as client:
        health = client.get("/health")
        ready = client.get("/ready")
    assert health.status_code == 200 and health.json() == {"status": "ok"}
    assert health.headers["cache-control"] == "no-store"
    assert ready.status_code == 200
    assert ready.json() == {"status": "ready", "engine": ENGINE.as_dict()}
    assert scanner.probe_calls == 1


def test_readiness_outage_is_sanitized_and_fails_closed() -> None:
    with TestClient(create_app(config(), FakeScanner(fail_probe=True))) as client:
        response = client.get("/ready")
    assert response.status_code == 503
    assert response.json() == {
        "error": {
            "code": "scanner_unavailable",
            "message": "malware scanner is not ready",
        }
    }
    assert "fixture" not in response.text

def test_unauthenticated_requests_never_reach_scanner() -> None:
    scanner = FakeScanner()
    content = b"untrusted"
    with TestClient(create_app(config(), scanner)) as client:
        response = client.post(
            "/v1/scan",
            content=content,
            headers={
                "Content-Type": "application/octet-stream",
                "X-Content-Sha256": hashlib.sha256(content).hexdigest(),
                "X-Content-Mime": "application/pdf",
            },
        )
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert scanner.scan_calls == []


def test_non_ascii_authorization_is_denied_without_scanning() -> None:
    scanner = FakeScanner()
    with TestClient(create_app(config(), scanner)) as client:
        response = client.post("/v1/scan", content=b"fixture",
                               headers={b"authorization": b"Bearer wrong-\xe9"})
    assert response.status_code == 401
    assert scanner.scan_calls == []


def test_raw_clean_scan_verifies_hash_mime_and_returns_engine_metadata() -> None:
    scanner = FakeScanner()
    content = b"%PDF-safe-fixture"
    with TestClient(create_app(config(), scanner)) as client:
        response = client.post(
            "/v1/scan",
            content=content,
            headers={
                **auth(),
                "Content-Type": "application/octet-stream",
                "X-Content-Sha256": hashlib.sha256(content).hexdigest().upper(),
                "X-Content-Mime": "Application/PDF",
            },
        )
    assert response.status_code == 200
    assert response.json() == {
        "verdict": "clean",
        "clean": True,
        "infected": False,
        "signature": None,
        "sha256": hashlib.sha256(content).hexdigest(),
        "mimeType": "application/pdf",
        "sizeBytes": len(content),
        "engine": ENGINE.as_dict(),
    }
    assert scanner.scan_calls == [content]


def test_json_base64_infected_scan_is_an_explicit_non_clean_verdict() -> None:
    scanner = FakeScanner(infected=True)
    content = b"eicar-fixture"
    with TestClient(create_app(config(), scanner)) as client:
        response = client.post(
            "/v1/scan",
            headers=auth(),
            json={
                "contentBase64": base64.b64encode(content).decode("ascii"),
                "sha256": hashlib.sha256(content).hexdigest(),
                "mimeType": "application/octet-stream",
            },
        )
    assert response.status_code == 200
    assert response.json()["verdict"] == "infected"
    assert response.json()["clean"] is False
    assert response.json()["infected"] is True
    assert response.json()["signature"] == "Win.Test.EICAR_HDB-1"


@pytest.mark.parametrize(
    ("body", "headers", "expected_status"),
    [
        (
            b"content",
            {
                "Content-Type": "application/octet-stream",
                "X-Content-Sha256": "0" * 64,
                "X-Content-Mime": "text/plain",
            },
            422,
        ),
        (
            b"content",
            {
                "Content-Type": "application/octet-stream",
                "Content-Encoding": "gzip",
                "X-Content-Sha256": hashlib.sha256(b"content").hexdigest(),
                "X-Content-Mime": "text/plain",
            },
            415,
        ),
        (b"content", {"Content-Type": "text/plain"}, 415),
        (
            b"",
            {
                "Content-Type": "application/octet-stream",
                "X-Content-Sha256": hashlib.sha256(b"").hexdigest(),
                "X-Content-Mime": "text/plain",
            },
            422,
        ),
    ],
)
def test_invalid_raw_requests_are_rejected_before_scanning(
    body: bytes, headers: dict[str, str], expected_status: int
) -> None:
    scanner = FakeScanner()
    with TestClient(create_app(config(), scanner)) as client:
        response = client.post("/v1/scan", content=body, headers={**auth(), **headers})
    assert response.status_code == expected_status
    assert scanner.scan_calls == []


def test_oversized_raw_and_decoded_json_inputs_are_rejected() -> None:
    scanner = FakeScanner()
    small_config = config(max_file_bytes=4)
    content = b"12345"
    raw_headers = {
        **auth(),
        "Content-Type": "application/octet-stream",
        "X-Content-Sha256": hashlib.sha256(content).hexdigest(),
        "X-Content-Mime": "text/plain",
    }
    envelope = {
        "contentBase64": base64.b64encode(content).decode("ascii"),
        "sha256": hashlib.sha256(content).hexdigest(),
        "mimeType": "text/plain",
    }
    with TestClient(create_app(small_config, scanner)) as client:
        raw_response = client.post("/v1/scan", content=content, headers=raw_headers)
        json_response = client.post("/v1/scan", headers=auth(), json=envelope)
    assert raw_response.status_code == json_response.status_code == 413
    assert scanner.scan_calls == []


def test_json_rejects_noncanonical_base64_duplicate_and_extra_fields() -> None:
    scanner = FakeScanner()
    digest = hashlib.sha256(b"a").hexdigest()
    requests = [
        b'{"contentBase64":"YR==","sha256":"' + digest.encode() + b'","mimeType":"text/plain"}',
        b'{"contentBase64":"YQ==","sha256":"' + digest.encode() + b'","sha256":"' + digest.encode() + b'","mimeType":"text/plain"}',
        b'{"contentBase64":"YQ==","sha256":"' + digest.encode() + b'","mimeType":"text/plain","host":"attacker"}',
    ]
    with TestClient(create_app(config(), scanner)) as client:
        responses = [
            client.post(
                "/v1/scan",
                content=body,
                headers={**auth(), "Content-Type": "application/json"},
            )
            for body in requests
        ]
    assert [response.status_code for response in responses] == [422, 422, 422]
    assert scanner.scan_calls == []


def test_scanner_outage_returns_503_without_a_clean_shape_or_internal_detail() -> None:
    scanner = FakeScanner(fail_scan=True)
    content = b"unknown"
    with TestClient(create_app(config(), scanner)) as client:
        response = client.post(
            "/v1/scan",
            content=content,
            headers={
                **auth(),
                "Content-Type": "application/octet-stream",
                "X-Content-Sha256": hashlib.sha256(content).hexdigest(),
                "X-Content-Mime": "application/pdf",
            },
        )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "scanner_unavailable"
    assert "clean" not in response.json()
    assert "fixture" not in response.text
