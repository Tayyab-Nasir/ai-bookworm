"""Validated, environment-only scanner configuration."""

from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import os
import re
from collections.abc import Mapping


class ConfigurationError(ValueError):
    """Raised when scanner configuration is absent or unsafe."""


_DNS_NAME = re.compile(
    r"(?=^.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*"
    r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$"
)


def _integer(env: Mapping[str, str], name: str, default: int, minimum: int, maximum: int) -> int:
    raw = env.get(name, str(default))
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ConfigurationError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return value


def _number(
    env: Mapping[str, str], name: str, default: float, minimum: float, maximum: float
) -> float:
    raw = env.get(name, str(default))
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise ConfigurationError(f"{name} must be a number") from exc
    if not minimum <= value <= maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return value


def _host(value: str) -> str:
    host = value.strip()
    if not host or any(char in host for char in "\r\n\t/@?#"):
        raise ConfigurationError("CLAMD_HOST is not a valid host")
    try:
        ipaddress.ip_address(host)
        return host
    except ValueError:
        if not _DNS_NAME.fullmatch(host):
            raise ConfigurationError("CLAMD_HOST is not a valid IP address or DNS name")
        return host.lower()


@dataclass(frozen=True, slots=True)
class ScannerConfig:
    """Configuration whose network destination cannot be supplied by a request."""

    service_token: str
    clamd_host: str
    clamd_port: int = 3310
    connect_timeout_seconds: float = 2.0
    read_timeout_seconds: float = 15.0
    max_file_bytes: int = 25 * 1024 * 1024
    max_concurrency: int = 4
    chunk_bytes: int = 64 * 1024

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "ScannerConfig":
        values = os.environ if env is None else env
        token = values.get("SCANNING_SERVICE_TOKEN", "")
        if not 32 <= len(token) <= 512 or token != token.strip() or any(
            char in token for char in "\r\n"
        ):
            raise ConfigurationError(
                "SCANNING_SERVICE_TOKEN must be a 32-512 character secret without surrounding whitespace"
            )
        return cls(
            service_token=token,
            clamd_host=_host(values.get("CLAMD_HOST", "clamd")),
            clamd_port=_integer(values, "CLAMD_PORT", 3310, 1, 65535),
            connect_timeout_seconds=_number(
                values, "CLAMD_CONNECT_TIMEOUT_SECONDS", 2.0, 0.05, 30.0
            ),
            read_timeout_seconds=_number(
                values, "CLAMD_READ_TIMEOUT_SECONDS", 15.0, 0.05, 60.0
            ),
            max_file_bytes=_integer(
                values, "SCANNING_MAX_FILE_BYTES", 25 * 1024 * 1024, 1, 100 * 1024 * 1024
            ),
            max_concurrency=_integer(values, "SCANNING_MAX_CONCURRENCY", 4, 1, 32),
            chunk_bytes=_integer(
                values, "SCANNING_CHUNK_BYTES", 64 * 1024, 1024, 1024 * 1024
            ),
        )
