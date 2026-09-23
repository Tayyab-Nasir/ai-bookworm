"""Authenticated, memory-only malware scanning HTTP service."""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass
import base64
import binascii
import hashlib
import hmac
import json
import re
from typing import Any, Protocol

import anyio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .clamd import ClamdScanner, EngineMetadata, ScanResult, ScannerUnavailable
from .config import ScannerConfig


_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MIME = re.compile(
    r"^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$"
)


class Scanner(Protocol):
    def probe(self) -> EngineMetadata: ...
    def scan(self, content: bytes) -> ScanResult: ...


class JsonScanEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contentBase64: str = Field(min_length=4)
    sha256: str = Field(pattern=r"^[0-9A-Fa-f]{64}$")
    mimeType: str = Field(min_length=3, max_length=129)


@dataclass(frozen=True, slots=True)
class ScanPayload:
    content: bytes
    sha256: str
    mime_type: str


def _error(status: int, code: str, message: str, **headers: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message}},
        headers={"Cache-Control": "no-store", **headers},
    )


def _mime(value: str) -> str:
    normalized = value.strip().lower()
    if not _MIME.fullmatch(normalized):
        raise ValueError("mimeType must be a valid type/subtype without parameters")
    return normalized


def _sha(value: str) -> str:
    normalized = value.strip().lower()
    if not _SHA256.fullmatch(normalized):
        raise ValueError("sha256 must be 64 lowercase hexadecimal characters")
    return normalized


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("JSON fields must be unique")
        value[key] = item
    return value


async def _bounded_body(request: Request, limit: int) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared = int(content_length)
        except ValueError as exc:
            raise ValueError("Content-Length is invalid") from exc
        if declared < 0:
            raise ValueError("Content-Length is invalid")
        if declared > limit:
            raise OverflowError("request body exceeds the configured size limit")

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise OverflowError("request body exceeds the configured size limit")
    return bytes(body)


def _authorized(request: Request, config: ScannerConfig) -> bool:
    authorization = request.headers.get("authorization", "")
    if len(authorization) > 1024 or not authorization.startswith("Bearer "):
        return False
    supplied = authorization[7:]
    return bool(supplied) and hmac.compare_digest(supplied.encode("utf-8"), config.service_token.encode("utf-8"))


async def _payload(request: Request, config: ScannerConfig) -> ScanPayload:
    if request.headers.get("content-encoding") not in (None, "identity"):
        raise TypeError("Content-Encoding is not supported")
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type == "application/octet-stream":
        content = await _bounded_body(request, config.max_file_bytes)
        sha256 = _sha(request.headers.get("x-content-sha256", ""))
        mime_type = _mime(request.headers.get("x-content-mime", ""))
    elif media_type == "application/json":
        encoded_limit = 4 * ((config.max_file_bytes + 2) // 3) + 2048
        raw = await _bounded_body(request, encoded_limit)
        try:
            parsed = json.loads(raw, object_pairs_hook=_unique_object)
            envelope = JsonScanEnvelope.model_validate(parsed)
            encoded = envelope.contentBase64.encode("ascii")
            content = base64.b64decode(encoded, validate=True)
            if base64.b64encode(content) != encoded:
                raise ValueError("contentBase64 is not canonical")
        except (UnicodeEncodeError, UnicodeDecodeError, binascii.Error, json.JSONDecodeError) as exc:
            raise ValueError("contentBase64 must be canonical base64 in a valid JSON object") from exc
        except ValidationError as exc:
            raise ValueError("JSON scan envelope is invalid") from exc
        if len(content) > config.max_file_bytes:
            raise OverflowError("decoded content exceeds the configured size limit")
        sha256 = _sha(envelope.sha256)
        mime_type = _mime(envelope.mimeType)
    else:
        raise TypeError("Content-Type must be application/octet-stream or application/json")

    if not content:
        raise ValueError("content must not be empty")
    actual_sha256 = hashlib.sha256(content).hexdigest()
    if not hmac.compare_digest(actual_sha256, sha256):
        raise ValueError("declared sha256 does not match content")
    return ScanPayload(content=content, sha256=sha256, mime_type=mime_type)


def create_app(
    config: ScannerConfig | None = None, scanner: Scanner | None = None
) -> FastAPI:
    """Build the service; explicit dependencies keep tests deterministic."""

    if scanner is not None and config is None:
        raise ValueError("an injected scanner requires an explicit configuration")

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        active_config = config if config is not None else ScannerConfig.from_env()
        application.state.scanner_config = active_config
        application.state.scanner = scanner if scanner is not None else ClamdScanner(active_config)
        application.state.scan_limiter = anyio.CapacityLimiter(active_config.max_concurrency)
        yield

    application = FastAPI(
        title="bookworm-scanning",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    @application.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(
            {"status": "ok"}, headers={"Cache-Control": "no-store"}
        )

    @application.get("/ready")
    async def ready(request: Request) -> JSONResponse:
        active_scanner: Scanner = request.app.state.scanner
        limiter: anyio.CapacityLimiter = request.app.state.scan_limiter
        try:
            engine = await anyio.to_thread.run_sync(active_scanner.probe, limiter=limiter)
        except (ScannerUnavailable, OSError, TimeoutError):
            return _error(503, "scanner_unavailable", "malware scanner is not ready")
        return JSONResponse(
            {"status": "ready", "engine": engine.as_dict()},
            headers={"Cache-Control": "no-store"},
        )

    @application.post("/v1/scan")
    async def scan(request: Request) -> JSONResponse:
        active_config: ScannerConfig = request.app.state.scanner_config
        if not _authorized(request, active_config):
            return _error(
                401,
                "unauthorized",
                "valid service authentication is required",
                **{"WWW-Authenticate": "Bearer"},
            )
        try:
            scan_payload = await _payload(request, active_config)
        except OverflowError:
            return _error(413, "payload_too_large", "content exceeds the scan size limit")
        except TypeError as exc:
            return _error(415, "unsupported_media_type", str(exc))
        except (ValueError, UnicodeError):
            return _error(422, "invalid_scan_request", "scan input is invalid")

        active_scanner: Scanner = request.app.state.scanner
        limiter: anyio.CapacityLimiter = request.app.state.scan_limiter
        try:
            result = await anyio.to_thread.run_sync(
                lambda: active_scanner.scan(scan_payload.content), limiter=limiter
            )
        except (ScannerUnavailable, OSError, TimeoutError, ValueError):
            return _error(
                503,
                "scanner_unavailable",
                "no trustworthy malware verdict could be obtained",
            )

        verdict = "infected" if result.infected else "clean"
        return JSONResponse(
            {
                "verdict": verdict,
                "clean": not result.infected,
                "infected": result.infected,
                "signature": result.signature,
                "sha256": scan_payload.sha256,
                "mimeType": scan_payload.mime_type,
                "sizeBytes": len(scan_payload.content),
                "engine": result.engine.as_dict(),
            },
            headers={"Cache-Control": "no-store"},
        )

    return application


app = create_app()
