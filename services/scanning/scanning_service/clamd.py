"""Minimal, fail-closed ClamAV clamd TCP client.

Only clamd's NUL-terminated PING, VERSION and INSTREAM commands are used. The
caller supplies bytes already held in memory; this module never opens a file or
executes a process.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import re
import socket
import struct
from collections.abc import Callable
from typing import Protocol

from .config import ScannerConfig


class ScannerUnavailable(RuntimeError):
    """No trustworthy malware verdict could be obtained."""


class ScannerDatabaseStale(ScannerUnavailable):
    """Reachable engine, but its signature database exceeded the age policy."""


class SocketLike(Protocol):
    def settimeout(self, value: float) -> None: ...
    def sendall(self, data: bytes) -> None: ...
    def recv(self, size: int) -> bytes: ...
    def close(self) -> None: ...


SocketFactory = Callable[[tuple[str, int], float], SocketLike]


def _open_socket(address: tuple[str, int], timeout: float) -> SocketLike:
    return socket.create_connection(address, timeout=timeout)


@dataclass(frozen=True, slots=True)
class EngineMetadata:
    name: str
    version: str
    database_version: str
    database_date: str | None = None

    def as_dict(self) -> dict[str, str]:
        return {
            "name": self.name,
            "version": self.version,
            "databaseVersion": self.database_version,
            **({"databaseDate": self.database_date} if self.database_date else {}),
        }


@dataclass(frozen=True, slots=True)
class ScanResult:
    infected: bool
    signature: str | None
    engine: EngineMetadata


_VERSION = re.compile(r"^ClamAV ([A-Za-z0-9][A-Za-z0-9.+_-]{0,63})/([0-9]{1,12})/(.{1,256})$")
_FOUND = re.compile(r"^stream: ([\x20-\x7e]{1,256}) FOUND$")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _database_date(value: str) -> datetime:
    # clamd ctime has no timezone. The deployment contract requires daemon
    # TZ=UTC. Parse English months independently of this process's locale.
    match = re.fullmatch(r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) +([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})", value)
    if not match:
        raise ScannerUnavailable("clamd returned an invalid database date")
    try:
        month = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec").index(match[1]) + 1
        return datetime(int(match[6]), month, int(match[2]), int(match[3]), int(match[4]), int(match[5]), tzinfo=timezone.utc)
    except ValueError as exc:
        raise ScannerUnavailable("clamd returned an invalid database date") from exc


class ClamdScanner:
    """Bounded clamd client with an injectable socket boundary for tests."""

    _MAX_RESPONSE_BYTES = 4096

    def __init__(
        self, config: ScannerConfig, socket_factory: SocketFactory = _open_socket
    ) -> None:
        self._config = config
        self._socket_factory = socket_factory

    def _command(self, command: bytes, payload: bytes | None = None) -> str:
        sock: SocketLike | None = None
        try:
            sock = self._socket_factory(
                (self._config.clamd_host, self._config.clamd_port),
                self._config.connect_timeout_seconds,
            )
            sock.settimeout(self._config.read_timeout_seconds)
            sock.sendall(b"z" + command + b"\0")
            if payload is not None:
                for offset in range(0, len(payload), self._config.chunk_bytes):
                    chunk = payload[offset : offset + self._config.chunk_bytes]
                    sock.sendall(struct.pack("!I", len(chunk)))
                    sock.sendall(chunk)
                sock.sendall(struct.pack("!I", 0))

            response = bytearray()
            while True:
                part = sock.recv(min(1024, self._MAX_RESPONSE_BYTES + 1 - len(response)))
                if not part:
                    raise ScannerUnavailable("clamd closed the connection before completing a reply")
                response.extend(part)
                terminator = response.find(0)
                if terminator >= 0:
                    if terminator != len(response) - 1:
                        raise ScannerUnavailable("clamd returned trailing protocol data")
                    response = response[:terminator]
                    break
                if len(response) > self._MAX_RESPONSE_BYTES:
                    raise ScannerUnavailable("clamd reply exceeded the protocol limit")
            try:
                decoded = bytes(response).decode("ascii")
            except UnicodeDecodeError as exc:
                raise ScannerUnavailable("clamd returned a non-ASCII reply") from exc
            if not decoded or any(not 32 <= ord(character) <= 126 for character in decoded):
                raise ScannerUnavailable("clamd returned a malformed reply")
            return decoded
        except ScannerUnavailable:
            raise
        except (OSError, TimeoutError) as exc:
            raise ScannerUnavailable("clamd is unavailable") from exc
        finally:
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass

    def version(self) -> EngineMetadata:
        match = _VERSION.fullmatch(self._command(b"VERSION"))
        if match is None:
            raise ScannerUnavailable("clamd returned an unrecognized version reply")
        date = _database_date(match.group(3))
        age = (_utcnow() - date).total_seconds()
        if age < -300:
            raise ScannerUnavailable("clamd database is future-dated")
        if age > self._config.max_database_age_hours * 3600:
            raise ScannerDatabaseStale("clamd database exceeded the configured age limit")
        return EngineMetadata(
            name="ClamAV", version=match.group(1), database_version=match.group(2),
            database_date=date.isoformat().replace("+00:00", "Z"),
        )

    def probe(self) -> EngineMetadata:
        if self._command(b"PING") != "PONG":
            raise ScannerUnavailable("clamd did not acknowledge readiness")
        return self.version()

    def scan(self, content: bytes) -> ScanResult:
        if not content or len(content) > self._config.max_file_bytes:
            raise ValueError("content size is outside the configured scan boundary")
        engine = self.version()
        reply = self._command(b"INSTREAM", payload=content)
        if reply == "stream: OK":
            return ScanResult(infected=False, signature=None, engine=engine)
        match = _FOUND.fullmatch(reply)
        if match is not None:
            signature = match.group(1)
            if signature.endswith(" FOUND"):
                raise ScannerUnavailable("clamd returned an ambiguous signature")
            return ScanResult(infected=True, signature=signature, engine=engine)
        raise ScannerUnavailable("clamd did not return a trustworthy scan verdict")
