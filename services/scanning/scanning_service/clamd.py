"""Minimal, fail-closed ClamAV clamd TCP client.

Only clamd's NUL-terminated PING, VERSION and INSTREAM commands are used. The
caller supplies bytes already held in memory; this module never opens a file or
executes a process.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
import socket
import struct
from collections.abc import Callable
from typing import Protocol

from .config import ScannerConfig


class ScannerUnavailable(RuntimeError):
    """No trustworthy malware verdict could be obtained."""


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

    def as_dict(self) -> dict[str, str]:
        return {
            "name": self.name,
            "version": self.version,
            "databaseVersion": self.database_version,
        }


@dataclass(frozen=True, slots=True)
class ScanResult:
    infected: bool
    signature: str | None
    engine: EngineMetadata


_VERSION = re.compile(r"^ClamAV ([A-Za-z0-9][A-Za-z0-9.+_-]{0,63})/([0-9]{1,12})/.{1,256}$")
_FOUND = re.compile(r"^stream: ([\x20-\x7e]{1,256}) FOUND$")


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
        return EngineMetadata(
            name="ClamAV", version=match.group(1), database_version=match.group(2)
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
